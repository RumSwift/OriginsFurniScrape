// Composite a furniture item the way the client does: layers a,b,c... placed by registration point,
// ordered by per-direction z-shift, with ink (matte / background-transparent), blend and optional colouring.
// Images are plain { width, height, data: Buffer(RGBA, straight alpha) }.
import fs from 'node:fs';
import gifenc from 'gifenc';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const { GIFEncoder, quantize, applyPalette } = gifenc;

export const SHADOW_ALPHA = 0.3;

export function parseColors(s) {
  return (s || '').split(',').map((p) => {
    p = p.trim().replace(/^#/, '');
    if (!p) return null;
    if (!/^[0-9a-f]{6}$/i.test(p)) throw new Error(`bad colour '${p}'`);
    return [0, 2, 4].map((i) => parseInt(p.slice(i, i + 2), 16));
  });
}
export const hexToRgb = (h) => (/^#?[0-9a-f]{6}$/i.test(h) ? parseColors(h)[0] : null);

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
  if (Array.isArray(z) && z.length) return dir < z.length ? Number(z[dir]) || 0 : z.length === 1 ? Number(z[0]) || 0 : 0;
  return 0;
}
const num = (v, def) => (typeof v === 'number' ? Math.trunc(v) : def);

/** -> [{ img, x, y }] relative to the tile origin, in draw order. */
export async function layout(furni, { direction = 2, state = null, frame = 0, size = 64, colors = [], shadow = false, mirror = true, matte = 'edge' } = {}) {
  const items = [];
  if (shadow && furni.shadow[size]) {
    const m = furni.members[furni.shadow[size]];
    const im = prepare(await loadPng(`${furni.dir}/${m.file}`), { ink: 8, blend: Math.trunc(SHADOW_ALPHA * 100), matte });
    items.push({ z: -10000, li: -1, img: im, x: -m.regPoint[0], y: -m.regPoint[1] });
  }
  await Promise.all(furni.layers.map(async (layer, li) => {
    let fr = frame;
    if (state !== null) {
      const lf = furni.layerFrames(layer, state);
      if (lf) fr = lf[frame % lf.length];
    }
    const pick = furni.sprite(layer, direction, fr, size, mirror);
    if (!pick) return;
    const m = furni.members[pick.name];
    const props = furni.layerProps(layer);
    let im = prepare(await loadPng(`${furni.dir}/${m.file}`), { ink: num(props.ink, 8), color: colors[li] ?? null, blend: num(props.blend, 100), matte });
    const [rx, ry] = m.regPoint;
    let x = -rx;
    if (pick.flipped) { im = flipX(im); x = rx - im.width; }
    items.push({ z: zshift(props, direction), li, img: im, x, y: -ry });
  }));
  items.sort((a, b) => a.z - b.z || a.li - b.li);
  return items.map(({ img, x, y }) => ({ img, x, y }));
}

const bbox = (parts) => parts.length
    ? [Math.min(...parts.map((p) => p.x)), Math.min(...parts.map((p) => p.y)),
      Math.max(...parts.map((p) => p.x + p.img.width)), Math.max(...parts.map((p) => p.y + p.img.height))]
    : null;

/** Alpha-composite parts onto a transparent canvas. Returns { img, ox, oy } (ox/oy = tile origin inside img). */
export function compose(parts, box = null, pad = 0) {
  box = box ?? bbox(parts);
  if (!box) return null;
  const x0 = box[0] - pad, y0 = box[1] - pad, W = box[2] + pad - x0, H = box[3] + pad - y0;
  const out = Buffer.alloc(W * H * 4);
  for (const { img, x, y } of parts) {
    for (let sy = 0; sy < img.height; sy++) {
      const dy = sy + y - y0;
      if (dy < 0 || dy >= H) continue;
      for (let sx = 0; sx < img.width; sx++) {
        const dx = sx + x - x0;
        if (dx < 0 || dx >= W) continue;
        const s = (sy * img.width + sx) * 4, d = (dy * W + dx) * 4;
        const sa = img.data[s + 3];
        if (!sa) continue;
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

export async function render(furni, { pad = 0, ...opts } = {}) {
  return compose(await layout(furni, opts), null, pad);
}

/** Animation: one image per step, all on a shared canvas so nothing jitters. */
export async function renderFrames(furni, { direction = 2, state = null, size = 64, colors = [], shadow = false, mirror = true, matte = 'edge', pad = 0, maxFrames = 64 } = {}) {
  let n = 1;
  if (state !== null) for (const L of furni.layers) { const lf = furni.layerFrames(L, state); if (lf) n = Math.max(n, lf.length); }
  n = Math.min(n, maxFrames);
  const sets = [];
  for (let i = 0; i < n; i++) sets.push(await layout(furni, { direction, state, frame: i, size, colors, shadow, mirror, matte }));
  const box = bbox(sets.flat());
  return box ? sets.map((s) => compose(s, box, pad)) : [];
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

function encodeGif(imgs, delay) {
  const { width, height } = imgs[0];
  const gif = GIFEncoder();
  imgs.forEach((img, i) => {
    const { index, palette } = indexFrame(img);
    gif.writeFrame(index, width, height, { palette, delay, transparent: true, transparentIndex: 255, dispose: 2, repeat: 0 });
    void i;
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** frames: [{img}]; returns { data: Buffer, mime }. Formats: png (first frame) | gif (animated). */
export async function encode(frames, fmt = 'png', fps = 8, scale = 1, bg = null) {
  const imgs = frames.map((f) => finish(f.img, scale, bg));
  if (fmt === 'gif') return { data: encodeGif(imgs, Math.max(20, Math.trunc(1000 / Math.max(1, fps)))), mime: 'image/gif' };
  return { data: encodePng(imgs[0]), mime: 'image/png' };
}