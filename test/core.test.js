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
// client data (flip table + behaviour classes) for the fixtures below
const cdata = path.join(tmp, 'clientdata');
fs.mkdirSync(cdata, { recursive: true });
fs.writeFileSync(path.join(cdata, 'furniture-aliases.json'), JSON.stringify({
  flp_a_0_1_1_4_0: ['flp_a_0_1_1_2_0', 1], flp_a_0_1_1_6_0: ['flp_a_0_1_1_0_0', 1], flp_a_0_1_1_3_0: ['flp_a_0_1_1_2_0', 0],
  'leftwall wal_a_0': ['rightwall wal_a_0', 1], 'wal.props': ['shr.props', 0],
}));
fs.writeFileSync(path.join(cdata, 'classmap.json'), JSON.stringify({
  bar: ['Active Object Class', 'Furniture Barrier Class'], dlp: ['Active Object Class', 'Furniture DragonLamp Class'], gat: ['Active Object Class', 'Furniture Divider Class'],
}));
process.env.CLIENT_DATA_DIR = cdata;
fs.writeFileSync(path.join(cdata, 'systemwin.json'), JSON.stringify({ colors: Array.from({ length: 256 }, (_, i) => (i === 6 ? [255, 0, 0] : [i, 0, 0])) }));
fs.writeFileSync(path.join(tmp, 'furnidata.json'), JSON.stringify({ roomitemtypes: { furnitype: [{ classname: 'tst*2', partcolors: { color: ['', '#00ff00'] } }, { classname: 'tst*3', partcolors: { color: ['', '6'] } }] } }));
process.env.FURNIDATA_URL = path.join(tmp, 'furnidata.json');
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
  // gate: no `.data` at all; layer b has frames 0 (closed, blue) and 1 (open, green) -> states inferred from frames
  addBundle(index, 'gate', [['gate_a_0_1_1_0_0', red, [2, 4]], ['gate_b_0_1_1_0_0', blue, [2, 4]], ['gate_b_0_1_1_0_1', green, [2, 4]]]);
  // anim: real-format `.data` with delay:3 on a 2-frame loop
  addBundle(index, 'anim', [['anim_a_0_1_1_0_0', red, [2, 4]], ['anim_a_0_1_1_0_1', blue, [2, 4]]],
    { 'anim.data': '[states:[1], layers:[ a:[ [ frames:[0, 1], loop:0, delay:3 ] ]]]' });
  // flp: asymmetric sprites; directions 4 and 6 exist only as flipped aliases in the client's table, 3 as an unflipped alias
  const asym = pngFn(4, 4, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const asym0 = pngFn(4, 4, (x) => (x === 3 ? [0, 255, 0, 255] : [0, 0, 255, 255]));
  addBundle(index, 'flp', [['flp_a_0_1_1_2_0', asym, [1, 4]], ['flp_a_0_1_1_0_0', asym0, [1, 4]]]);
  // bar: barrier script. layer e (sprite 5) is the blinking glow
  addBundle(index, 'bar', ['a', 'b', 'c', 'd', 'e'].map((L, i) => [`bar_${L}_0_1_1_0_0`, null, [2 - (L === 'e' ? 8 : 0), 4]]).map(([n, , r]) => [n, red, r]));
  // dlp: dragon lamp. layer f has frames 0..4, c/e/g frames 0..1
  const dl = [];
  for (const L of ['a', 'c', 'e', 'g']) for (const f of L === 'a' ? [0] : [0, 1]) dl.push([`dlp_${L}_0_1_1_0_${f}`, f ? green : red, [2, 4]]);
  for (let f = 0; f <= 4; f++) dl.push([`dlp_f_0_1_1_0_${f}`, [red, blue, green, red, blue][f], [2, 4]]);
  addBundle(index, 'dlp', dl);
  // gat: divider/gate. frame 0 = closed, 1 = open
  addBundle(index, 'gat', [['gat_a_0_1_1_0_0', red, [2, 4]], ['gat_a_0_1_1_0_1', blue, [2, 4]]]);
  // wal: wall furniture. rightwall is a real sprite, leftwall a flipped alias; its .props lives in another bundle (shr) behind the alias table
  addBundle(index, 'wal', [['rightwall wal_a_0', asym, [2, 4]]]);
  addBundle(index, 'shr', [], { 'shr.props': '[a: [ink: 33, locshift: [point(0,0), point(0,0), point(0,0), point(0,0), point(5,0)]]]' });
  fs.writeFileSync(path.join(src, 'furniture-index.json'), JSON.stringify(index));
}

