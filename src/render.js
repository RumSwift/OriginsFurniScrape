// Composite a furniture item the way the client does: layers a,b,c... placed by registration point,
// ordered by per-direction z-shift, with ink (matte / background-transparent), blend and optional colouring.
// Images are plain { width, height, data: Buffer(RGBA, straight alpha) }.
import fs from 'node:fs';
import gifenc from 'gifenc';
import pngjs from 'pngjs';
import { paletteColor } from './aliasdb.js';
import { TICKS_PER_SECOND, timeline } from './behavior.js';
import { extensionTimeline, solve } from './client.js';

const { PNG } = pngjs;
const { GIFEncoder, quantize, applyPalette } = gifenc;

// Private rooms (where furniture lives) draw every shadow through the shadow manager: one layer at blend 30.
// (Public-room shadow sprites use 20%, or the class's "sd" blend.)
export const SHADOW_ALPHA = 0.3;
/** Bump when output changes, so cached renders are not served stale. */
export const RENDER_VERSION = 10;

// Director ink numbers -> how a sprite combines with what is below it: 33/34 add, 35/38 subtract, 37 lightest, 39 darkest,
// 40 lighten (screen) and 41 darken (multiply: glass-like parts darken what is behind them).
const INK_MODE = { 33: 'add', 34: 'add', 35: 'sub', 38: 'sub', 37: 'lightest', 39: 'darkest', 40: 'screen', 41: 'multiply' };
export const inkMode = (ink) => INK_MODE[ink] ?? 'normal';

/**
 * One part colour as the client reads it: '#rrggbb' / 'rrggbb' / '*rrggbb', or an integer 0-255 = index into the client's default
 * palette (System - Win), like paletteIndex(n). Empty -> null (layer stays uncoloured).
 */
