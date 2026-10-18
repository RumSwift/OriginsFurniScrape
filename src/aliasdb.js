// Client-side furniture data decoded from the game's runtime pack (see data/):
//  - furniture-aliases.json: { memberName: [targetName, flip] } - the client's global alias table. flip=1 means "the target, mirrored
//    horizontally" (this is how direction 4/6 sprites are produced from 2/0 in the client). Not derivable from the names.
//  - classmap.json: { class: [scriptClass, ...] } - which behaviour scripts a furniture class runs (barrier, gate, dragon lamp...).
// Both files are optional: without them the loader degrades to "no flip data / no behaviours".
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dataDir = () => process.env.CLIENT_DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
let cache = null;

function readJson(name) {
  try { return JSON.parse(fs.readFileSync(`${dataDir()}/${name}`, 'utf8')); } catch { return {}; }
}

// name -> [layer-class-key]; grouped by furniture class so a class only scans its own names
const NAME_RE = /^(?:s_)?(.+)_([a-z])_0_(?:\d+_\d+_)?\d+_\d+$/;

// wall furniture members: "[s_](leftwall|rightwall) <class>[ <variant>][_<layer>_<frame>]"
const WALL_RE = /^(s_)?(leftwall|rightwall) ([^ ]+?)(?: (.+?))?(?:_([a-z])_(\d+))?$/;

/** -> { size, side, cls, variant, layer, frame } or null. Without a layer suffix the member is layer a, frame 0. */
export function parseWallName(name) {
  const m = WALL_RE.exec(name);
  if (!m) return null;
  return { size: m[1] ? 32 : 64, side: m[2], cls: m[3], variant: m[4] ?? null, layer: m[5] ?? 'a', frame: m[6] === undefined ? 0 : Number(m[6]) };
}

function load() {
  if (cache) return cache;
  const aliases = readJson('furniture-aliases.json');
  const byClass = new Map(), wallByClass = new Map();
  for (const name of Object.keys(aliases)) {
    const w = parseWallName(name);
    if (w) { if (!wallByClass.has(w.cls)) wallByClass.set(w.cls, []); wallByClass.get(w.cls).push(name); continue; }
    const m = NAME_RE.exec(name);
    if (!m) continue;
    if (!byClass.has(m[1])) byClass.set(m[1], []);
    byClass.get(m[1]).push(name);
  }
  cache = { aliases, byClass, wallByClass, classes: readJson('classmap.json'), systemWin: readJson('systemwin.json') };
  return cache;
}

export const reloadClientData = () => { cache = null; };

/** -> [target, flip(0|1)] or null */
export function aliasOf(name) {
  const a = load().aliases[name];
  return Array.isArray(a) ? a : null;
}

/** Alias names (not bundle members) that belong to a furniture class. */
export const aliasNamesFor = (cls) => load().byClass.get(cls) ?? [];

/** Wall-furniture alias names that belong to a class. */
export const wallNamesFor = (cls) => load().wallByClass.get(cls) ?? [];

/** Script class chain of a furniture class, e.g. ['Active Object Class', 'Furniture Barrier Class']. */
export const classChain = (cls) => load().classes[cls] ?? [];

export const hasClientData = () => Object.keys(load().aliases).length > 0;

/** Director palette index -> [r,g,b]. The client resolves integer part colours with paletteIndex(n) in the movie's default palette (System - Win). */
export function paletteColor(n) {
  const c = (load().systemWin.colors ?? [])[n];
  return Array.isArray(c) ? c : null;
}
