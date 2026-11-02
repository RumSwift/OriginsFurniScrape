import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config } from './config.js';
import * as D from './db.js';
import * as R from './render.js';
import { TICKS_PER_SECOND, stepAt } from './behavior.js';
import * as store from './store.js';
import * as sync from './sync.js';
import * as gamedata from './gamedata.js';

class HttpError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

// ---- query helpers (strict: bad input is a 400, never silently coerced)
function int(q, name, def, min, max) {
  const v = q[name];
  if (v === undefined || v === '') return def;
  if (!/^-?\d+$/.test(v) || +v < min || +v > max) throw new HttpError(400, `${name} must be an integer ${min}-${max}`);
  return +v;
}
function flt(q, name, def, min, max) {
  const v = q[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number ${min}-${max}`);
  return n;
}
const bool = (q, name, def) => (q[name] === undefined ? def : ['1', 'true', 'yes', 'on'].includes(String(q[name]).toLowerCase()));
const oneOf = (q, name, def, opts) => {
  const v = q[name] ?? def;
  if (!opts.includes(v)) throw new HttpError(400, `${name} must be one of ${opts.join('|')}`);
  return v;
};
const strq = (q, name, max) => {
  const v = q[name] ?? '';
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${name} too long`);
  return v;
};

function lookup(cls) {
  const { furni, variant } = store.get(cls);
  if (!furni) throw new HttpError(404, `unknown furniture class '${cls}'`);
  return { furni, variant };
}

/**
 * Part colours for a render: ?colors= wins; otherwise what the client gets from furnidata - the variant's own entry
 * ('rare_dragonlamp*7'), else the class's entry (plain classes have part colours too). One colour per layer, '#rrggbb' or a
 * palette index.
 */
async function colorsFor(cls, variant, colorsParam) {
  if (colorsParam) {
    try { return R.parseColors(colorsParam); } catch (e) { throw new HttpError(400, e.message); }
  }
  const pc = gamedata.partColors(cls, variant);
  return pc ? pc.map(R.hexToRgb) : [];
}

const hasBundle = (base) => !!store.lookupBundle(base);
/** Part colours as hex ('#rrggbb'), palette indices resolved through the client's default palette; null = no colour. */
const toHex = (list) => (list || []).map((c) => {
  const rgb = R.hexToRgb(c);
  return rgb ? `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}` : null;
});
const variantOut = (r) => ({
  class: r.class, base: r.base, variant: r.variant, kind: r.kind, name: r.name, description: r.description, colors: r.colors, hex: toHex(r.colors),
  sources: r.sources, has_assets: hasBundle(r.base),
  render: hasBundle(r.base) ? `/render/${encodeURIComponent(r.class)}` : null,
});

