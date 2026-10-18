// Read access to unpacked furniture bundles.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as D from './db.js';
import { LingoError, parse } from './lingo.js';
import { safeFile } from './sync.js';
import { aliasNamesFor, aliasOf, classChain, parseWallName, wallNamesFor } from './aliasdb.js';
import { TICKS_PER_SECOND, behaviorOf, behaviorStates, timeline } from './behavior.js';

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

// ---- other bundles: the client's alias table can point at a member (or a .props/.data field) that lives in a different bundle
const metaCache = new Map();
function bundleMeta(bundle) {
  const key = String(bundle);
  if (!metaCache.has(key)) {
    let v = null;
    try { const dir = path.join(config.FURNI_DIR, safeFile(bundle)); v = { dir, meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) }; } catch { /* missing */ }
    if (metaCache.size > 64) metaCache.delete(metaCache.keys().next().value);
    metaCache.set(key, v);
  }
  return metaCache.get(key);
}
/** Class a member / field name belongs to, e.g. 's_fall_tile_a_0_1_1_2_0' -> 'fall_tile', 'leftwall flag_x_a_0' -> 'flag_x', 'flag_country.data' -> 'flag_country'. */
function classOfName(name) {
  const w = parseWallName(name);
  if (w) return w.cls;
  let m = /^(?:s_)?(.+?)_(?:[a-z]|sd)_0_(?:\d+_\d+_)?\d+_\d+$/.exec(name) ?? /^(?:s_)?(.+?)_sd(?:_\d+)?$/.exec(name);
  if (m) return m[1];
  m = /^(?:s_)?(.+)\.(?:data|props)$/.exec(name);
  return m ? m[1] : null;
}
function foreign(name, field = false) {
  const cls = classOfName(name);
  if (!cls) return null;
  const row = lookupBundle(cls);
  const b = row && bundleMeta(row.bundle);
  if (!b) return null;
  const hit = field ? b.meta.fields?.[name] : b.meta.members?.[name];
  return hit ? { dir: b.dir, hit } : null;
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export class Furni {
  constructor(bundle, cls) {
    this.dir = path.join(config.FURNI_DIR, safeFile(bundle));
    this.meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'meta.json'), 'utf8'));
    this.cls = cls;
    this.members = this.meta.members;
    this.alias = this.#readAlias();
    this.ext = new Map(); // member name -> { dir, m } for sprites that live in another bundle
    this.props = this.#readLingo(`${cls}.props`, '.props');
    this.data = this.#readLingo(`${cls}.data`, '.data');
    this.chain = classChain(cls);
    this.behavior = behaviorOf(cls);
    this.#index();
    const lc = this.meta.lighting?.classes ?? {};
    this.lighting = lc[cls] ?? lc[Object.keys(lc).find((k) => k.toLowerCase() === cls.toLowerCase())] ?? null;
  }

  #text(name) {
    const f = this.meta.fields[name];
    return f ? fs.readFileSync(path.join(this.dir, f), 'utf8') : null;
  }

  /** Field text: this bundle, else through the client's alias table (flag_algeria.props -> flag_country.props), possibly in another bundle. */
  #fieldText(name) {
    let t = this.#text(name);
    for (let i = 0; t === null && i < 4; i++) {
      const g = aliasOf(name);
      if (!g) break;
      name = g[0];
      t = this.#text(name);
      if (t === null) { const f = foreign(name, true); if (f) t = fs.readFileSync(path.join(f.dir, f.hit), 'utf8'); }
    }
    return t;
  }

  #readLingo(name, suffix) {
    let t = this.#fieldText(name);
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

  /**
   * Follows aliases to a real bundle member: -> { name, flip } or null. The client's global alias table (data/furniture-aliases.json)
   * carries the horizontal flip (flip=1: mirrored copy of the target); the bundle's own memberalias.index is a plain rename.
   */
  resolve(name) {
    let flip = false;
    for (let i = 0; i < 8; i++) {
      if (Object.hasOwn(this.members, name) || this.ext.has(name)) return { name, flip };
      const g = aliasOf(name);
      if (g) { name = g[0]; if (g[1]) flip = !flip; } else if (this.alias.has(name)) name = this.alias.get(name);
      else return null;
      if (!Object.hasOwn(this.members, name) && !this.ext.has(name)) { const f = foreign(name); if (f) this.ext.set(name, { dir: f.dir, m: f.hit }); }
    }
    return Object.hasOwn(this.members, name) || this.ext.has(name) ? { name, flip } : null;
  }

  /** { regPoint, file, path } of a member of this bundle or of the bundle an alias led to. */
  member(name) {
    const m = this.members[name];
    if (m) return { ...m, path: path.join(this.dir, m.file) };
    const e = this.ext.get(name);
    return e ? { ...e.m, path: path.join(e.dir, e.m.file) } : null;
  }

  // sprites[size][layer] = Map("dir_frame" -> { name, flip }). Wall furniture: dir 2 = leftwall, 4 = rightwall (the client's own numbering);
  // vsprites = the same structure per variant ("poster 1002" -> variant "1002").
  #index() {
    const rx = new RegExp(`^(s_)?${esc(this.cls)}_([a-z])_0_(?:(\\d+)_(\\d+)_)?(\\d+)_(\\d+)$`);
    const fresh = () => ({ 64: new Map(), 32: new Map() });
    const put = (tbls, size, layer, key, real) => {
      const t = tbls[size];
      if (!t.has(layer)) t.set(layer, new Map());
      if (!t.get(layer).has(key)) t.get(layer).set(key, real); // real = { name, flip }
    };
    this.sprites = fresh();
    this.vsprites = new Map();
    this.dim = null;
    this.isWall = false;
    const names = [...new Set([...Object.keys(this.members), ...this.alias.keys(), ...aliasNamesFor(this.cls), ...wallNamesFor(this.cls)])];
    for (const n of names) {
      const w = parseWallName(n);
      if (w) {
        if (w.cls !== this.cls) continue;
        const real = this.resolve(n);
        if (!real) continue;
        this.isWall = true;
        let tbls = this.sprites;
        if (w.variant) { if (!this.vsprites.has(w.variant)) this.vsprites.set(w.variant, fresh()); tbls = this.vsprites.get(w.variant); }
        put(tbls, w.size, w.layer, k(w.side === 'leftwall' ? 2 : 4, w.frame), real);
        continue;
      }
      const m = rx.exec(n);
      if (!m) continue;
      const real = this.resolve(n);
      if (!real) continue;
      const [, s, layer, xd, yd, d, f] = m;
      if (xd) this.dim = [Number(xd), Number(yd)];
      put(this.sprites, s ? 32 : 64, layer, k(Number(d), Number(f)), real);
    }
    if (this.isWall && ![64, 32].some((z) => this.sprites[z].size) && this.vsprites.size) this.sprites = this.vsprites.values().next().value; // variant-only classes (posters)
    this.layers = [...new Set([...this.sprites[64].keys(), ...this.sprites[32].keys()])].sort();
    this.wallVariants = [...this.vsprites.keys()];
  }

  /** Wall furniture only has two orientations: 2 = leftwall, 4 = rightwall; any direction is mapped to the nearer one (0-3 left, 4-7 right). */
  effDir(direction) { return this.isWall ? (direction >= 4 ? 4 : 2) : direction; }

  #tbls(variant) { return variant && this.vsprites.has(variant) ? this.vsprites.get(variant) : this.sprites; }

  /** Point offset the client adds to a layer's sprite for a direction (`locshift` in .props): [dx, dy]. */
  locshift(layer, direction) {
    const l = this.layerProps(layer).locshift;
    if (!Array.isArray(l) || l.length <= direction) return [0, 0];
    let v = l[direction];
    if (typeof v === 'string') { const m = /^\s*point\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\s*$/.exec(v); v = m ? { x: Number(m[1]), y: Number(m[2]) } : null; }
    return v && typeof v.x === 'number' && typeof v.y === 'number' ? [v.x, v.y] : [0, 0];
  }

  /** Shadow sprite for a direction: tries the per-direction names first, then the single `_sd`. -> { name, flipped } or null */
  shadowFor(direction, size = 64, mirror = true) {
    if (this.isWall) return null; // wall items have no floor shadow
    const pre = size === 32 ? `s_${this.cls}` : this.cls;
    const dirs = [direction];
    if (mirror) dirs.push((((6 - direction) % 8) + 8) % 8);
    for (const [i, d] of dirs.entries()) {
      const cands = [`${pre}_sd_${d}`, `${pre}_sd_0_${d}_0`, ...(this.dim ? [`${pre}_sd_0_${this.dim[0]}_${this.dim[1]}_${d}_0`] : [])];
      if (d === 0 || i === 0) cands.push(`${pre}_sd`);
      for (const c of cands) { const r = this.resolve(c); if (r) return { name: r.name, flipped: r.flip !== (i === 1) }; }
    }
    return null;
  }

  get hasShadow() { return !!(this.shadowFor(0, 64) || this.shadowFor(2, 64) || this.shadowFor(0, 32) || this.shadowFor(2, 32)); }

  icon() {
    for (const n of [`${this.cls}_small`, `${this.cls}_icon`, `${this.cls}_icon_a`]) { const r = this.resolve(n); if (r) return r.name; }
    return null;
  }

  directions(size = 64) {
    const s = new Set();
    for (const t of this.sprites[size].values()) for (const key of t.keys()) s.add(Number(key.split('_')[0]));
    return [...s].sort((a, b) => a - b);
  }

  #entry(layer, dir, frame, size) { return this.sprites[size].get(layer)?.get(k(dir, frame)) ?? null; }

  /**
   * Item-level description of what a rotation shows, as { dir, flipped, kind } or null when there is no sprite:
   *  single - the item has only one rotation: every rotation shows it, never flipped
   *  native - the bundle has a real sprite for exactly this direction
   *  alias  - the client's alias table maps this direction to another one (flipped when flip=1: 6 <- 0, 4 <- 2)
   *  mirror - no entry at all: the pair partner ((6-d)%8) flipped horizontally (fallback)
   */
  resolveDirection(direction, size = 64, mirror = true) {
    direction = this.effDir(direction);
    const dirs = this.directions(size);
    if (!dirs.length) return null;
    if (dirs.length === 1 && !this.isWall) return { dir: dirs[0], flipped: false, kind: 'single' };
    if (dirs.includes(direction)) {
      const e = this.layers.map((L) => this.#entry(L, direction, 0, size)).find(Boolean) ?? null;
      return { dir: direction, flipped: !!e?.flip, kind: e?.flip ? 'alias' : 'native' };
    }
    const md = (((6 - direction) % 8) + 8) % 8;
    if (mirror && md !== direction && dirs.includes(md)) return { dir: md, flipped: true, kind: 'mirror' };
    return null;
  }

  /** -> { name, flipped } or null. Fallbacks: exact (incl. alias flips) -> mirrored direction -> frame 0. Single-rotation items ignore the rotation. */
  sprite(layer, direction, frame, size = 64, mirror = true, variant = null) {
    const t = this.#tbls(variant)[size].get(layer);
    if (!t) return null;
    direction = this.effDir(direction);
    const dirs = this.directions(size);
    if (dirs.length === 1 && !this.isWall) direction = dirs[0];
    for (const fr of frame ? [frame, 0] : [0]) {
      let e = t.get(k(direction, fr));
      if (e) return { name: e.name, flipped: e.flip };
      const md = (((6 - direction) % 8) + 8) % 8;
      e = mirror && md !== direction ? t.get(k(md, fr)) : null;
      if (e) return { name: e.name, flipped: !e.flip };
    }
    return null;
  }

  /** Frame numbers a layer has sprites for (any direction, 64px), sorted. */
  frameSet(layer) {
    return [...new Set([...(this.sprites[64].get(layer)?.keys() ?? [])].map((x) => Number(x.split('_')[1])))].sort((a, b) => a - b);
  }

  /** True when the item has no `.data` state table and the states below are guessed from its sprite frames. */
  get statesInferred() { return !this.behavior && !Array.isArray(this.data.states) && this.#inferred().length > 0; }

  #inferred() {
    const n = Math.max(0, ...this.layers.map((L) => this.frameSet(L).length));
    return n > 1 ? Array.from({ length: n }, (_, i) => i) : [];
  }

  states() {
    if (this.behavior) return behaviorStates(this.behavior).map((x) => x.id);
    const s = this.data.states;
    return Array.isArray(s) ? s.map(Number) : this.#inferred();
  }

  /** [{ id, label, animated }]: labels come from the client's behaviour scripts (barrier, gate/divider, lamps, fan); null otherwise. */
  stateList() {
    const labels = this.behavior ? new Map(behaviorStates(this.behavior).map((x) => [x.id, x.label])) : new Map();
    return this.states().map((id) => ({ id, label: labels.get(id) ?? null, animated: timeline(this, id).steps.length > 1 }));
  }

  /**
   * Animation of a layer in a state: { frames, delay, loop, blend } or null when the data does not describe it.
   * From `.data` ([states:[..], layers:[a:[[frames:[..], delay:3, loop:0, blend:[..]], ...]]]); loop is null when absent (the client then
   * plays it once, loop 0 = forever). Without `.data` the state number is taken as the sprite frame (an inference, e.g. a gate:
   * frame 0 closed, frame 1 open) for layers that have that frame.
   */
  layerAnim(layer, state) {
    if (!Array.isArray(this.data.states)) {
      const have = this.frameSet(layer);
      return this.statesInferred && have.includes(state) ? { frames: [state], delay: 1, loop: 0, blend: null } : null;
    }
    const sts = this.states();
    const perLayer = this.data.layers?.[layer];
    if (!sts.length || !Array.isArray(perLayer)) return null;
    const i = sts.indexOf(state);
    if (i < 0 || i >= perLayer.length) return null;
    const e = isObj(perLayer[i]) ? perLayer[i] : null;
    let fr = e?.frames;
    if (!Array.isArray(fr) && Array.isArray(e?.sequences) && Array.isArray(e.sequences[0])) fr = e.sequences[0]; // approximation: first sequence
    const frames = (Array.isArray(fr) ? fr : []).map((x) => (Array.isArray(x) ? (x.length ? Math.trunc(x[0]) : 0) : typeof x === 'number' ? Math.trunc(x) : 0));
    if (!frames.length) return null;
    return {
      frames, delay: typeof e.delay === 'number' && e.delay >= 1 ? Math.trunc(e.delay) : 1, loop: typeof e.loop === 'number' ? Math.trunc(e.loop) : null,
      blend: Array.isArray(e.blend) ? e.blend.map((v) => (typeof v === 'number' ? v : 100)) : null,
    };
  }

  layerFrames(layer, state) { return this.layerAnim(layer, state)?.frames ?? null; }

  layerProps(layer) {
    const p = this.props[layer];
    return isObj(p) ? p : {};
  }

  info() {
    const frames = {};
    for (const L of this.layers) frames[L] = [...new Set([...(this.sprites[64].get(L)?.keys() ?? [])].map((x) => Number(x.split('_')[1])))].sort((a, b) => a - b);
    return {
      class: this.cls, bundle: this.meta.bundle, revision: this.meta.revision, layers: this.layers,
      directions: this.directions(64), directions_small: this.directions(32), states: this.states(), states_inferred: this.statesInferred,
      state_details: this.stateList(), behavior: this.behavior, script_classes: this.chain, tick_rate: TICKS_PER_SECOND,
      wall: this.isWall, wall_variants: this.wallVariants, has_shadow: this.hasShadow, dimensions: this.dim, has_icon: !!this.icon(), frames,
      layer_props: Object.fromEntries(this.layers.map((L) => {
        const p = this.layerProps(L);
        return [L, { ink: typeof p.ink === 'number' ? p.ink : null, blend: typeof p.blend === 'number' ? p.blend : null, zshift: p.zshift ?? null }];
      })),
      lighting: this.lighting,
      rotations: Object.fromEntries([64, 32].map((sz) => [sz, Object.fromEntries((this.isWall ? [2, 4] : [0, 1, 2, 3, 4, 5, 6, 7]).map((d) => [d, this.resolveDirection(d, sz)]).filter(([, v]) => v))])),
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
