import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;

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

const png = async (rgba, w = 4, h = 4) => PNG.sync.write({ width: w, height: h, data: Buffer.from(Array.from({ length: w * h }, () => rgba).flat()) });
// image from a per-pixel function (x,y) -> [r,g,b,a]
const pngFn = (w, h, fn) => PNG.sync.write({ width: w, height: h, data: Buffer.from(Array.from({ length: w * h }, (_, i) => fn(i % w, (i / w) | 0)).flat()) });
const decode = (b) => PNG.sync.read(b);

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

// ---------------------------------------------------------------- fixtures
function addBundle(index, name, bitmaps, fields = {}) {
  const man = { bundle: { cast: { key: 'c' }, members: { bitmaps: [], fields: [], palettes: [] } } };
  const assets = {};
  bitmaps.forEach(([bname, buf, regPoint], i) => {
    man.bundle.members.bitmaps.push({ id: i + 1, name: bname, regPoint, width: 4, height: 4 });
    assets[`c/bitmap/${i + 1}/png`] = buf;
  });
  Object.entries(fields).forEach(([fname, text], i) => {
    man.bundle.members.fields.push({ id: i + 1, name: fname });
    assets[`c/text/${i + 1}/text`] = Buffer.from(text);
  });
  const bundle = seal(man, assets);
  const sha = crypto.createHash('sha256').update(bundle).digest('hex');
  const rel = `furniture/${name}/1-${sha.slice(0, 12)}.hcb`;
  fs.mkdirSync(path.join(src, 'furniture', name), { recursive: true });
  fs.writeFileSync(path.join(src, rel), bundle);
  index.bundles[name] = { revision: 1, path: rel, sha256: sha, byteLength: bundle.length };
  index.classes[name] = name; index.classes[`${name}_small`] = name;
}

async function makeFixtures() {
  const index = { format: 'habbo-furniture-content-index', version: 1, classes: { evil: '../../etc' }, bundles: {
      '../bad': { revision: 1, path: 'furniture/x/1-aaaaaaaaaaaa.hcb', sha256: 'a'.repeat(64), byteLength: 1 } } };
  const red = await png([255, 0, 0, 255]), blue = await png([0, 0, 255, 255]), green = await png([0, 255, 0, 255]);
  // tst: layer a red (dir 2), layer b blue in front (dir 2 frames 0,1 and dir 0), animation data, an asymmetric shadow
  const shadow = pngFn(4, 4, (x) => (x === 0 ? [90, 90, 90, 255] : [255, 255, 255, 255]));
  addBundle(index, 'tst', [
    ['tst_a_0_1_1_2_0', red, [4, 8]], ['tst_b_0_1_1_2_0', blue, [2, 6]], ['tst_b_0_1_1_2_1', green, [2, 6]], ['tst_b_0_1_1_0_0', blue, [2, 6]],
    ['tst_sd', shadow, [3, 4]], ['tst_a_0_1_1_0_0', red, [4, 8]],
  ], {
    'tst.props': '[#b: [#zshift: [10, 10, 10]], #a: [#zshift: [0]]]',
    'tst.data': '[#states: [0, 1], #layers: [#b: [[#frames: [0]], [#frames: [0, 1]]]]]',
  });
  // solo: a single native direction (like a plant)
  addBundle(index, 'solo', [['solo_a_0_1_1_0_0', red, [2, 4]], ['solo_sd', shadow, [1, 1]]]);
  // glow: red base + additive glow layer (black = adds nothing) + a tiny far-away marker dot
  const glow = pngFn(12, 12, (x, y) => (x >= 5 && x <= 6 && y >= 5 && y <= 6 ? [100, 100, 0, 255] : [0, 0, 0, 255]));
  const bigRed = pngFn(10, 10, () => [255, 0, 0, 255]);
  const dot = pngFn(1, 1, () => [0, 0, 0, 255]);
  addBundle(index, 'glow', [['glow_a_0_1_1_0_0', bigRed, [5, 10]], ['glow_b_0_1_1_0_0', glow, [6, 11]], ['glow_c_0_1_1_0_0', dot, [-300, 4]]],
      { 'glow.props': '[#a: [#ink: 8], #b: [#ink: 33, #zshift: [5]], #c: [#ink: 36, #zshift: [9]]]' });
  fs.writeFileSync(path.join(src, 'furniture-index.json'), JSON.stringify(index));
}

const flipRows = (d) => { const o = Buffer.from(d.data); for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) d.data.copy(o, (y * d.width + x) * 4, (y * d.width + (d.width - 1 - x)) * 4, (y * d.width + (d.width - 1 - x)) * 4 + 4); return o; };
const px = (d, x, y) => [...d.data.subarray((y * d.width + x) * 4, (y * d.width + x) * 4 + 4)];

test('sync from a local source', async () => {
  await makeFixtures();
  const st = await sync.run();
  assert.equal(st.downloaded, 3); assert.equal(st.failed, 0);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'furni/tst/sprites/tst_a_0_1_1_2_0.png')));
  assert.equal((await sync.run()).skipped, 3); // second run is a no-op
});

