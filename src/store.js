// Read access to unpacked furniture bundles.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as D from './db.js';
import { LingoError, parse } from './lingo.js';
import { safeFile } from './sync.js';

export const CLS_RE = /^[A-Za-z0-9][A-Za-z0-9_.*\-]{0,127}$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 'table_plasto_square*9' -> ['table_plasto_square', '9'] */
export function splitClass(cls) {
  const i = cls.indexOf('*');
  return i < 0 ? [cls, null] : [cls.slice(0, i), cls.slice(i + 1) || null];
}

export const lookupBundle = (base) =>
  D.get('SELECT c.bundle, b.revision, b.sha256, b.first_seen FROM classes c JOIN bundles b ON b.name=c.bundle WHERE c.class=?', base) ?? null;

const k = (d, f) => `${d}_${f}`;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export class Furni {
  constructor(bundle, cls) {
    this.dir = path.join(config.FURNI_DIR, safeFile(bundle));
    this.meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'meta.json'), 'utf8'));
    this.cls = cls;
    this.members = this.meta.members;
    this.alias = this.#readAlias();
    this.props = this.#readLingo(`${cls}.props`, '.props');
    this.data = this.#readLingo(`${cls}.data`, '.data');
    this.#index();
  }

  #text(name) {
    const f = this.meta.fields[name];
    return f ? fs.readFileSync(path.join(this.dir, f), 'utf8') : null;
  }

  #readLingo(name, suffix) {
    let t = this.#text(name);
    if (t === null) {
      const c = Object.keys(this.meta.fields).filter((n) => n.endsWith(suffix));
      t = c.length === 1 ? this.#text(c[0]) : null;
    }
    if (!t) return {};
    try { const v = parse(t); return isObj(v) ? v : {}; } catch (e) { if (e instanceof LingoError) return {}; throw e; }
  }

  #readAlias() {
    const out = new Map();
    for (const part of (this.#text('memberalias.index') ?? '').split(/[*\r\n]+/)) {
      const i = part.indexOf('=');
      if (i >= 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    return out;
  }

  resolve(name) {
    for (let i = 0; i < 4; i++) {
      if (Object.hasOwn(this.members, name)) return name;
      if (this.alias.has(name)) name = this.alias.get(name);
      else return null;
    }
    return Object.hasOwn(this.members, name) ? name : null;
  }

  // sprites[size][layer] = Map("dir_frame" -> member name)
  #index() {
    const rx = new RegExp(`^(s_)?${esc(this.cls)}_([a-z])_0_(?:(\\d+)_(\\d+)_)?(\\d+)_(\\d+)$`);
    this.sprites = { 64: new Map(), 32: new Map() };
    this.dim = null;
    const names = [...Object.keys(this.members), ...[...this.alias.keys()].filter((n) => !Object.hasOwn(this.members, n))];
    for (const n of names) {
      const m = rx.exec(n);
      if (!m) continue;
      const real = this.resolve(n);
      if (!real) continue;
      const [, s, layer, xd, yd, d, f] = m;
      if (xd) this.dim = [Number(xd), Number(yd)];
      const tbl = this.sprites[s ? 32 : 64];
      if (!tbl.has(layer)) tbl.set(layer, new Map());
      const key = k(Number(d), Number(f));
      if (!tbl.get(layer).has(key)) tbl.get(layer).set(key, real);
    }
    this.layers = [...new Set([...this.sprites[64].keys(), ...this.sprites[32].keys()])].sort();
    this.shadow = { 64: this.resolve(`${this.cls}_sd`), 32: this.resolve(`s_${this.cls}_sd`) };
  }

  icon() {
    for (const n of [`${this.cls}_small`, `${this.cls}_icon`, `${this.cls}_icon_a`]) { const r = this.resolve(n); if (r) return r; }
    return null;
  }

  directions(size = 64) {
    const s = new Set();
    for (const t of this.sprites[size].values()) for (const key of t.keys()) s.add(Number(key.split('_')[0]));
    return [...s].sort((a, b) => a - b);
  }

  /** -> { name, flipped } or null. Fallbacks: exact -> mirrored direction -> frame 0. */
  sprite(layer, direction, frame, size = 64, mirror = true) {
    const t = this.sprites[size].get(layer);
    if (!t) return null;
    for (const fr of frame ? [frame, 0] : [0]) {
      if (t.has(k(direction, fr))) return { name: t.get(k(direction, fr)), flipped: false };
      const md = (((6 - direction) % 8) + 8) % 8;
      if (mirror && md !== direction && t.has(k(md, fr))) return { name: t.get(k(md, fr)), flipped: true };
    }
    return null;
  }

  states() {
    const s = this.data.states;
    return Array.isArray(s) ? s.map(Number) : [];
  }

  /** Frame list for a layer in a state, or null when the data does not describe it. */
  layerFrames(layer, state) {
    const sts = this.states();
    const perLayer = this.data.layers?.[layer];
    if (!sts.length || !Array.isArray(perLayer)) return null;
    const i = sts.indexOf(state);
    if (i < 0 || i >= perLayer.length) return null;
    const fr = isObj(perLayer[i]) ? perLayer[i].frames : null;
    const out = (Array.isArray(fr) ? fr : []).map((x) => (Array.isArray(x) ? (x.length ? Math.trunc(x[0]) : 0) : typeof x === 'number' ? Math.trunc(x) : 0));
    return out.length ? out : null;
  }

  layerProps(layer) {
    const p = this.props[layer];
    return isObj(p) ? p : {};
  }

  info() {
    const frames = {};
    for (const L of this.layers) frames[L] = [...new Set([...(this.sprites[64].get(L)?.keys() ?? [])].map((x) => Number(x.split('_')[1])))].sort((a, b) => a - b);
    return {
      class: this.cls, bundle: this.meta.bundle, revision: this.meta.revision, layers: this.layers,
      directions: this.directions(64), directions_small: this.directions(32), states: this.states(),
      has_shadow: !!this.shadow[64], dimensions: this.dim, has_icon: !!this.icon(), frames,
    };
  }
}