export function colorFrom(v) {
  const p = String(v ?? '').trim().replace(/^[#*]/, '');
  if (!p) return null;
  if (/^\d{1,3}$/.test(p) && Number(p) <= 255) return paletteColor(Number(p));
  if (!/^[0-9a-f]{6}$/i.test(p)) throw new Error(`bad colour '${v}'`);
  return [0, 2, 4].map((i) => parseInt(p.slice(i, i + 2), 16));
}
export const parseColors = (s) => (s || '').split(',').map(colorFrom);
export const hexToRgb = (h) => { try { return colorFrom(h); } catch { return null; } };

// ---------------------------------------------------------------- PNG cache
const pngCache = new Map();
export function clearCache() { pngCache.clear(); }
/** Decode a PNG file to straight-alpha RGBA. Pure JS (no native image library). */
export function decodePng(buf) {
  const p = PNG.sync.read(buf);
  return { width: p.width, height: p.height, data: p.data };
}
export async function loadPng(file) {
  let img = pngCache.get(file);
  if (img) { pngCache.delete(file); pngCache.set(file, img); return img; }
  img = decodePng(fs.readFileSync(file));
  pngCache.set(file, img);
  if (pngCache.size > 2048) pngCache.delete(pngCache.keys().next().value);
  return img;
}

// ---------------------------------------------------------------- ink handling
function whiteMask(img) {
  const n = img.width * img.height, m = new Uint8Array(n), d = img.data;
  for (let i = 0; i < n; i++) m[i] = d[i * 4] === 255 && d[i * 4 + 1] === 255 && d[i * 4 + 2] === 255 ? 1 : 0;
  return m;
}

/** Director "matte" ink: only white connected (4-neighbour) to the sprite border is transparent. Returns alpha. */
function edgeMatte(img) {
  const { width: w, height: h } = img;
  const white = whiteMask(img);
  const outside = new Uint8Array(w * h);
  const stack = [];
  const seed = (x, y) => { const i = y * w + x; if (white[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = outside[i] ? 0 : 255;
  return a;
}

/**
 * Transparency + colour for one sprite (the keying used up to render version 6, which matched the client's look):
 *  ink 36 (background transparent): every exactly-white pixel transparent; ink 0 (copy): opaque;
 *  every other ink (8 matte, 41 darken, 33 add ...): white connected to the sprite's border is transparent, white inside stays.
 * `color` (part colour / bgColor) multiplies the pixels. matte='exact' keys every white pixel for every ink instead.
 * (ink36 / ink8: the client's pre-baked masks, only used with matte='baked'.)
 */
export function prepare(img, { ink = 8, color = null, blend = 100, matte = 'edge', ink36 = null, ink8 = null } = {}) {
  const n = img.width * img.height, src = img.data, out = Buffer.from(src);
  const white = () => whiteMask(img).map((v) => (v ? 0 : 255));
  const baked = (b) => (b && b.width === img.width && b.height === img.height ? Uint8Array.from({ length: n }, (_, i) => b.data[i * 4 + 3]) : null);
  let alpha;
  if (ink === 0) alpha = null;
  else if (matte === 'baked' && ink === 36 && baked(ink36)) alpha = baked(ink36);
  else if (matte === 'baked' && ink === 8 && baked(ink8)) alpha = baked(ink8);
  else if (ink === 36 || matte === 'exact') alpha = white();
  else alpha = edgeMatte(img);
  const tint = color && !(color[0] === 255 && color[1] === 255 && color[2] === 255);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (tint) for (let c = 0; c < 3; c++) out[o + c] = Math.round((src[o + c] * color[c]) / 255);
    let a = ink === 0 ? 255 : alpha ? Math.round((src[o + 3] * alpha[i]) / 255) : src[o + 3];
    if (blend < 100) a = Math.floor((a * blend) / 100);
    out[o + 3] = a;
  }
  return { width: img.width, height: img.height, data: out };
}

function flipX(img) {
  const { width: w, height: h, data: s } = img, out = Buffer.alloc(s.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) s.copy(out, (y * w + (w - 1 - x)) * 4, (y * w + x) * 4, (y * w + x) * 4 + 4);
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------- layout / compose
function zshift(props, dir) {
  const z = props.zshift;
  if (typeof z === 'number') return z;
  if (Array.isArray(z) && z.length) return Number(dir < z.length ? z[dir] : z[0]) || 0; // the client uses entry 1 when the list is shorter than the direction
  return 0;
}
const num = (v, def) => (typeof v === 'number' ? Math.trunc(v) : def);

/** Count of visible pixels and their tight box inside an image: { vis, minx, miny, maxx, maxy }. */
function tight(img) {
  let vis = 0, minx = img.width, miny = img.height, maxx = -1, maxy = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3]) { vis++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  }
  return { vis, minx, miny, maxx, maxy };
}
const OUTLIER_MAX_PIXELS = 64, OUTLIER_MIN_GAP = 60;
const gap = (a, b) => Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3], 0);

async function memberImage(furni, name, { ink, color, blend, matte }) {
  const m = furni.member(name);
  if (!m) return null;
  const baked = async (k) => { try { return await loadPng(m.path.replace(/\.png$/, `.ink${k}.png`)); } catch { return null; } };
  const ink36 = matte === 'baked' && ink === 36 && m.ink36 ? await baked(36) : null;
  const ink8 = matte === 'baked' && ink === 8 && m.ink8File ? await baked(8) : null;
  return { m, img: prepare(await loadPng(m.path), { ink, color, blend, matte, ink36, ink8 }) };
}

/**
 * -> [{ img, x, y, mode, layer, member, ... }] relative to the tile origin, in draw order.
 * The array carries `.all` (every layer incl. dropped ones, with flags), `.res` (item-level rotation info) and `.dropped` (layer letters).
 * Floor items go through the client emulation (client.js); wall items use their two orientations.
 * With outliers='hide' (default) a tiny sprite (<64 visible px) lying >60px away from the rest is dropped: scripted-effect anchors.
 */
export async function layout(furni, { direction = 2, variant = null, step = null, frame = 0, size = 64, colors = [], shadow = false, mirror = true, matte = 'edge', inks = 'client', outliers = 'hide' } = {}) {
  if (furni.isWall) return wallLayout(furni, { direction, variant, step, frame, size, colors, mirror, matte, inks, outliers });
  const items = [];
  if (!step && furni.mode === 'extension' && !frame) step = extensionTimeline(furni.dataModelFor(size), 1, { cls: furni.cls }).steps[0]; // stuffdata "" -> state 1
  const sol = solve(furni, { direction, size, step, frame, exact: !mirror });
  if (!sol) return Object.assign([], { all: [], res: null, dropped: [] });
  const XF = size; // the room geometry's pXFactor: 64 or 32
  const effDir = sol.dir;
  for (const sp of sol.sprites) {
    if (!sp.visible || !sp.name) continue;
    const got = await memberImage(furni, sp.name, { ink: sp.ink, color: sp.color === null ? null : colors[sp.color] ?? null, blend: sp.blend, matte });
    if (!got) continue;
    let { img: im } = got;
    const [rx, ry] = got.m.regPoint;
    // Director: a sprite shows its member with the regPoint on the sprite's loc. Flipped sprites (rotation 180 + skew 180) mirror around
    // that point, and the client moves them one tile (pXFactor) right.
    let x = -rx;
    if (sp.flip) { im = flipX(im); x = rx - im.width + XF; }
    const [sx, sy] = sp.reloc ? furni.locshift(sp.layer, effDir) : [0, 0];
    x += sx;
    const y = -ry + sy;
    const t = tight(im);
    if (!t.vis) continue;
    items.push({ z: sp.z, li: sp.idx, layer: sp.layer, member: sp.name, ink: sp.ink, img: im, x, y, vis: t.vis, flipped: sp.flip,
      box: [x + t.minx, y + t.miny, x + t.maxx + 1, y + t.maxy + 1], mode: inks === 'client' ? inkMode(sp.ink) : 'normal', outlier: false });
  }
  markOutliers(items);
  if (shadow && items.length && sol.shadow) {
    const got = await memberImage(furni, sol.shadow.name, { ink: 8, color: null, blend: Math.round(SHADOW_ALPHA * 100), matte });
    if (got) {
      let { img: im } = got;
      const [rx, ry] = got.m.regPoint;
      let x = -rx;
      if (sol.shadow.flip) { im = flipX(im); x = rx - im.width + XF; }
      items.push({ z: -1e9, li: -1, layer: 'shadow', member: sol.shadow.name, ink: 8, img: im, x, y: -ry, vis: tight(im).vis, box: null, mode: 'normal', outlier: false });
    }
  }
  items.sort(drawOrder);
  const keep = items.filter((i) => !(i.outlier && outliers === 'hide'));
  return Object.assign(keep, { all: items, res: furni.resolveDirection(direction, size, mirror), dropped: items.filter((i) => i.outlier && outliers === 'hide').map((i) => i.layer) });
}

/** Shadows always go to the bottom, whatever the layers' z-shifts are; then z, then layer order. */
const drawOrder = (a, b) => (b.layer === 'shadow') - (a.layer === 'shadow') || a.z - b.z || a.li - b.li;

function markOutliers(items) {
  const big = items.filter((i) => i.vis >= OUTLIER_MAX_PIXELS);
  if (!big.length) return;
  const main = [Math.min(...big.map((i) => i.box[0])), Math.min(...big.map((i) => i.box[1])), Math.max(...big.map((i) => i.box[2])), Math.max(...big.map((i) => i.box[3]))];
  for (const i of items) if (i.vis < OUTLIER_MAX_PIXELS && gap(i.box, main) > OUTLIER_MIN_GAP) i.outlier = true;
}

/** Wall items (Item Object Class): leftwall = direction 2, rightwall = 4; layers in letter order with zshift. */
async function wallLayout(furni, { direction, variant, step, frame, size, colors, mirror, matte, inks, outliers }) {
  const items = [];
  const dm = furni.mode === 'extension' && !variant ? furni.dataModelFor(size) : null;
  if (dm && dm.letters.length) {
    // Item Object Extension Class: "<leftwall|rightwall> <class>_<layer>_<frame>" per data layer (the bare name when the state has
    // no frame list); locZ = zshift + layer number
    if (!step && !frame) step = extensionTimeline(dm, 1, { cls: furni.cls }).steps[0];
    const side = direction >= 4 ? 'rightwall' : 'leftwall';
    const head = `${size === 32 ? 's_' : ''}${side} ${furni.cls}`;
    const props = furni.propsFor(size);
    for (const [i, L] of dm.letters.entries()) {
      const st = step?.layers?.[L];
      const r = furni.resolve(st?.bare ? head : `${head}_${L}_${st?.frame ?? frame}`);
      if (!r) continue;
      const p = props[L] ?? {};
      const ink = num(p.ink, 8);
      const got = await memberImage(furni, r.name, { ink, color: colors[i] ?? null, blend: st?.blend ?? num(p.blend, 100), matte });
      if (!got) continue;
      let { img: im } = got;
      const [rx, ry] = got.m.regPoint;
      let x = -rx;
      if (r.flip) { im = flipX(im); x = rx - im.width; }
      const [sx, sy] = furni.locshift(L, side === 'leftwall' ? 2 : 4);
      x += sx;
      const t = tight(im);
      if (!t.vis) continue;
      items.push({ z: zshift(p, 0) + i + 1, li: i, layer: L, member: r.name, ink, img: im, x, y: -ry + sy, vis: t.vis, flipped: r.flip,
        box: [x + t.minx, -ry + sy + t.miny, x + t.maxx + 1, -ry + sy + t.maxy + 1], mode: inks === 'client' ? inkMode(ink) : 'normal', outlier: false });
    }
    markOutliers(items);
    items.sort(drawOrder);
    const keep = items.filter((i) => !(i.outlier && outliers === 'hide'));
    return Object.assign(keep, { all: items, res: furni.resolveDirection(direction, size, mirror), dropped: items.filter((i) => i.outlier && outliers === 'hide').map((i) => i.layer) });
  }
  await Promise.all(furni.layers.map(async (layer, li) => {
    const ov = step?.layers?.[layer] ?? null;
    if (ov?.visible === false) return;
    const pick = furni.sprite(layer, direction, ov?.frame ?? frame, size, mirror, variant);
    if (!pick) return;
    const props = furni.layerProps(layer);
    const ink = num(props.ink, 8);
    const got = await memberImage(furni, pick.name, { ink, color: colors[li] ?? null, blend: num(ov?.blend, num(props.blend, 100)), matte });
    if (!got) return;
    let { img: im } = got;
    const [rx, ry] = got.m.regPoint;
    let x = -rx;
    if (pick.flipped) { im = flipX(im); x = rx - im.width; }
    const [sx, sy] = furni.locshift(layer, furni.effDir(direction, size, variant));
    x += sx;
    const t = tight(im);
    if (!t.vis) return;
    items.push({ z: zshift(props, furni.effDir(direction, size, variant)) + (li - 5), li, layer, member: pick.name, ink, img: im, x, y: -ry + sy, vis: t.vis, flipped: pick.flipped,
      box: [x + t.minx, -ry + sy + t.miny, x + t.maxx + 1, -ry + sy + t.maxy + 1], mode: inks === 'client' ? inkMode(ink) : 'normal', outlier: false });
  }));
  markOutliers(items);
  items.sort(drawOrder);
  const keep = items.filter((i) => !(i.outlier && outliers === 'hide'));
  return Object.assign(keep, { all: items, res: furni.resolveDirection(direction, size, mirror), dropped: items.filter((i) => i.outlier && outliers === 'hide').map((i) => i.layer) });
}

const bbox = (parts) => parts.length
  ? [Math.min(...parts.map((p) => p.x)), Math.min(...parts.map((p) => p.y)),
    Math.max(...parts.map((p) => p.x + p.img.width)), Math.max(...parts.map((p) => p.y + p.img.height))]
  : null;

const CH = {
  add: (d, s) => Math.min(255, d + s),
  sub: (d, s) => Math.max(0, d - s),
  lightest: (d, s) => Math.max(d, s),
  darkest: (d, s) => Math.min(d, s),
  screen: (d, s) => 255 - ((255 - d) * (255 - s)) / 255,
  multiply: (d, s) => (d * s) / 255,
};

/**
 * Non-normal ink onto the canvas. Where something is already drawn (alpha da) the operator is exact.
 * Where nothing is drawn yet (a glow beyond the furniture) the result is an "emission" pixel: colour
 * normalised to full brightness, alpha = brightness, so that over black it equals the added colour.
 */
function blendInto(out, d, sr, sg, sb, sa, mode) {
  const a = sa / 255, daN = out[d + 3] / 255, op = CH[mode];
  const maxc = Math.max(sr, sg, sb);
  let ue, ur, ug, ub;
  if (mode === 'add' || mode === 'screen') {
    if (!maxc && !daN) return;
    ue = (maxc / 255) * a; ur = (sr * 255) / (maxc || 1); ug = (sg * 255) / (maxc || 1); ub = (sb * 255) / (maxc || 1);
  } else if (mode === 'sub') { ue = (maxc / 255) * a; ur = ug = ub = 0; }
  else { ue = a; ur = sr; ug = sg; ub = sb; }
  ue *= 1 - daN;
  const oa = daN + ue;
  if (oa <= 0) return;
  const src = [sr, sg, sb], dst = [out[d], out[d + 1], out[d + 2]], uc = [ur, ug, ub];
  for (let c = 0; c < 3; c++) {
    const cov = dst[c] + (op(dst[c], src[c]) - dst[c]) * a; // exact operator on what is already there
    out[d + c] = Math.round((cov * daN + uc[c] * ue) / oa);
  }
  out[d + 3] = Math.round(oa * 255);
}

/** Composite parts onto a canvas (transparent, or opaque `bg` so every ink is exact). Returns { img, ox, oy }. */
export function compose(parts, box = null, pad = 0, bg = null) {
  box = box ?? bbox(parts);
  if (!box) return null;
  const x0 = box[0] - pad, y0 = box[1] - pad, W = box[2] + pad - x0, H = box[3] + pad - y0;
  const out = Buffer.alloc(W * H * 4);
  if (bg) for (let i = 0; i < W * H; i++) out.set([bg[0], bg[1], bg[2], 255], i * 4);
  for (const { img, x, y, mode = 'normal' } of parts) {
    for (let sy = 0; sy < img.height; sy++) {
      const dy = sy + y - y0;
      if (dy < 0 || dy >= H) continue;
      for (let sx = 0; sx < img.width; sx++) {
        const dx = sx + x - x0;
        if (dx < 0 || dx >= W) continue;
        const s = (sy * img.width + sx) * 4, d = (dy * W + dx) * 4;
        const sa = img.data[s + 3];
        if (!sa) continue;
        if (mode !== 'normal') { blendInto(out, d, img.data[s], img.data[s + 1], img.data[s + 2], sa, mode); continue; }
        const da = out[d + 3];
        if (sa === 255 || !da) { out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = sa; continue; }
        const dw = (da * (255 - sa)) / 255, oa = sa + dw;
        for (let c = 0; c < 3; c++) out[d + c] = Math.round((img.data[s + c] * sa + out[d + c] * dw) / oa);
        out[d + 3] = Math.round(oa);
      }
    }
  }
  return { img: { width: W, height: H, data: out }, ox: -x0, oy: -y0 };
}

export async function render(furni, { pad = 0, bg = null, ...opts } = {}) {
  const parts = await layout(furni, opts);
  const out = compose(parts, null, pad, bg);
  return out && { ...out, res: parts.res, dropped: parts.dropped };
}

/** Animation of a state: one image per timeline step, all on a shared canvas so nothing jitters. Each frame carries `ticks`. */
export async function renderFrames(furni, { direction = 2, variant = null, state = null, size = 64, colors = [], shadow = false, mirror = true, matte = 'edge', inks = 'client', outliers = 'hide', pad = 0, bg = null, maxFrames = 96 } = {}) {
  const steps = timeline(furni, state).steps.slice(0, maxFrames);
  const sets = [];
  for (const step of steps) sets.push(await layout(furni, { direction, variant, step, size, colors, shadow, mirror, matte, inks, outliers }));
  const box = bbox(sets.flat());
  return box ? sets.map((s, i) => ({ ...compose(s, box, pad, bg), res: s.res, dropped: s.dropped, ticks: steps[i].ticks })) : [];
}

// ---------------------------------------------------------------- output
function finish(img, scale = 1, bg = null) {
  let { width: w, height: h, data } = img;
  if (bg) {
    data = Buffer.from(data);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4, a = data[o + 3];
      for (let c = 0; c < 3; c++) data[o + c] = Math.round((data[o + c] * a + bg[c] * (255 - a)) / 255);
      data[o + 3] = 255;
    }
  }
  if (scale > 1) {
    const out = Buffer.alloc(w * scale * h * scale * 4), W = w * scale;
    for (let y = 0; y < h * scale; y++) for (let x = 0; x < W; x++) data.copy(out, (y * W + x) * 4, (((y / scale) | 0) * w + ((x / scale) | 0)) * 4, (((y / scale) | 0) * w + ((x / scale) | 0)) * 4 + 4);
    return { width: W, height: h * scale, data: out };
  }
  return { width: w, height: h, data };
}

