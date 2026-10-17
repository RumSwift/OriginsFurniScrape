import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config } from './config.js';
import * as D from './db.js';
import * as R from './render.js';
import * as store from './store.js';
import * as sync from './sync.js';

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

async function colorsFor(cls, variant, colorsParam) {
  if (colorsParam) {
    try { return R.parseColors(colorsParam); } catch (e) { throw new HttpError(400, e.message); }
  }
  if (variant) {
    const fd = (await store.furnidata())[cls];
    const pc = fd?.partcolors?.color;
    if (Array.isArray(pc)) return pc.map(R.hexToRgb);
  }
  return [];
}

// ---- disk render cache: <key>.<ext> + <key>.json (origin)
async function cached(key, ext, make) {
  const dir = path.join(config.CACHE_DIR, key.slice(0, 2));
  const file = path.join(dir, `${key}.${ext}`);
  try {
    const [data, meta] = [fs.readFileSync(file), JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'))];
    return { data, ...meta };
  } catch { /* miss */ }
  const { data, mime, ox, oy } = await make();
  fs.mkdirSync(dir, { recursive: true });
  const tag = crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(path.join(dir, `${key}.json.${tag}.tmp`), JSON.stringify({ mime, ox, oy }));
  fs.renameSync(path.join(dir, `${key}.json.${tag}.tmp`), path.join(dir, `${key}.json`));
  fs.writeFileSync(`${file}.${tag}.tmp`, data);
  fs.renameSync(`${file}.${tag}.tmp`, file);
  return { data, mime, ox, oy };
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
  sync.hooks.onFinished = () => { store.clearCache(); R.clearCache(); };

  app.get('/healthz', async () => ({
    ok: true, bundles: D.get("SELECT COUNT(*) c FROM bundles WHERE status='ok'").c, sync_running: sync.STATUS.running,
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
    const fdAll = await store.furnidata();
    const fd = fdAll[req.params.cls] ?? fdAll[furni.cls];
    if (fd) info.furnidata = Object.fromEntries(['id', 'name', 'description', 'xdim', 'ydim', 'category', 'partcolors'].map((k) => [k, fd[k] ?? null]));
    info.variant = variant;
    return info;
  });

  app.get('/render/:cls', async (req, reply) => {
    const q = req.query, cls = req.params.cls;
    const direction = int(q, 'direction', 2, 0, 7);
    const state = q.state === undefined ? null : int(q, 'state', null, 0, 9999);
    const frame = int(q, 'frame', 0, 0, 999);
    const size = int(q, 'size', 64, 1, 1000);
    if (size !== 32 && size !== 64) throw new HttpError(400, 'size must be 32 or 64');
    const shadow = bool(q, 'shadow', false), mirror = bool(q, 'mirror', true);
    const matte = oneOf(q, 'matte', 'edge', ['edge', 'exact']);
    const scale = int(q, 'scale', 1, 1, 4), pad = int(q, 'pad', 0, 0, 64), fps = int(q, 'fps', 8, 1, 30);
    const format = oneOf(q, 'format', 'png', ['png', 'gif']);
    const bgParam = strq(q, 'bg', 7);
    const bg = bgParam ? R.hexToRgb(bgParam) : null;
    if (bgParam && !bg) throw new HttpError(400, 'bg must be a 6-digit hex colour');
    const { furni, variant } = lookup(cls);
    const colors = await colorsFor(furni.cls === cls ? cls : cls.split('*')[0], variant, strq(q, 'colors', 200));
    const key = crypto.createHash('sha1').update(JSON.stringify([cls, furni.meta.revision, direction, state, frame, size, colors, shadow, mirror, matte, scale, bg, pad, fps, format])).digest('hex');
    const out = await cached(key, format, async () => {
      let frames;
      if (format === 'png') {
        const r = await R.render(furni, { direction, state, frame, size, colors, shadow, mirror, matte, pad });
        frames = r ? [r] : [];
      } else frames = await R.renderFrames(furni, { direction, state, size, colors, shadow, mirror, matte, pad });
      if (!frames.length) throw new HttpError(404, `no sprite for direction ${direction} at size ${size}`);
      const enc = await R.encode(frames, format, fps, scale, bg);
      return { ...enc, ox: frames[0].ox * scale, oy: frames[0].oy * scale };
    });
    return send(req, reply, out, key, { 'X-Revision': String(furni.meta.revision), 'X-Origin-X': String(out.ox), 'X-Origin-Y': String(out.oy) });
  });

  /** All native directions side by side. */
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
    const shots = (await Promise.all(dirs.map((d) => R.render(furni, { direction: d, state, size, colors, shadow })))).filter(Boolean);
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
    const img = R.prepare(await R.loadPng(`${furni.dir}/${furni.members[name].file}`), { ink: 8 });
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
  app.get('/admin/status', { preHandler: admin }, async () => ({ sync: sync.STATUS, last: JSON.parse(D.kvGet('last_sync', 'null')) }));

  return app;
}