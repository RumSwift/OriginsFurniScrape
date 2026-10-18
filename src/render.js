// Composite a furniture item the way the client does: layers a,b,c... placed by registration point,
// ordered by per-direction z-shift, with ink (matte / background-transparent), blend and optional colouring.
// Images are plain { width, height, data: Buffer(RGBA, straight alpha) }.
import fs from 'node:fs';
import gifenc from 'gifenc';
import pngjs from 'pngjs';
import { paletteColor } from './aliasdb.js';
import { TICKS_PER_SECOND, timeline } from './behavior.js';

const { PNG } = pngjs;
const { GIFEncoder, quantize, applyPalette } = gifenc;

export const SHADOW_ALPHA = 0.2; // the client draws the shadow sprite at 20% blend
/** Bump when output changes, so cached renders are not served stale. */
export const RENDER_VERSION = 6;

// Director ink numbers -> blend operator. 33/34 add, 35/38 subtract, 37 lightest, 39 darkest are standard Director.
// 40 (lighten) and 41 (darken) exist in the client's ink table; the exact formulas are NOT verified (screen / multiply guessed).
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

export function prepare(img, { ink = 8, color = null, blend = 100, matte = 'edge' } = {}) {
  const n = img.width * img.height, src = img.data, out = Buffer.from(src);
  let alpha;
  if (ink === 36) alpha = whiteMask(img).map((v) => (v ? 0 : 255));
  else if (ink === 0) alpha = new Uint8Array(n).fill(255);
  else alpha = matte === 'edge' ? edgeMatte(img) : whiteMask(img).map((v) => (v ? 0 : 255));
  const tint = color && !(color[0] === 255 && color[1] === 255 && color[2] === 255);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (tint) for (let c = 0; c < 3; c++) out[o + c] = Math.round((src[o + c] * color[c]) / 255);
    let a = Math.round((src[o + 3] * alpha[i]) / 255);
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

/**
 * -> [{ img, x, y, mode, layer, member, ... }] relative to the tile origin, in draw order.
 * The array carries `.all` (every layer incl. dropped ones, with flags), `.res` (item-level rotation info) and `.dropped` (layer letters).
 * Layers with no visible pixels are skipped. With outliers='hide' (default) a tiny sprite (<64 visible px) lying >60px away from
 * the rest of the item is dropped: those are scripted-effect anchors / hidden-state markers, not part of the picture.
 */
export async function layout(furni, { direction = 2, variant = null, step = null, frame = 0, size = 64, colors = [], shadow = false, mirror = true, matte = 'edge', inks = 'client', outliers = 'hide' } = {}) {
  const items = [];
  await Promise.all(furni.layers.map(async (layer, li) => {
    const ov = step?.layers?.[layer] ?? null;
    if (ov?.visible === false) return;
    const pick = furni.sprite(layer, direction, ov?.frame ?? frame, size, mirror, variant);
    if (!pick) return;
    const m = furni.member(pick.name);
    const props = furni.layerProps(layer);
    const ink = num(props.ink, 8);
    let im = prepare(await loadPng(m.path), { ink, color: colors[li] ?? null, blend: num(ov?.blend, num(props.blend, 100)), matte });
    const [rx, ry] = m.regPoint;
    let x = -rx;
    if (pick.flipped) { im = flipX(im); x = rx - im.width + (furni.isWall ? 0 : size); } // client: flipped sprites are shifted right by one tile width
    const [sx, sy] = furni.locshift(layer, furni.effDir(direction, size, variant)); // `locshift` from .props
    x += sx;
    const t = tight(im);
    if (!t.vis) return; // nothing to draw
    // client draw order: the layer's zshift for this direction plus its position in the layer list (ties keep layer order)
    items.push({ z: zshift(props, furni.effDir(direction, size, variant)) + (li - 5), li, layer, member: pick.name, ink, img: im, x, y: -ry + sy, vis: t.vis, flipped: pick.flipped,
      box: [x + t.minx, -ry + sy + t.miny, x + t.maxx + 1, -ry + sy + t.maxy + 1], mode: inks === 'client' ? inkMode(ink) : 'normal', outlier: false });
  }));
  const big = items.filter((i) => i.vis >= OUTLIER_MAX_PIXELS);
  if (big.length) {
    const main = [Math.min(...big.map((i) => i.box[0])), Math.min(...big.map((i) => i.box[1])), Math.max(...big.map((i) => i.box[2])), Math.max(...big.map((i) => i.box[3]))];
    for (const i of items) if (i.vis < OUTLIER_MAX_PIXELS && gap(i.box, main) > OUTLIER_MIN_GAP) i.outlier = true;
  }
  const sd = shadow && items.length ? furni.shadowFor(direction, size, mirror) : null;
  if (sd) {
    const m = furni.member(sd.name);
    let im = prepare(await loadPng(m.path), { ink: 8, blend: Math.trunc(SHADOW_ALPHA * 100), matte });
    const [rx, ry] = m.regPoint;
    let x = -rx;
    if (sd.flipped) { im = flipX(im); x = rx - im.width + size; } // same tile-width shift as every flipped sprite
    items.push({ z: -10000, li: -1, layer: 'shadow', member: sd.name, ink: 8, img: im, x, y: -ry, vis: tight(im).vis, box: null, mode: 'normal', outlier: false });
  }
  items.sort((a, b) => a.z - b.z || a.li - b.li);
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
