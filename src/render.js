// Composite a furniture item the way the client does: layers a,b,c... placed by registration point,
// ordered by per-direction z-shift, with ink (matte / background-transparent), blend and optional colouring.
// Images are plain { width, height, data: Buffer(RGBA, straight alpha) }.
import sharp from 'sharp';

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
export async function loadPng(file) {
  let p = pngCache.get(file);
  if (p) { pngCache.delete(file); pngCache.set(file, p); return p; }
  p = sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => ({ width: info.width, height: info.height, data }));
  pngCache.set(file, p);
  if (pngCache.size > 2048) pngCache.delete(pngCache.keys().next().value);
  try { return await p; } catch (e) { pngCache.delete(file); throw e; }
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

/** frames: [{img}]; returns { data: Buffer, mime } */
export async function encode(frames, fmt = 'png', fps = 8, scale = 1, bg = null) {
  const imgs = frames.map((f) => finish(f.img, scale, bg));
  const { width, height } = imgs[0];
  const animated = imgs.length > 1 && fmt !== 'png';
  const raw = Buffer.concat(imgs.map((i) => i.data));
  const input = animated
    ? { raw: { width, height: height * imgs.length, channels: 4, pageHeight: height } }
    : { raw: { width, height, channels: 4 } };
  let s = sharp(animated ? raw : imgs[0].data, input);
  const delay = Math.max(20, Math.trunc(1000 / Math.max(1, fps)));
  const delays = Array(imgs.length).fill(delay);
  if (fmt === 'gif') return { data: await s.gif({ delay: delays, loop: 0, effort: 7 }).toBuffer(), mime: 'image/gif' };
  if (fmt === 'webp') return { data: await s.webp({ lossless: true, delay: delays, loop: 0 }).toBuffer(), mime: 'image/webp' };
  return { data: await s.png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png' };
}