const loaded = new Map(); // LRU of loaded bundles
export function clearCache() { loaded.clear(); }

/** Returns { furni, variant } or { furni: null }. */
export function get(cls) {
  if (!CLS_RE.test(cls)) return { furni: null, variant: null };
  const [base, variant] = splitClass(cls);
  const row = lookupBundle(base);
  if (!row) return { furni: null, variant: null };
  const key = `${row.bundle}|${base}|${row.revision}`;
  let f = loaded.get(key);
  if (f) { loaded.delete(key); loaded.set(key, f); }
  else {
    try { f = new Furni(row.bundle, base); } catch { return { furni: null, variant: null }; }
    loaded.set(key, f);
    if (loaded.size > 256) loaded.delete(loaded.keys().next().value);
  }
  return { furni: f, variant };
}

// ---------------------------------------------------------------- optional furnidata (names, colours)
const fd = { t: 0, d: {} };
export async function furnidata() {
  if (!config.FURNIDATA_URL) return {};
  if (Date.now() - fd.t < 86400_000 && Object.keys(fd.d).length) return fd.d;
  const cache = path.join(config.DATA_DIR, 'furnidata.json');
  try {
    let raw;
    if (/^https?:/.test(config.FURNIDATA_URL)) {
      const stale = !fs.existsSync(cache) || Date.now() - fs.statSync(cache).mtimeMs > 86400_000;
      if (stale) {
        const r = await fetch(config.FURNIDATA_URL, { headers: { 'User-Agent': config.SYNC_USER_AGENT }, signal: AbortSignal.timeout(60_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        fs.writeFileSync(cache, Buffer.from(await r.arrayBuffer()));
      }
      raw = fs.readFileSync(cache);
    } else raw = fs.readFileSync(config.FURNIDATA_URL);
    const j = JSON.parse(raw.toString('utf8'));
    const d = {};
    for (const key of ['roomitemtypes', 'wallitemtypes']) for (const x of j[key]?.furnitype ?? []) d[x.classname] = x;
    fd.d = d;
  } catch { /* keep whatever we had */ }
  fd.t = Date.now();
  return fd.d;
}
