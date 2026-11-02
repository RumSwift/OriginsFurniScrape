// Game data the client loads besides the furniture bundles:
//  - external_texts      names / descriptions: furni_<class>[*N]_name|_desc, wallitem_<class>_name|_desc, poster_<N>_name|_desc
//  - external_variables  url.prefix (the hotel host the client builds the furnidata URL from)
//  - furnidata_json      every furniture class and colour variant ("rare_dragonlamp*7") with its partcolors - the colour the
//                        client gives each layer (bgColor; '#rrggbb' or a palette index into the default palette)
// The client builds the furnidata URL as "https://" + url.prefix + "/gamedata/furnidata_json/1".
// Downloaded on every sync (and POST /admin/gamedata), kept in DATA_DIR/gamedata/, merged into the `variants` table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import * as D from './db.js';
import { httpGet } from './sync.js';

const dir = () => path.join(config.DATA_DIR, 'gamedata');
const isRemote = (u) => /^https?:\/\//.test(u);
const localPath = (u) => (u.startsWith('file://') ? fileURLToPath(u) : u);
const log = (lvl, ...a) => console[lvl === 'error' ? 'error' : 'log'](`[gamedata] ${lvl}:`, ...a);

export const GAMEDATA_STATUS = { last_refresh: null, last_error: null, sources: {} };

async function fetchTo(url, file) {
  if (!url || url === 'none') return null;
  try {
    const body = isRemote(url) ? (await httpGet(url)).body : fs.readFileSync(localPath(url));
    if (!body.length) throw new Error('empty response');
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), `${file}.tmp`), body);
    fs.renameSync(path.join(dir(), `${file}.tmp`), path.join(dir(), file));
    GAMEDATA_STATUS.sources[file] = { url, bytes: body.length, at: Date.now() / 1000 };
    return body;
  } catch (e) {
    GAMEDATA_STATUS.sources[file] = { url, error: e.message, at: Date.now() / 1000 };
    log('warn', `${url}: ${e.message} (keeping the previous copy)`);
    return null;
  }
}

const readKept = (file) => { try { return fs.readFileSync(path.join(dir(), file)); } catch { return null; } };

/** key=value lines (Director text members / external_* files). Later duplicates win. */
export function parseKeyValues(text) {
  const out = new Map();
  for (const line of String(text).split(/\r\n|\r|\n/)) {
    const i = line.indexOf('=');
    if (i <= 0 || line.startsWith('#')) continue;
    out.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return out;
}

/** partcolors in any of the shapes furnidata uses: {color:[...]}, [...], "a,b,c". */
function colorList(pc) {
  if (pc == null) return [];
  if (Array.isArray(pc)) return pc.map((c) => String(c ?? '').trim());
  if (typeof pc === 'object') return colorList(pc.color ?? pc.colors ?? []);
  return String(pc).split(',').map((c) => c.trim());
}

/** Every object with a `classname` anywhere in the furnidata JSON; `kind` from the room/wall section it sits in. */
export function parseFurnidata(json) {
  const out = [];
  const walk = (v, kind) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, kind); return; }
    if (!v || typeof v !== 'object') return;
    if (typeof v.classname === 'string') { out.push({ ...v, _kind: kind }); return; }
    for (const [k, x] of Object.entries(v)) walk(x, /wall/i.test(k) ? 'wall' : /room|floor/i.test(k) ? 'floor' : kind);
  };
  walk(json, null);
  return out;
}

const splitVariant = (cls) => {
  const i = cls.indexOf('*');
  return i < 0 ? [cls, null] : [cls.slice(0, i), cls.slice(i + 1) || null];
};

/**
 * One row per class / colour variant known from furnidata or the texts:
 * { class, base, variant, kind, name, description, colors[], furnidata{...}|null, sources[] }
 */