const flipRows = (d) => { const o = Buffer.from(d.data); for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) d.data.copy(o, (y * d.width + x) * 4, (y * d.width + (d.width - 1 - x)) * 4, (y * d.width + (d.width - 1 - x)) * 4 + 4); return o; };
const px = (d, x, y) => [...d.data.subarray((y * d.width + x) * 4, (y * d.width + x) * 4 + 4)];

test('sync from a local source', async () => {
  await makeFixtures();
  const st = await sync.run();
  assert.equal(st.downloaded, 11); assert.equal(st.failed, 0);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'furni/tst/sprites/tst_a_0_1_1_2_0.png')));
  assert.equal((await sync.run()).skipped, 11); // second run is a no-op
});

test('API: info, layering, colour, animation, validation', async () => {
  const app = await buildApp();
  try {
    const info = (await app.inject('/furni/tst')).json();
    assert.deepEqual(info.layers, ['a', 'b']);
    assert.deepEqual(info.directions, [0, 2]);
    assert.deepEqual(info.states, [0, 1]);
    assert.equal(info.rotations[64][4].kind, 'mirror');
    assert.equal((await app.inject('/furni/new?days=1')).json().count, 11);

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

test('rotations: 6 mirrors 0 and 4 mirrors 2 (whole item incl. shadow); single-sprite items always show their one sprite', async () => {
  const app = await buildApp();
  try {
    const d2 = decode((await app.inject('/render/tst?direction=2&shadow=1')).rawPayload);
    const r4 = await app.inject('/render/tst?direction=4&shadow=1');
    const d4 = decode(r4.rawPayload);
    assert.equal(r4.headers['x-direction-used'], '2f:mirror');
    assert.deepEqual([d4.width, d4.height], [d2.width, d2.height]);
    assert.ok(flipRows(d2).equals(d4.data), 'mirrored render must be an exact flip, shadow included');
    assert.equal((await app.inject('/render/tst?direction=6')).headers['x-direction-used'], '0f:mirror');
    // no partner sprite and mirroring off -> nothing to draw
    assert.equal((await app.inject('/render/tst?direction=4&mirror=0')).statusCode, 404);
    // solo has a single sprite (dir 0): every rotation shows exactly that, unflipped
    const base = decode((await app.inject('/render/solo?direction=0&shadow=1')).rawPayload);
    for (const dir of [2, 4, 6]) {
      const r = await app.inject(`/render/solo?direction=${dir}&shadow=1`);
      assert.equal(r.headers['x-direction-used'], '0:single', `dir ${dir}`);
      assert.ok(decode(r.rawPayload).data.equals(base.data), `dir ${dir} pixels`);
    }
  } finally { await app.close(); }
});

test('states: inferred from sprite frames when there is no .data; .data delay sets the GIF speed', async () => {
  const app = await buildApp();
  try {
    const info = (await app.inject('/furni/gate')).json();
    assert.deepEqual(info.states, [0, 1]); assert.equal(info.states_inferred, true);
    const closed = decode((await app.inject('/render/gate?state=0')).rawPayload), open = decode((await app.inject('/render/gate?state=1')).rawPayload);
    assert.deepEqual(px(closed, 2, 2), [0, 0, 255, 255]); // frame 0 of layer b
    assert.deepEqual(px(open, 2, 2), [0, 255, 0, 255]);   // frame 1 of layer b
    assert.equal((await app.inject('/furni/tst')).json().states_inferred, false);
    const delays = (buf) => [...buf.entries()].filter(([i, b]) => b === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 4).map(([i]) => buf[i + 4] | (buf[i + 5] << 8));
    const slow = delays((await app.inject('/render/anim?state=1&format=gif')).rawPayload), fast = delays((await app.inject('/render/tst?state=1&format=gif')).rawPayload);
    assert.equal(slow.length, 2);
    assert.ok(Math.abs(slow[0] - 3 * fast[0]) <= 3, `delay:3 should be ~3x slower (${slow[0]} vs ${fast[0]})`);
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

const gifDelays = (buf) => [...buf.entries()].filter(([i, b]) => b === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 4).map(([i]) => buf[i + 4] | (buf[i + 5] << 8));

test('client flip table: 4 and 6 are flipped aliases, other aliases stay unflipped', async () => {
  const app = await buildApp();
  try {
    const d2 = decode((await app.inject('/render/flp?direction=2')).rawPayload), d0 = decode((await app.inject('/render/flp?direction=0')).rawPayload);
    const r4 = await app.inject('/render/flp?direction=4');
    assert.equal(r4.headers['x-direction-used'], '4f:alias');
    assert.ok(decode(r4.rawPayload).data.equals(flipRows(d2)), 'dir 4 = flipped dir 2');
    assert.ok(decode((await app.inject('/render/flp?direction=6')).rawPayload).data.equals(flipRows(d0)), 'dir 6 = flipped dir 0');
    const r3 = await app.inject('/render/flp?direction=3');
    assert.equal(r3.headers['x-direction-used'], '3:native');
    assert.ok(decode(r3.rawPayload).data.equals(d2.data), 'unflipped alias');
    assert.deepEqual((await app.inject('/furni/flp')).json().rotations[64][4], { dir: 4, flipped: true, kind: 'alias' });
  } finally { await app.close(); }
});

test('behaviours: barrier blinks (20 on / 26 off), gate open/closed, dragon lamp cycles', async () => {
  const app = await buildApp();
  try {
    const bar = (await app.inject('/furni/bar')).json();
    assert.equal(bar.behavior, 'barrier');
    assert.deepEqual(bar.state_details.map((s) => [s.id, s.label, s.animated]), [[0, 'off', false], [1, 'on (blinking)', true]]);
    const off = decode((await app.inject('/render/bar?state=0')).rawPayload), on = decode((await app.inject('/render/bar?state=1')).rawPayload);
    assert.ok(on.width > off.width, 'glow layer e only shows while on');
    const g = (await app.inject('/render/bar?state=1&format=gif')).rawPayload, d = gifDelays(g);
    assert.equal(d.length, 2);
    assert.ok(Math.abs(d[1] / d[0] - 26 / 20) < 0.1, `26 ticks off vs 20 on (${d})`);
    assert.deepEqual((await app.inject('/furni/gat')).json().state_details.map((s) => s.label), ['closed', 'open']);
    const closed = decode((await app.inject('/render/gat?state=0')).rawPayload), open = decode((await app.inject('/render/gat?state=1')).rawPayload);
    assert.deepEqual(px(closed, 1, 1), [255, 0, 0, 255]); assert.deepEqual(px(open, 1, 1), [0, 0, 255, 255]);
    const dl = (await app.inject('/render/dlp?state=1&format=gif')).rawPayload;
    assert.equal(gifDelays(dl).length, 4);
    assert.equal(gifDelays((await app.inject('/render/dlp?state=0&format=gif')).rawPayload).length, 1);
  } finally { await app.close(); }
});

test('shadow is drawn at 20%', async () => {
  const app = await buildApp();
  try {
    const sh = decode((await app.inject('/render/solo?direction=0&shadow=1')).rawPayload);
    const shadowPx = [].concat(...Array.from({ length: sh.height }, (_, y) => Array.from({ length: sh.width }, (_, x) => px(sh, x, y)))).filter((p) => p[3] > 0 && p[3] < 255);
    assert.ok(shadowPx.length && shadowPx.every((p) => p[3] === 51), JSON.stringify(shadowPx[0]));
  } finally { await app.close(); }
});

test('wall furniture: leftwall/rightwall names, flipped alias, props bridged from another bundle', async () => {
  const app = await buildApp();
  try {
    const info = (await app.inject('/furni/wal')).json();
    assert.equal(info.wall, true);
    assert.deepEqual(info.layers, ['a']);
    assert.deepEqual(Object.keys(info.rotations[64]), ['2', '4']);
    assert.equal(info.layer_props.a.ink, 33, 'ink from shr.props via the alias table');
    const right = await app.inject('/render/wal?direction=4'), left = await app.inject('/render/wal?direction=2');
    assert.equal(right.statusCode, 200);
    assert.equal(left.headers['x-direction-used'], '2f:alias');
    assert.ok(decode(left.rawPayload).data.equals(flipRows(decode(right.rawPayload))), 'leftwall is the flipped rightwall');
    const lay = (await app.inject('/furni/wal/layers?direction=4')).json().layers[0];
    assert.equal(lay.offset[0], -2 + 5, 'locshift for direction 4 applied');
  } finally { await app.close(); }
});

test('colours: variant entries in furnidata, hex or palette index', async () => {
  const app = await buildApp();
  try {
    const col = async (u) => decode((await app.inject(u)).rawPayload);
    assert.deepEqual(px(await col('/render/tst*2'), 3, 3), [0, 0, 0, 255]);        // layer b blue x #00ff00 (variant entry tst*2)
    assert.deepEqual(px(await col('/render/tst?colors=,6'), 3, 3), [0, 0, 0, 255]); // palette index 6 = (255,0,0): blue x red
    assert.deepEqual(px(await col('/render/tst*3'), 3, 3), [0, 0, 0, 255]);        // furnidata may carry palette indices too
    assert.equal((await app.inject('/render/tst?colors=,999')).statusCode, 400);
  } finally { await app.close(); }
});
