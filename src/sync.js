// Index -> download -> verify -> decrypt -> unpack.
// Politeness: conditional request for the index, low concurrency, a delay between requests,
// honours Retry-After / 429, aborts after repeated failures instead of hammering the server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { config, indexUrl } from './config.js';
import * as D from './db.js';
import { BundleError, parseBundle } from './hcb.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/;
const PATH_RE = /^furniture\/[A-Za-z0-9][A-Za-z0-9_.\-]*\/\d+-[0-9a-f]{12}\.hcb$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (lvl, ...a) => console[lvl === 'error' ? 'error' : 'log'](new Date().toISOString(), lvl.toUpperCase(), 'sync', ...a);

export const STATUS = { running: false, last_started: null, last_finished: null, last_error: null, downloaded: 0, skipped: 0, failed: 0, total: 0 };
export const hooks = { onFinished: () => {} }; // the web app clears its caches here

export class Abort extends Error {}

export function safeFile(name) {
  const s = String(name).replace(/[^A-Za-z0-9_.\-]/g, '_').replace(/^\.+/, '') || '_';
  return s.slice(0, 120);
}

const isRemote = (u) => /^https?:\/\//.test(u);
const localPath = (u) => (u.startsWith('file://') ? fileURLToPath(u) : u);

/** GET with backoff. Returns { status, body, etag }. 304 -> empty body. */
async function httpGet(url, etag = null, retries = 4) {
  let delay = 2000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r;
    try {
      r = await fetch(url, {
        headers: { 'User-Agent': config.SYNC_USER_AGENT, ...(etag ? { 'If-None-Match': etag } : {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (attempt === retries) throw new Abort(`network error for ${url}: ${e.message}`);
      await sleep(delay); delay *= 2;
      continue;
    }
    if (r.status === 304) return { status: 304, body: Buffer.alloc(0), etag };
    if (r.status === 200) {
      const cl = Number(r.headers.get('content-length') || 0);
      if (cl > config.SYNC_MAX_BUNDLE_BYTES * 2) throw new Abort(`response too large for ${url}`);
      return { status: 200, body: Buffer.from(await r.arrayBuffer()), etag: r.headers.get('etag') };
    }
    if ([429, 503].includes(r.status) && attempt < retries) {
      const ra = r.headers.get('retry-after') || '';
      const wait = Math.min(/^\d+$/.test(ra) ? Number(ra) * 1000 : delay, 120_000);
      log('warn', `HTTP ${r.status} from server, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait); delay *= 2;
      continue;
    }
    if ([401, 403].includes(r.status)) throw new Abort(`HTTP ${r.status} for ${url} - access refused, stopping (check with the content owner)`);
    throw new Abort(`HTTP ${r.status} for ${url}`);
  }
  throw new Abort(`giving up on ${url}`);
}

async function loadIndex(force) {
  const src = indexUrl();
  if (!isRemote(src)) return { idx: JSON.parse(fs.readFileSync(localPath(src), 'utf8')), etag: null, unchanged: false };
  const etag = force ? null : D.kvGet('index_etag');
  const r = await httpGet(src, etag);
  if (r.status === 304) return { idx: null, etag, unchanged: true };
  try { return { idx: JSON.parse(r.body.toString('utf8')), etag: r.etag, unchanged: false }; }
  catch { throw new Abort('index is not valid JSON'); }
}

export function validateIndex(idx) {
  if (!idx || idx.format !== 'habbo-furniture-content-index' || idx.version !== 1) throw new Abort('unexpected index format/version');
  const { bundles, classes } = idx;
  if (!bundles || typeof bundles !== 'object' || !classes || typeof classes !== 'object' || !Object.keys(bundles).length)
    throw new Abort('index has no bundles/classes');
  const good = {};
  for (const [name, b] of Object.entries(bundles)) {
    const bl = Number(b?.byteLength);
    const ok = NAME_RE.test(name) && !name.includes('..') && PATH_RE.test(b?.path ?? '') && !b.path.includes('..') &&
      SHA_RE.test(b?.sha256 ?? '') && bl > 0 && bl <= config.SYNC_MAX_BUNDLE_BYTES;
    if (ok) good[name] = { revision: Number(b.revision ?? 0) | 0, path: b.path, sha256: b.sha256, byteLength: bl };
    else log('warn', `skipping malformed index entry ${JSON.stringify(name)}`);
  }
  const cls = {};
  for (const [c, b] of Object.entries(classes)) if (typeof b === 'string' && good[b] && c.length <= 200) cls[c] = b;
  return { bundles: good, classes: cls };
}

// ---------------------------------------------------------------- unpacking
let tmpCounter = 0;
export async function unpack(data, bundle, info, destRoot) {
  const { manifest: man, assets } = parseBundle(data, config.ASSET_KEY);
  const members = man.bundle?.members ?? {};
  const castKey = man.bundle?.cast?.key;
  const tmp = path.join(destRoot, `.tmp-${safeFile(bundle)}-${process.pid}-${tmpCounter++}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'sprites'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'text'));
  if (config.KEEP_IDX) fs.mkdirSync(path.join(tmp, 'idx'));
  const meta = {
    bundle, revision: info.revision, sha256: info.sha256, members: {}, fields: {},
    palettes: Object.fromEntries((members.palettes ?? []).map((p) => [p.name, (p.colors ?? []).length])),
  };
  const findAsset = (suffix) => { for (const [k, v] of assets) if (k.endsWith(suffix)) return v; return null; };
  const used = new Set();
  const uniq = (name) => { let fn = safeFile(name); while (used.has(fn.toLowerCase())) fn += '_'; used.add(fn.toLowerCase()); return fn; };
  try {
    for (const bm of members.bitmaps ?? []) {
      const name = String(bm.name), bid = bm.id;
      const png = assets.get(`${castKey}/bitmap/${bid}/png`) ?? findAsset(`/bitmap/${bid}/png`);
      if (!png) continue;
      await sharp(png).metadata(); // throws on a corrupt PNG
      const fn = uniq(name);
      fs.writeFileSync(path.join(tmp, 'sprites', `${fn}.png`), png);
      if (config.KEEP_IDX) {
        const idx = findAsset(`/bitmap/${bid}/idx`);
        if (idx) fs.writeFileSync(path.join(tmp, 'idx', `${fn}.idx`), idx);
      }
      const rp = bm.regPoint ?? [0, 0];
      meta.members[name] = { file: `sprites/${fn}.png`, regPoint: [Math.trunc(rp[0]), Math.trunc(rp[1])],
        width: Math.trunc(bm.width ?? 0), height: Math.trunc(bm.height ?? 0), palette: bm.paletteName ?? null };
    }
    for (const fm of members.fields ?? []) {
      const name = String(fm.name);
      const raw = findAsset(`/text/${fm.id}/text`);
      if (!raw) continue;
      const fn = uniq(name);
      fs.writeFileSync(path.join(tmp, 'text', `${fn}.txt`), raw);
      meta.fields[name] = `text/${fn}.txt`;
    }
    fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(meta, null, 1));
    const final = path.join(destRoot, safeFile(bundle));
    const old = `${final}.old`;
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(final)) fs.renameSync(final, old);
    fs.renameSync(tmp, final);
    fs.rmSync(old, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function processBundle(name, info, base) {
  await sleep(config.SYNC_DELAY * 1000);
  const url = new URL(info.path, base.endsWith('/') ? base : base + '/').href;
  const data = isRemote(url) ? (await httpGet(url)).body : fs.readFileSync(localPath(url));
  if (data.length !== info.byteLength || crypto.createHash('sha256').update(data).digest('hex') !== info.sha256)
    throw new BundleError('size/sha256 mismatch against index');
  if (config.KEEP_RAW) {
    const raw = path.join(config.RAW_DIR, safeFile(name));
    fs.mkdirSync(raw, { recursive: true });
    const keep = path.basename(info.path);
    fs.writeFileSync(path.join(raw, keep), data);
    for (const f of fs.readdirSync(raw)) if (f !== keep) fs.rmSync(path.join(raw, f), { force: true });
  }
  await unpack(data, name, info, config.FURNI_DIR);
}

// ---------------------------------------------------------------- run
let running = false;
export async function run({ only = null, force = false } = {}) {
  if (running) return { error: 'sync already running' };
  running = true;
  for (const d of [config.DATA_DIR, config.FURNI_DIR, config.RAW_DIR, config.CACHE_DIR]) fs.mkdirSync(d, { recursive: true });
  Object.assign(STATUS, { running: true, last_started: Date.now() / 1000, last_error: null, downloaded: 0, skipped: 0, failed: 0, total: 0 });
  try {
    const { idx, etag, unchanged } = await loadIndex(force);
    if (unchanged && !only) { log('info', 'index unchanged (304)'); return STATUS; }
    const { bundles, classes } = validateIndex(idx);
    const have = new Map(D.all('SELECT * FROM bundles').map((r) => [r.name, r]));
    const todo = [];
    for (const [name, info] of Object.entries(bundles)) {
      if (only && !only.has(name)) continue;
      const h = have.get(name);
      const same = h && h.revision === info.revision && h.sha256 === info.sha256 && h.status === 'ok' &&
        fs.existsSync(path.join(config.FURNI_DIR, safeFile(name), 'meta.json'));
      if (force || !same) todo.push([name, info]);
    }
    STATUS.total = todo.length;
    STATUS.skipped = Object.keys(bundles).length - todo.length;
    const base = config.FURNI_BASE_URL;
    const now = Date.now() / 1000;
    let fails = 0;
    const queue = todo.slice();
    const fail = (msg) => { fails++; STATUS.failed++; STATUS.last_error = msg; log('error', msg); };
    const worker = async () => {
      for (let item; (item = queue.shift()); ) {
        if (fails >= config.SYNC_MAX_FAILURES) return;
        const [name, info] = item;
        try {
          await processBundle(name, info, base);
          D.run(`INSERT INTO bundles(name,revision,sha256,byte_length,path,first_seen,synced_at,status)
                 VALUES(?,?,?,?,?,?,?,'ok') ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,
                 sha256=excluded.sha256, byte_length=excluded.byte_length, path=excluded.path,
                 synced_at=excluded.synced_at, status='ok'`,
          name, info.revision, info.sha256, info.byteLength, info.path, now, Date.now() / 1000);
          fails = 0;
          STATUS.downloaded++;
        } catch (e) {
          fail(`${name}: ${e.message}`);
          if (e instanceof Abort && e.message.includes('access refused')) fails = config.SYNC_MAX_FAILURES;
        }
      }
    };
    await Promise.all(Array.from({ length: config.SYNC_CONCURRENCY }, worker));
    if (fails >= config.SYNC_MAX_FAILURES) STATUS.last_error = (STATUS.last_error ?? '') + ' (aborted after repeated failures)';
    // every class whose bundle is unpacked becomes available, even after a partial run
    D.tx(() => {
      const okb = new Set(D.all("SELECT name FROM bundles WHERE status='ok'").map((r) => r.name));
      D.run('DELETE FROM classes');
      const ins = D.db().prepare('INSERT INTO classes(class,bundle) VALUES(?,?)');
      for (const [c, b] of Object.entries(classes)) if (okb.has(b)) ins.run(c, b);
    });
    if (etag && !only && STATUS.failed === 0) D.kvSet('index_etag', etag);
    const { downloaded, skipped, failed, total } = STATUS;
    D.kvSet('last_sync', JSON.stringify({ downloaded, skipped, failed, total, at: Date.now() / 1000 }));
    return STATUS;
  } catch (e) {
    if (!(e instanceof Abort)) STATUS.last_error = String(e?.message ?? e);
    else STATUS.last_error = e.message;
    log('error', 'sync aborted:', STATUS.last_error);
    return STATUS;
  } finally {
    Object.assign(STATUS, { running: false, last_finished: Date.now() / 1000 });
    running = false;
    hooks.onFinished();
  }
}

export function startScheduler() {
  let stopped = false, timer = null;
  const loop = async () => {
    await run().catch((e) => log('error', e));
    if (!stopped && config.SYNC_INTERVAL_HOURS > 0) timer = setTimeout(loop, config.SYNC_INTERVAL_HOURS * 3600_000);
  };
  if (config.SYNC_ON_START) setImmediate(loop);
  else if (config.SYNC_INTERVAL_HOURS > 0) timer = setTimeout(loop, config.SYNC_INTERVAL_HOURS * 3600_000);
  return () => { stopped = true; clearTimeout(timer); };
}