test('API: info, layering, colour, animation, validation', async () => {
  const app = await buildApp();
  try {
    const info = (await app.inject('/furni/tst')).json();
    assert.deepEqual(info.layers, ['a', 'b']);
    assert.deepEqual(info.directions, [0, 2]);
    assert.deepEqual(info.states, [0, 1]);
    assert.equal(info.rotations[64][4].kind, 'mirror');
    assert.equal((await app.inject('/furni/new?days=1')).json().count, 3);

    const r = await app.inject('/render/tst?direction=2');
    assert.equal(r.statusCode, 200);
    const d = decode(r.rawPayload);
    // a: x -4..0, y -8..-4 ; b (in front): x -2..2, y -6..-2  -> union 6 wide, 6 tall
    assert.deepEqual([d.width, d.height], [6, 6]);
    assert.deepEqual(px(d, 0, 0), [255, 0, 0, 255]); // only a
    assert.deepEqual(px(d, 3, 3), [0, 0, 255, 255]); // overlap: b is in front
    assert.equal(r.headers['x-origin-x'], '4');
    assert.equal(r.headers['x-direction-used'], '2:native');

    const c = await app.inject('/render/tst?colors=,00ff00');
    assert.deepEqual(px(decode(c.rawPayload), 3, 3), [0, 0, 0, 255]); // blue x green = black

    const gif = await app.inject('/render/tst?state=1&format=gif');
    assert.equal(gif.rawPayload.subarray(0, 6).toString(), 'GIF89a');
    const frames = [...gif.rawPayload.entries()].filter(([i, b]) => b === 0x21 && gif.rawPayload[i + 1] === 0xf9 && gif.rawPayload[i + 2] === 4).length;
    assert.equal(frames, 2);

    for (const [u, code] of [['/render/tst?size=48', 400], ['/render/tst?colors=zz', 400], ['/render/tst?format=webp', 400], ['/render/nope', 404],
      ['/render/..%2F..%2Fetc', 404], ['/admin/status', 404], ['/furni/evil', 404]]) assert.equal((await app.inject(u)).statusCode, code, u);
  } finally { await app.close(); }
});

test('rotations: mirror flips the whole item incl. shadow; single-direction items are never flipped', async () => {
  const app = await buildApp();
  try {
    // dir 4 is the mirror of dir 2: pixel-exact horizontal flip, shadow included
    const d2 = decode((await app.inject('/render/tst?direction=2&shadow=1')).rawPayload);
    const r4 = await app.inject('/render/tst?direction=4&shadow=1');
    const d4 = decode(r4.rawPayload);
    assert.equal(r4.headers['x-direction-used'], '2f:mirror');
    assert.deepEqual([d4.width, d4.height], [d2.width, d2.height]);
    assert.ok(flipRows(d2).equals(d4.data), 'mirrored render must be an exact flip, shadow included');
    // fallback=none refuses a rotation with no sprites; default uses the nearest native direction
    assert.equal((await app.inject('/render/tst?direction=4&mirror=0&fallback=none')).statusCode, 404);
    assert.equal((await app.inject('/render/tst?direction=4&mirror=0')).headers['x-direction-used'], '2:nearest');
    // solo has only direction 0: every rotation shows it, unflipped
    const base = decode((await app.inject('/render/solo?direction=0&shadow=1')).rawPayload);
    for (const dir of [2, 4, 6]) {
      const r = await app.inject(`/render/solo?direction=${dir}&shadow=1`);
      assert.equal(r.headers['x-direction-used'], '0:nearest');
      assert.ok(decode(r.rawPayload).data.equals(base.data), `dir ${dir}`);
    }
  } finally { await app.close(); }
});

test('inks: additive glow adds instead of occluding; stray marker sprites are dropped', async () => {
  const app = await buildApp();
  try {
    // base red 10x10 at x -5..5, y -10..0; glow 12x12 at x -6..6, y -11..1 (black border, 2x2 core at x -1..1, y -6..-4); canvas origin = (6, 11)
    const g = decode((await app.inject('/render/glow?direction=0&bg=000000')).rawPayload);
    const flat = decode((await app.inject('/render/glow?direction=0&bg=000000&inks=flat')).rawPayload);
    const inkVal = (d) => [px(d, 6 - 4, 11 - 9), px(d, 6 - 1, 11 - 6), px(d, 0, 0)];
    const [redEdge, core, uncoveredBorder] = inkVal(g);
    assert.deepEqual(redEdge, [255, 0, 0, 255]);        // black glow border adds nothing over the red base
    assert.deepEqual(core, [255, 100, 0, 255]);          // red + (100,100,0), clamped
    assert.deepEqual(uncoveredBorder, [0, 0, 0, 255]);   // outside the base: adds nothing to black
    assert.deepEqual(inkVal(flat)[0], [0, 0, 0, 255]);   // flat mode: the black border wrongly occludes the base
    // far-away 1px marker: dropped by default (canvas stays small), kept on request
    const r = await app.inject('/render/glow?direction=0');
    assert.equal(r.headers['x-dropped-layers'], 'c');
    assert.ok(decode(r.rawPayload).width < 20);
    const kept = decode((await app.inject('/render/glow?direction=0&outliers=keep')).rawPayload);
    assert.ok(kept.width > 290);
    const layers = (await app.inject('/furni/glow/layers?direction=0')).json().layers;
    assert.equal(layers.find((l) => l.layer === 'c').dropped_as_outlier, true);
    assert.equal(layers.find((l) => l.layer === 'b').mode, 'add');
  } finally { await app.close(); }
});