const encodePng = (img) => PNG.sync.write({ width: img.width, height: img.height, data: img.data }, { deflateLevel: 9 });

/** Indexed pixels + palette for one frame: exact palette when it fits (pixel art usually does), else quantised. Index 255 = transparent. */
function indexFrame(img) {
  const { data, width, height } = img, n = width * height;
  const colors = new Map(), index = new Uint8Array(n);
  let exact = true;
  for (let i = 0; i < n && exact; i++) {
    if (data[i * 4 + 3] < 128) { index[i] = 255; continue; }
    const key = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
    let c = colors.get(key);
    if (c === undefined) { c = colors.size; if (c >= 255) { exact = false; break; } colors.set(key, c); }
    index[i] = c;
  }
  const palette = Array.from({ length: 256 }, () => [0, 0, 0]);
  if (exact) {
    for (const [key, c] of colors) palette[c] = [key >> 16, (key >> 8) & 255, key & 255];
  } else {
    const pal = quantize(data, 255, { format: 'rgb565' });
    const idx = applyPalette(data, pal, 'rgb565');
    pal.forEach((p, i) => { palette[i] = p.slice(0, 3); });
    for (let i = 0; i < n; i++) index[i] = data[i * 4 + 3] < 128 ? 255 : idx[i];
  }
  return { index, palette };
}

function encodeGif(imgs, delays) {
  const { width, height } = imgs[0];
  const gif = GIFEncoder();
  imgs.forEach((img, i) => {
    const { index, palette } = indexFrame(img);
    gif.writeFrame(index, width, height, { palette, delay: delays[i], transparent: true, transparentIndex: 255, dispose: 2, repeat: 0 });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** frames: [{img, ticks?}]; returns { data: Buffer, mime }. Formats: png (first frame) | gif (animated, each frame lasts ticks / ticksPerSecond). */
export async function encode(frames, fmt = 'png', ticksPerSecond = TICKS_PER_SECOND, scale = 1, bg = null) {
  const imgs = frames.map((f) => finish(f.img, scale, bg));
  if (fmt === 'gif') return { data: encodeGif(imgs, frames.map((f) => Math.max(20, Math.round(((f.ticks ?? 1) * 1000) / Math.max(1, ticksPerSecond))))), mime: 'image/gif' };
  return { data: encodePng(imgs[0]), mime: 'image/png' };
}