// ---- disk render cache: <key>.<ext> + <key>.json (origin)
async function cached(key, ext, make) {
  const dir = path.join(config.CACHE_DIR, key.slice(0, 2));
  const file = path.join(dir, `${key}.${ext}`);
  try {
    const [data, meta] = [fs.readFileSync(file), JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'))];
    return { data, ...meta };
  } catch { /* miss */ }
  const { data, mime, ox, oy, used, dropped } = await make();
  fs.mkdirSync(dir, { recursive: true });
  const tag = crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(path.join(dir, `${key}.json.${tag}.tmp`), JSON.stringify({ mime, ox, oy, used, dropped }));
  fs.renameSync(path.join(dir, `${key}.json.${tag}.tmp`), path.join(dir, `${key}.json`));
  fs.writeFileSync(`${file}.${tag}.tmp`, data);
  fs.renameSync(`${file}.${tag}.tmp`, file);
  return { data, mime, ox, oy, used, dropped };
}

function send(req, reply, { data, mime }, key, extra = {}) {
  const etag = `"${key}"`;
  reply.header('Cache-Control', 'public, max-age=3600').header('ETag', etag).headers(extra);
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.type(mime).send(data);
}

export async function buildApp({ logger = false } = {}) {
  for (const d of [config.DATA_DIR, config.FURNI_DIR, config.RAW_DIR, config.CACHE_DIR]) fs.mkdirSync(d, { recursive: true });
  D.db();
  const app = Fastify({ logger, routerOptions: { maxParamLength: 200 } });
  await app.register(cors, { origin: config.CORS_ORIGINS.includes('*') ? true : config.CORS_ORIGINS, methods: ['GET'] });
  await app.register(fastifyStatic, { root: path.resolve(config.FURNI_DIR), prefix: '/assets/', dotfiles: 'deny', index: false }); // /assets/<bundle>/sprites/<name>.png
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ detail: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ detail: err.message });
    req.log.error(err);
    return reply.code(500).send({ detail: 'internal error' });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ detail: 'Not Found' }));
  sync.hooks.onFinished = () => { store.clearCache(); R.clearCache(); gamedata.clearGamedataCache(); };

  const galleryHtml = fs.readFileSync(fileURLToPath(new URL('./gallery.html', import.meta.url)));
  app.get('/gallery', async (req, reply) => reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(galleryHtml));

  app.get('/healthz', async () => ({
    ok: true, render_version: R.RENDER_VERSION, bundles: D.get("SELECT COUNT(*) c FROM bundles WHERE status='ok'").c, sync_running: sync.STATUS.running,
  }));

  app.get('/furni', async (req) => {
    const q = req.query;
    const prefix = strq(q, 'q', 100).replace(/[%\\]/g, '').replace(/_/g, '\\_') + '%';
    const rows = D.all("SELECT class, bundle FROM classes WHERE class LIKE ? ESCAPE '\\' ORDER BY class LIMIT ? OFFSET ?",
      prefix, int(q, 'limit', 100, 1, 1000), int(q, 'offset', 0, 0, 1e9));
    return { count: rows.length, items: rows };
  });

  app.get('/furni/new', async (req) => {
    const days = flt(req.query, 'days', 7, 0.0001, 3650);
    const rows = D.all("SELECT name, revision, first_seen, synced_at FROM bundles WHERE first_seen>=? AND status='ok' ORDER BY first_seen DESC LIMIT ?",
      Date.now() / 1000 - days * 86400, int(req.query, 'limit', 200, 1, 2000));
    const items = rows.map((r) => ({
      ...r,
      classes: D.all("SELECT class FROM classes WHERE bundle=? AND class NOT LIKE 's\\_%' ESCAPE '\\' AND class NOT LIKE '%\\_small' ESCAPE '\\'", r.name).map((c) => c.class),
    }));
    return { since_days: days, count: items.length, items };
  });

  app.get('/furni/:cls', async (req) => {
    const { furni, variant } = lookup(req.params.cls);
    const info = furni.info();
    const e = gamedata.entry(req.params.cls) ?? (variant === null ? null : gamedata.entry(furni.cls));
    info.variant = variant;
    info.name = e?.name ?? null;
    info.description = e?.description ?? null;
    info.colors = gamedata.partColors(furni.cls, variant);
    info.hex = info.colors ? toHex(info.colors) : null;
    if (e?.furnidata) info.furnidata = e.furnidata;
    info.variants = gamedata.variantsOf(furni.cls).filter((r) => r.variant !== null).map(variantOut);
    return info;
  });

  /** Every colour variant of a class with its name, description and part colours. */
  app.get('/furni/:cls/variants', async (req) => {
    const base = store.splitClass(req.params.cls)[0];
    const rows = gamedata.variantsOf(base);
    if (!rows.length && !hasBundle(base)) throw new HttpError(404, `unknown furniture class '${base}'`);
    return { class: base, count: rows.length, variants: rows.map(variantOut) };
  });

  /**
   * Everything the game data knows about: classes and colour variants (also ones whose graphics are not out yet).
   * ?q= substring of class or name, ?only=variants|classes, ?assets=1 only those with graphics, limit/offset.
   */
  app.get('/variants', async (req) => {
    const q = req.query;
    const text = strq(q, 'q', 100).toLowerCase();
    const only = oneOf(q, 'only', 'all', ['all', 'variants', 'classes']);
    const assets = bool(q, 'assets', false);
    const limit = int(q, 'limit', 200, 1, 5000), offset = int(q, 'offset', 0, 0, 1e9);
    let rows = gamedata.allVariants()
      .filter((r) => only === 'all' || (only === 'variants' ? r.variant !== null : r.variant === null))
      .filter((r) => !text || r.class.toLowerCase().includes(text) || (r.name ?? '').toLowerCase().includes(text));
    if (assets) rows = rows.filter((r) => hasBundle(r.base));
    rows.sort((a, b) => a.base.localeCompare(b.base) || (a.variant === null ? -1 : b.variant === null ? 1 : (Number(a.variant) - Number(b.variant)) || String(a.variant).localeCompare(String(b.variant))));
    return { total: rows.length, count: Math.min(limit, Math.max(0, rows.length - offset)), items: rows.slice(offset, offset + limit).map(variantOut), status: gamedata.GAMEDATA_STATUS };
  });

  /** Debug: every layer's member, registration point, ink, visible pixels and whether it was dropped as an outlier. */
  app.get('/furni/:cls/layers', async (req) => {
    const q = req.query, { furni, variant } = lookup(req.params.cls);
    const size = int(q, 'size', 64, 1, 1000);
    const direction = int(q, 'direction', 2, 0, 7), state = q.state === undefined ? null : int(q, 'state', null, 0, 9999);
    const frame = int(q, 'frame', 0, 0, 999);
    const parts = await R.layout(furni, { direction, variant, size, shadow: bool(q, 'shadow', false), ...(state === null ? { frame } : { step: stepAt(furni, state, frame) }), outliers: 'hide' });
    return {
      class: furni.cls, requested_direction: direction, resolved: parts.res,
      fields: Object.fromEntries(Object.keys(furni.meta.fields).map((n) => [n, fs.readFileSync(path.join(furni.dir, furni.meta.fields[n]), 'utf8').slice(0, 4000)])),
      layers: parts.all.map((p) => ({ layer: p.layer, member: p.member, regPoint: furni.member(p.member)?.regPoint, size: [p.img.width, p.img.height],
        offset: [p.x, p.y], visible_pixels: p.vis, box: p.box, ink: p.ink, mode: p.mode, zshift: p.z, dropped_as_outlier: p.outlier })),
    };
  });

  app.get('/render/:cls', async (req, reply) => {
    const q = req.query, cls = req.params.cls;
    const direction = int(q, 'direction', 2, 0, 7);
    const state = q.state === undefined ? null : int(q, 'state', null, 0, 9999);
    const frame = int(q, 'frame', 0, 0, 999);
    const size = int(q, 'size', 64, 1, 1000);
    if (size !== 32 && size !== 64) throw new HttpError(400, 'size must be 32 or 64');
    const shadow = bool(q, 'shadow', false), mirror = bool(q, 'mirror', true);
    const matte = oneOf(q, 'matte', 'edge', ['edge', 'exact', 'baked']);
    const scale = int(q, 'scale', 1, 1, 4), pad = int(q, 'pad', 0, 0, 64), fps = int(q, 'fps', TICKS_PER_SECOND, 1, 60); // ticks per second; the client runs at 15
    const format = oneOf(q, 'format', 'png', ['png', 'gif']);
    const outliers = oneOf(q, 'outliers', 'hide', ['hide', 'keep']);    // hide = drop tiny far-away marker sprites
    const inks = oneOf(q, 'inks', 'client', ['client', 'flat']); // client = additive/subtract/etc. glow layers; flat = treat every layer as plain
    const bgParam = strq(q, 'bg', 7);
    const bg = bgParam && /^#?[0-9a-f]{6}$/i.test(bgParam) ? R.hexToRgb(bgParam) : null;
    if (bgParam && !bg) throw new HttpError(400, 'bg must be a 6-digit hex colour');
    const { furni, variant } = lookup(cls);
    const colors = await colorsFor(furni.cls === cls ? cls : cls.split('*')[0], variant, strq(q, 'colors', 200));
    const key = crypto.createHash('sha1').update(JSON.stringify([R.RENDER_VERSION, cls, furni.meta.revision, direction, state, frame, size, colors, shadow, mirror, matte, inks, outliers, scale, bg, pad, fps, format])).digest('hex');
    const out = await cached(key, format, async () => {
      let frames;
      if (format === 'png') {
        const r = await R.render(furni, { direction, variant, size, ...(state === null ? { frame } : { step: stepAt(furni, state, frame) }), colors, shadow, mirror, matte, inks, outliers, pad, bg });
        frames = r ? [r] : [];
      } else frames = await R.renderFrames(furni, { direction, variant, state, size, colors, shadow, mirror, matte, inks, outliers, pad, bg });
      if (!frames.length) throw new HttpError(404, `no sprite for direction ${direction} at size ${size}`);
      const enc = await R.encode(frames, format, fps, scale, bg); // every frame carries its own tick count; fps = ticks per second
      const f0 = frames[0];
      return { ...enc, ox: f0.ox * scale, oy: f0.oy * scale, used: f0.res ? `${f0.res.dir}${f0.res.flipped ? 'f' : ''}:${f0.res.kind}` : '', dropped: (f0.dropped ?? []).join(',') };
    });
    return send(req, reply, out, key, { 'X-Revision': String(furni.meta.revision), 'X-Origin-X': String(out.ox), 'X-Origin-Y': String(out.oy), 'X-Direction-Used': out.used ?? '', 'X-Dropped-Layers': out.dropped ?? '' });
  });

  /** All native directions side by side. */
  /**
   * Every colour variant of a class on one sheet, coloured like the client: PNG grid (variant order in X-Variants), or
   * ?format=html for a labelled page (variant number, name, colour swatches). ?direction= ?state= ?size= ?scale= ?bg=hex ?cols=
   */
  app.get('/furni/:cls/variants/sheet', async (req, reply) => {
    const q = req.query;
    const base = store.splitClass(req.params.cls)[0];
    const direction = int(q, 'direction', 2, 0, 7), size = int(q, 'size', 64, 1, 1000);
    if (size !== 32 && size !== 64) throw new HttpError(400, 'size must be 32 or 64');
    const state = q.state === undefined ? null : int(q, 'state', null, 0, 9999);
    const scale = int(q, 'scale', 1, 1, 3), cols = int(q, 'cols', 8, 1, 32);
    const format = oneOf(q, 'format', 'png', ['png', 'html']);
    const bgParam = strq(q, 'bg', 6);
    if (bgParam && !/^[0-9a-f]{6}$/i.test(bgParam)) throw new HttpError(400, 'bg must be a 6-digit hex colour');
    const { furni } = lookup(base);
    const rows = gamedata.variantsOf(base).filter((r) => r.variant !== null);
    if (!rows.length) throw new HttpError(404, `no colour variants known for '${base}' (has the game data been synced?)`);
    if (format === 'html') {
      const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const qs = new URLSearchParams({ direction, size, scale: Math.max(2, scale), ...(state === null ? {} : { state }), ...(bgParam ? { bg: bgParam } : {}) });
      const cells = rows.map((r) => {
        const sw = toHex(r.colors).map((h, i) => (h && h !== '#ffffff' ? `<i style="background:${h}" title="${esc(r.colors[i])} = ${h}"></i>` : '')).join('');
        return `<figure><img src="../../../render/${encodeURIComponent(r.class)}?${qs}" alt="${esc(r.class)}" loading="lazy"><figcaption><b>*${esc(r.variant)}</b> ${esc(r.name ?? '')}<br>${sw}</figcaption></figure>`;
      }).join('');
      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>${esc(base)} variants</title>
<style>body{font:13px system-ui;background:#1b1d22;color:#ddd;margin:16px}h1{font-size:16px}main{display:flex;flex-wrap:wrap;gap:10px}
figure{margin:0;background:#262930;border:1px solid #333;border-radius:6px;padding:8px;text-align:center;width:170px}
img{image-rendering:pixelated;max-width:100%}figcaption{margin-top:4px}i{display:inline-block;width:12px;height:12px;margin:2px;border:1px solid #0008}</style>
<h1>${esc(base)} · ${rows.length} colour variants</h1><main>${cells}</main>`);
    }
    const bg = bgParam ? R.hexToRgb(bgParam) : null;
    const shots = [];
    for (const r of rows) {
      const colors = await colorsFor(base, r.variant, '');
      const s = await R.render(furni, { direction, variant: r.variant, size, ...(state === null ? {} : { step: stepAt(furni, state, 0) }), colors, shadow: false, bg: null });
      if (s) shots.push({ r, s });
    }
    if (!shots.length) throw new HttpError(404, 'nothing to render');
    const cw = Math.max(...shots.map((x) => x.s.img.width)) + 8, ch = Math.max(...shots.map((x) => x.s.img.height)) + 8;
    const n = Math.min(cols, shots.length), W = n * cw, H = Math.ceil(shots.length / n) * ch;
    const parts = shots.map((x, i) => ({ img: x.s.img, x: (i % n) * cw + Math.floor((cw - x.s.img.width) / 2), y: Math.floor(i / n) * ch + (ch - 4 - x.s.img.height) }));
    const sheet = R.compose(parts, [0, 0, W, H], 0, bg);
    const { data, mime } = await R.encode([sheet], 'png', 8, scale, bg);
    return reply.header('Cache-Control', 'public, max-age=3600').header('X-Variants', shots.map((x) => x.r.class).join(',')).type(mime).send(data);
  });

  app.get('/render/:cls/sheet', async (req, reply) => {
    const q = req.query;
    const state = q.state === undefined ? null : int(q, 'state', null, 0, 9999);
    const size = int(q, 'size', 64, 1, 1000);
    if (size !== 32 && size !== 64) throw new HttpError(400, 'size must be 32 or 64');
    const scale = int(q, 'scale', 1, 1, 3), shadow = bool(q, 'shadow', false);
    const { furni, variant } = lookup(req.params.cls);
    const colors = await colorsFor(req.params.cls.split('*')[0], variant, strq(q, 'colors', 200));
    let dirs = furni.directions(size).filter((d) => [0, 2, 4, 6].includes(d));
    if (!dirs.length) dirs = furni.directions(size);
    const shots = (await Promise.all(dirs.map((d) => R.render(furni, { direction: d, variant, size, ...(state === null ? {} : { step: stepAt(furni, state, 0) }), colors, shadow, bg: null })))).filter(Boolean);
    if (!shots.length) throw new HttpError(404, 'nothing to render');
    const W = shots.reduce((a, s) => a + s.img.width + 8, 8), H = Math.max(...shots.map((s) => s.img.height)) + 16;
    const parts = []; let x = 8;
    for (const s of shots) { parts.push({ img: s.img, x, y: 8 }); x += s.img.width + 8; }
    const sheet = R.compose(parts, [0, 0, W, H]);
    const { data, mime } = await R.encode([sheet], 'png', 8, scale, null);
    return reply.header('Cache-Control', 'public, max-age=3600').type(mime).send(data);
  });

  app.get('/furni/:cls/icon', async (req, reply) => {
    const { furni } = lookup(req.params.cls);
    const name = furni.icon();
    if (!name) throw new HttpError(404, 'no icon in this bundle');
    const img = R.prepare(await R.loadPng(furni.member(name).path), { ink: 8 });
    const { data, mime } = await R.encode([{ img }], 'png', 8, int(req.query, 'scale', 1, 1, 6), null);
    return reply.header('Cache-Control', 'public, max-age=3600').type(mime).send(data);
  });

  // ---- admin
  const admin = async (req) => {
    if (!config.ADMIN_TOKEN) throw new HttpError(404, 'Not Found');
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim());
    const want = Buffer.from(config.ADMIN_TOKEN);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(401, 'Unauthorized');
  };
  app.post('/admin/sync', { preHandler: admin }, async (req) => {
    if (sync.STATUS.running) return { started: false, reason: 'already running' };
    sync.run({ force: bool(req.query, 'force', false) }).catch((e) => req.log.error(e));
    return { started: true };
  });
  app.post('/admin/reunpack', { preHandler: admin }, async () => sync.reunpackAll());
  app.post('/admin/gamedata', { preHandler: admin }, async () => gamedata.refresh());
  app.get('/admin/status', { preHandler: admin }, async () => ({ sync: sync.STATUS, last: JSON.parse(D.kvGet('last_sync', 'null')) }));

  return app;
}
