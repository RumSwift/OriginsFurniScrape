import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'furni-'));
const src = path.join(tmp, 'src');
Object.assign(process.env, {
  DATA_DIR: path.join(tmp, 'data'), FURNI_BASE_URL: `file://${src}`, FURNI_INDEX_URL: `file://${src}/furniture-index.json`,
  SYNC_DELAY: '0', SYNC_ON_START: 'false', SYNC_INTERVAL_HOURS: '0',
});
const { seal, parseBundle, BundleError } = await import('../src/hcb.js');
const { parse, LingoError } = await import('../src/lingo.js');
const sync = await import('../src/sync.js');
const { buildApp } = await import('../src/app.js');

const png = (rgba, w = 4, h = 4) => sharp(Buffer.from(Array.from({ length: w * h }, () => rgba).flat()), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

test('bundle roundtrip and rejection', () => {
  const key = Buffer.from('k');
  const { assets } = parseBundle(seal({}, { 'c/bitmap/1/png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]) }, key), key);
  assert.equal(assets.get('c/bitmap/1/png').length, 9);
  assert.throws(() => parseBundle(Buffer.from('nope'.repeat(10))), BundleError);
  assert.throws(() => parseBundle(seal({}, { 'c/bitmap/1/png': Buffer.from('notapng!') }, key), Buffer.from('other')), BundleError);
});

test('lingo', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parse('[#a: 1, #b: "x", #c: [1,2], #d: [:]] -- c'))), { a: 1, b: 'x', c: [1, 2], d: {} });
  assert.throws(() => parse('['.repeat(500)), LingoError);
});

// synthetic item: layer a (opaque red, dir 2 only, regPoint 4,8), layer b (blue, dir 2 and 0, in front via zshift) + animation data
async function makeFixture() {
  const man = {
    bundle: { cast: { key: 'c' }, members: {
      bitmaps: [
        { id: 1, name: 'tst_a_0_1_1_2_0', regPoint: [4, 8], width: 4, height: 4 },
        { id: 2, name: 'tst_b_0_1_1_2_0', regPoint: [2, 6], width: 4, height: 4 },
        { id: 3, name: 'tst_b_0_1_1_2_1', regPoint: [2, 6], width: 4, height: 4 },
        { id: 4, name: 'tst_b_0_1_1_0_0', regPoint: [2, 6], width: 4, height: 4 },
      ],
      fields: [{ id: 1, name: 'tst.props' }, { id: 2, name: 'tst.data' }], palettes: [] } },
  };
  const red = await png([255, 0, 0, 255]), blue = await png([0, 0, 255, 255]), green = await png([0, 255, 0, 255]);
  const bundle = seal(man, {
    'c/bitmap/1/png': red, 'c/bitmap/2/png': blue, 'c/bitmap/3/png': green, 'c/bitmap/4/png': blue,
    'c/text/1/text': Buffer.from('[#b: [#zshift: [10, 10, 10]], #a: [#zshift: [0]]]'),
    'c/text/2/text': Buffer.from('[#states: [0, 1], #layers: [#b: [[#frames: [0]], [#frames: [0, 1]]]]]'),
  });
  const sha = crypto.createHash('sha256').update(bundle).digest('hex');
  const rel = `furniture/tst/1-${sha.slice(0, 12)}.hcb`;
  fs.mkdirSync(path.join(src, 'furniture/tst'), { recursive: true });
  fs.writeFileSync(path.join(src, rel), bundle);
  fs.writeFileSync(path.join(src, 'furniture-index.json'), JSON.stringify({
    format: 'habbo-furniture-content-index', version: 1,
    classes: { tst: 'tst', tst_small: 'tst', evil: '../../etc' },
    bundles: { tst: { revision: 1, path: rel, sha256: sha, byteLength: bundle.length }, '../bad': { revision: 1, path: rel, sha256: sha, byteLength: 1 } },
  }));
}

test('sync from a local source, then the API', async () => {
  await makeFixture();
  const st = await sync.run();
  assert.equal(st.downloaded, 1); assert.equal(st.failed, 0);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'furni/tst/sprites/tst_a_0_1_1_2_0.png')));
  assert.equal((await sync.run()).skipped, 1); // second run is a no-op

  const app = await buildApp();
  try {
    const info = (await app.inject('/furni/tst')).json();
    assert.deepEqual(info.layers, ['a', 'b']);
    assert.deepEqual(info.directions, [0, 2]);
    assert.deepEqual(info.states, [0, 1]);
    assert.equal((await app.inject('/furni/new?days=1')).json().count, 1);

    const r = await app.inject('/render/tst?direction=2');
    assert.equal(r.statusCode, 200);
    const { data, info: im } = await sharp(r.rawPayload).raw().toBuffer({ resolveWithObject: true });
    // a: x -4..0, y -8..-4 ; b (in front): x -2..2, y -6..-2  -> union 6 wide, 6 tall
    assert.deepEqual([im.width, im.height], [6, 6]);
    const px = (x, y) => [...data.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 4)];
    assert.deepEqual(px(0, 0), [255, 0, 0, 255]); // only a
    assert.deepEqual(px(3, 3), [0, 0, 255, 255]); // overlap: b is in front
    assert.equal(r.headers['x-origin-x'], '4');

    // direction 4 has nothing native -> mirrored from direction 2 (6-4=2); disabled with mirror=0
    assert.equal((await app.inject('/render/tst?direction=4')).statusCode, 200);
    assert.equal((await app.inject('/render/tst?direction=4&mirror=0')).statusCode, 404);
    // colour multiply on layer b only
    const c = await app.inject('/render/tst?colors=,00ff00');
    const cd = await sharp(c.rawPayload).raw().toBuffer();
    assert.deepEqual([...cd.subarray((3 * 6 + 3) * 4, (3 * 6 + 3) * 4 + 4)], [0, 0, 0, 255]); // blue x green = black
    // animated state 1 has 2 frames
    const gif = await app.inject('/render/tst?state=1&format=gif');
    assert.equal(gif.headers['content-type'], 'image/gif');
    assert.equal((await sharp(gif.rawPayload, { animated: true }).metadata()).pages, 2);
    // validation
    assert.equal((await app.inject('/render/tst?size=48')).statusCode, 400);
    assert.equal((await app.inject('/render/tst?colors=zz')).statusCode, 400);
    assert.equal((await app.inject('/render/nope')).statusCode, 404);
    assert.equal((await app.inject('/render/..%2F..%2Fetc')).statusCode, 404);
    assert.equal((await app.inject('/admin/status')).statusCode, 404); // no token configured
    assert.equal((await app.inject('/furni/evil')).statusCode, 404); // malformed index entry ignored
  } finally { await app.close(); }
});