export function buildVariants(texts, furnidata) {
  const rows = new Map();
  const row = (cls, kind) => {
    if (!rows.has(cls)) {
      const [base, variant] = splitVariant(cls);
      rows.set(cls, { class: cls, base, variant, kind, name: null, description: null, colors: [], furnidata: null, sources: [] });
    }
    const r = rows.get(cls);
    if (!r.kind && kind) r.kind = kind;
    return r;
  };
  for (const f of furnidata) {
    const r = row(f.classname, f._kind ?? null);
    r.colors = colorList(f.partcolors);
    r.furnidata = Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith('_')));
    if (typeof f.name === 'string' && f.name) r.name = f.name;
    if (typeof f.description === 'string' && f.description) r.description = f.description;
    r.sources.push('furnidata');
  }
  for (const [key, value] of texts) {
    let m = /^furni_(.+)_(name|desc)$/.exec(key), cls, kind = 'floor';
    if (m) cls = m[1];
    else if ((m = /^wallitem_(.+)_(name|desc)$/.exec(key))) { cls = m[1]; kind = 'wall'; }
    else if ((m = /^poster_(\d+)_(name|desc)$/.exec(key))) { cls = `poster*${m[1]}`; kind = 'wall'; }
    else continue;
    const r = row(cls, kind);
    if (m[2] === 'name') r.name = value; else r.description = value;
    if (!r.sources.includes('texts')) r.sources.push('texts');
  }
  return [...rows.values()];
}

// ---------------------------------------------------------------- in-memory lookup + DB
let mem = null; // Map class -> row

function load() {
  if (mem) return mem;
  mem = new Map();
  try {
    for (const r of D.all('SELECT * FROM variants')) {
      mem.set(r.class, { ...r, colors: JSON.parse(r.colors || '[]'), furnidata: r.furnidata ? JSON.parse(r.furnidata) : null, sources: JSON.parse(r.sources || '[]') });
    }
  } catch { /* table empty / missing */ }
  return mem;
}
export const clearGamedataCache = () => { mem = null; };

/** Row for an exact class name ('rare_dragonlamp*7', 'pura_mdl1'), or null. */
export const entry = (cls) => load().get(cls) ?? null;

/** Part colours the client would use: the variant's furnidata entry, else the class's own entry. */
export function partColors(base, variant) {
  const e = (variant !== null && variant !== undefined ? entry(`${base}*${variant}`) : null) ?? entry(base);
  return e?.colors?.length ? e.colors : null;
}

/** All variants of a base class (including the base itself when listed), sorted numerically. */
export function variantsOf(base) {
  return [...load().values()].filter((r) => r.base === base)
    .sort((a, b) => (a.variant === null ? -1 : b.variant === null ? 1 : (Number(a.variant) - Number(b.variant)) || String(a.variant).localeCompare(String(b.variant))));
}

export function allVariants() { return [...load().values()]; }

/** Download texts / variables / furnidata (keeping the last good copies on failure) and rebuild the variants table. */
export async function refresh() {
  const t0 = Date.now();
  await fetchTo(config.EXTERNAL_VARIABLES_URL, 'external_variables.txt');
  const vars = parseKeyValues(readKept('external_variables.txt')?.toString('utf8') ?? '');
  const prefix = (vars.get('url.prefix') || 'origins.habbo.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const furnidataUrl = config.FURNIDATA_URL || `https://${prefix}/gamedata/furnidata_json/1`;
  await fetchTo(config.EXTERNAL_TEXTS_URL, 'external_texts.txt');
  await fetchTo(furnidataUrl, 'furnidata.json');

  const texts = parseKeyValues(readKept('external_texts.txt')?.toString('utf8') ?? '');
  let fd = [];
  const raw = readKept('furnidata.json');
  if (raw) {
    try { fd = parseFurnidata(JSON.parse(raw.toString('utf8'))); } catch (e) { GAMEDATA_STATUS.last_error = `furnidata.json: ${e.message}`; log('error', GAMEDATA_STATUS.last_error); }
  }
  const rows = buildVariants(texts, fd);
  D.tx(() => {
    D.run('DELETE FROM variants');
    const ins = D.db().prepare('INSERT INTO variants(class,base,variant,kind,name,description,colors,furnidata,sources) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const r of rows) {
      ins.run(r.class, r.base, r.variant, r.kind, r.name, r.description, JSON.stringify(r.colors),
        r.furnidata ? JSON.stringify(r.furnidata) : null, JSON.stringify(r.sources));
    }
  });
  clearGamedataCache();
  Object.assign(GAMEDATA_STATUS, {
    last_refresh: Date.now() / 1000, furnidata_url: furnidataUrl, furnidata_entries: fd.length, text_entries: texts.size,
    variants: rows.filter((r) => r.variant !== null).length, classes: rows.length, ms: Date.now() - t0,
  });
  D.kvSet('gamedata', JSON.stringify(GAMEDATA_STATUS));
  log('info', `${rows.length} classes/variants (${fd.length} furnidata entries, ${texts.size} texts)`);
  return GAMEDATA_STATUS;
}
