// Emulation of the client's floor-furniture sprite pipeline, transcribed from its Lingo scripts:
//   Active Object Class        solveMembers / updateLocation  (which member each sprite shows, flip, position, locZ, shadow)
//   Active Object Extension Class  (`.data` animations: member names rebuilt per frame, exact direction, no fallback)
//   Furniture Divider / Lamp / DragonLamp / Fan / Barrier Class  (frame changes by renaming the sprite's current member)
// The output is a list of sprites (what the client would have on stage for one object) that render.js composites.
import { TICKS_PER_SECOND } from './behavior.js';

/** Position of a layer's zshift / locshift for a direction, as solveLocZ does (entry 1 when the list is too short). */
export function zAt(props, dir) {
  const z = props?.zshift;
  if (typeof z === 'number') return z;
  if (!Array.isArray(z) || !z.length) return 0;
  return Number(z[dir < z.length ? dir : 0]) || 0;
}

const num = (v, def) => (typeof v === 'number' ? Math.trunc(v) : def);

/**
 * Active Object Class solveMembers. Layer a is searched: requested direction, else direction 0 (same frame); if neither exists the
 * object's direction is increased (up to 7) and the search repeats; past 7 the client shows its placeholder (-> null here).
 * Other layers: the object's direction, else direction 0; the first layer letter with no member ends the list (later letters are
 * never drawn). Every sprite's draw order is zshift[direction] + (sprite number - 6).
 * -> { dir, via: 'exact'|'dir0', sprites: [...], shadow } or null.
 */
export function solveBase(furni, direction, size = 64, { exact = false } = {}) {
  const pre = size === 32 ? `s_${furni.cls}` : furni.cls;
  const dims = furni.dim ? `_${furni.dim[0]}_${furni.dim[1]}` : '';
  const props = furni.propsFor(size);
  let dir = direction, via = 'exact';
  const sprites = [];
  for (let idx = 1, code = 97; code <= 122; idx++, code++) {
    const L = String.fromCharCode(code), base = `${pre}_${L}_0${dims}`;
    let r = null;
    for (;;) {
      r = furni.resolve(`${base}_${dir}_0`);
      if (r && idx === 1) via = 'exact';
      if (!r && !exact) { r = furni.resolve(`${base}_0_0`); if (r && idx === 1) via = 'dir0'; }
      if (!r && idx === 1 && !exact) { if (++dir >= 8) return null; continue; }
      break;
    }
    if (!r) { if (idx === 1) return null; break; }
    const p = props[L] ?? {};
    sprites.push({ idx, layer: L, name: r.name, flip: r.flip, z: zAt(p, dir) + (idx - 6), ink: num(p.ink, 8), blend: num(p.blend, 100),
      color: idx - 1, visible: true, reloc: true });
  }
  // shadow: <class>_sd_<direction>, else <class>_sd. In private rooms it is drawn by the shadow manager at 30% (flipped ones shifted by one tile).
  let shadow = null;
  for (const n of [`${pre}_sd_${dir}`, `${pre}_sd`]) { const r = furni.resolve(n); if (r) { shadow = { name: r.name, flip: r.flip }; break; } }
  return { dir, via, sprites, shadow };
}

// ---------------------------------------------------------------- Active Object Extension Class (.data)
/** `.data` the way the extension's define() reads it: layer keys expanded ("abc" -> a, b, c), upper case -> lower case, sorted. */
export function dataModel(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data.layers && typeof data.layers === 'object' && !Array.isArray(data.layers) ? data.layers : {};
  const per = new Map();
  for (const [k, v] of Object.entries(raw)) for (const ch of String(k)) per.set(ch, v);
  const layers = new Map();
  for (const [k, v] of per) {
    const c = k.charCodeAt(0);
    layers.set(c < 97 ? String.fromCharCode(97 + (c - 65)) : k, v);
  }
  const letters = [...layers.keys()].sort();
  let states = Array.isArray(data.states) ? data.states : [];
  if (!validStates(states)) states = [];
  return { letters, layers, states, strings: Array.isArray(data.statestrings) ? data.statestrings : [] };
}

function validStates(list) {
  const seen = new Set();
  for (const s of list) {
    for (const v of Array.isArray(s) ? s : [s]) {
      if (typeof v !== 'number' || v < 1 || seen.has(v)) return false;
      seen.add(v);
    }
    if (Array.isArray(s) && !s.length) return false;
  }
  return true;
}

/** State ids an item understands (the .data values; the server's stuffdata is the value - 1). */
export const dataStates = (dm) => (dm ? dm.states.flatMap((s) => (Array.isArray(s) ? s : [s])) : []);

/** setState: the value itself when listed, else the first state's (first) value. */
function resolveState(dm, state) {
  const all = dataStates(dm);
  if (all.includes(state)) return state;
  const f = dm.states[0];
  return Array.isArray(f) ? f[0] : f ?? 1;
}

/** getFrameList: the layer's entry for the current state (entry 1 when the state number is past the end of the list). */
function frameList(dm, L, pState) {
  const l = dm.layers.get(L);
  if (!Array.isArray(l) || !l.length) return null;
  const e = l[(pState > l.length ? 1 : pState) - 1];
  return e && typeof e === 'object' && !Array.isArray(e) ? e : null;
}

// deterministic stand-in for Lingo's random(n) (1..n), so a render is reproducible
function rng(seed) {
  let s = seed >>> 0;
  return (n) => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return 1 + (((t ^ (t >>> 14)) >>> 0) % Math.max(1, n)); };
}
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

/**
 * Runs the extension's update() tick by tick for one state. -> { steps: [{ ticks, layers: { L: { frame, blend? } } }], finite, source }.
 * Frame lists: [#frames: [...], #delay: n, #loop: n, #blend: [...], #random: 1, #sequences: [[...], ...]]; a negative frame means
 * random(abs). loop absent = play once and hold, loop 0 = forever, loop n = n passes.
 */
export function extensionTimeline(dm, state, { maxTicks = 600, cls = '' } = {}) {
  const pState = resolveState(dm, state);
  const R = rng(hash(`${cls}|${state}`));
  let random = false;
  const L = dm.letters.map((letter) => {
    const e = frameList(dm, letter, pState);
    const seqs = Array.isArray(e?.sequences) ? e.sequences.filter(Array.isArray) : null;
    const frames = Array.isArray(e?.frames) ? e.frames : null;
    if (e?.random !== undefined || seqs?.length || [...(frames ?? []), ...(seqs ?? []).flat()].some((f) => typeof f === 'number' && f < 0)) random = true;
    return { letter, e, frames, seqs, n: 1, n2: 1, seq: 1, rep: 1, on: true, lc: e ? (e.loop !== undefined ? num(e.loop, 0) - 1 : 1) : 0, blend: undefined };
  });
  const list = (s) => s.frames ?? s.seqs?.[s.seq - 1] ?? null;
  const frameOf = (s) => {
    const l = list(s);
    if (!l) return 0;
    let f = num(l[s.n2 - 1], 0);
    if (f < 0) f = R(-f);
    return f;
  };
  // bare: the state has no frame list for this layer (wall items then use the plain "<side> <class>" member)
  const snap = () => Object.fromEntries(L.map((s) => [s.letter, { frame: frameOf(s), ...(s.blend === undefined ? {} : { blend: s.blend }), ...(list(s) ? {} : { bare: true }) }]));
  const sig = () => L.map((s) => `${s.n},${s.n2},${s.seq},${s.rep},${s.lc},${s.on ? 1 : 0},${s.blend}`).join('|');
  const animates = (s) => s.e && (s.frames || s.seqs);
  const snaps = [], seen = new Map();
  let finite = false;
  for (let t = 0; t < maxTicks; t++) {
    if (!random) {
      const key = sig();
      if (seen.has(key)) { snaps.splice(0, seen.get(key)); break; }
      seen.set(key, t);
    }
    snaps.push(snap());
    if (!L.some((s) => s.on && animates(s))) { finite = true; break; }
    for (const s of L) {
      if (!s.on || !animates(s)) continue;
      const delay = num(s.e.delay, 1) >= 1 ? num(s.e.delay, 1) : 1;
      if (s.rep >= delay) {
        const cnt = s.frames ? s.frames.length : (s.seqs[s.seq - 1]?.length ?? 0);
        const nseq = s.frames ? 0 : s.seqs.length;
        if (cnt > 0) {
          let go = 1;
          if (s.n === cnt) { if (s.lc > 0) s.lc--; go = s.lc; if (s.lc === 0) s.on = false; }
          if (s.n < cnt || go) {
            if (nseq > 0 && s.n === cnt) { s.seq = R(nseq); s.n = 1; } else s.n = (s.n % cnt) + 1;
            const cnt2 = s.frames ? s.frames.length : (s.seqs[s.seq - 1]?.length ?? 0);
            if (s.e.random !== undefined && cnt2 > 1) { let r = R(cnt2); if (r === s.n2) r = (s.n2 % cnt2) + 1; s.n2 = r; } else s.n2 = s.n;
            if (Array.isArray(s.e.blend) && s.e.blend.length >= s.n2) s.blend = num(s.e.blend[s.n2 - 1], 100);
          }
        }
        s.rep = 1;
      } else s.rep++;
    }
  }
  const steps = [];
  for (const snapL of snaps) {
    const last = steps[steps.length - 1];
    if (last && JSON.stringify(last.layers) === JSON.stringify(snapL)) last.ticks++;
    else steps.push({ ticks: 1, layers: snapL });
  }
  if (finite && steps.length) steps[steps.length - 1].ticks += TICKS_PER_SECOND; // hold the end pose a moment before a GIF restarts
  return { steps: steps.slice(0, 120), finite, source: '.data' };
}

/** Extension solveMembers on top of the base sprites: data layer i (sorted) drives sprite i with `<name>_<L>_0_<x>_<y>_<dir>_<frame>`. */
function applyExtension(furni, base, dm, step, size) {
  const pre = size === 32 ? `s_${furni.cls}` : furni.cls;
  const dims = `_${furni.dim?.[0] ?? 1}_${furni.dim?.[1] ?? 1}`;
  const props = furni.propsFor(size);
  const letters = dm.letters.length ? dm.letters : base.sprites.map((s) => s.layer);
  const baseCount = base.sprites.length;
  const sprites = base.sprites.map((s) => ({ ...s }));
  letters.forEach((L, i) => {
    const idx = i + 1, p = props[L] ?? {};
    const st = step?.layers?.[L];
    const frame = st?.frame ?? 0;
    const r = furni.resolve(`${pre}_${L}_0${dims}_${base.dir}_${frame}`);
    const s = sprites[i] ?? { idx, color: idx <= baseCount ? idx - 1 : null, reloc: true };
    Object.assign(s, { idx, layer: L, z: zAt(p, base.dir) + (idx - 6), ink: num(p.ink, 8), blend: st?.blend ?? num(p.blend, 100),
      name: r?.name ?? null, flip: r?.flip ?? false, visible: !!r, reloc: true });
    sprites[i] = s;
  });
  return sprites;
}

// ---------------------------------------------------------------- behaviour scripts (no .data): frames by renaming members
const swapLast = (name, ch) => `${name.slice(0, -1)}${ch}`;
/** memberExists(name) + member(getmemnum(name)): the sprite takes that member; its rotation (flip) and location stay. */
function rename(furni, s, name) {
  const r = furni.resolve(name);
  if (r) s.name = r.name;
  return !!r;
}

/**
 * Applies one behaviour step to the base sprites. step.layers = { L: { frame?, visible? } } where L is the sprite's letter
 * (sprite n = letter n in the base list).
 */
function applyBehaviour(furni, kind, base, step, size = 64) {
  const sprites = base.sprites.map((s) => ({ ...s }));
  const at = (L) => sprites[L.charCodeAt(0) - 97];
  const ops = step?.layers ?? {};
  if (kind === 'plant' || kind === 'plant-strict') {
    // Furniture Plant Class setFrame (resolveMemName): <class>_<layer>_0_<x>_<y>_<dir> taken from the sprite's current member
    // (which may be another class's shared art), + "_" + stuffdata. Used for unknown scripts too, falling back to a plain rename.
    const pre = size === 32 ? `s_${furni.cls}` : furni.cls;
    for (const [L, o] of Object.entries(ops)) {
      const s = at(L);
      if (!s || o.frame === undefined) continue;
      const items = s.name.split('_'), n = items.length;
      if (n >= 6 && rename(furni, s, `${pre}_${items.slice(n - 6, n - 1).join('_')}_${o.frame}`)) continue;
      if (kind !== 'plant-strict') rename(furni, s, swapLast(s.name, String(o.frame)));
    }
    return sprites;
  }
  if (kind === 'divider') {
    // Furniture Divider Class update (open only): <current member minus "<dir>_<frame>"><objectDir>_1 if it exists (fresh flip,
    // location reset without locshift), else the current member's frame-1 sibling (flip and location kept).
    if (sprites.length < 2 || !Object.values(ops).some((o) => o.frame === 1)) return sprites;
    for (const s of sprites) {
      const l7 = swapLast(s.name, '1');
      const l8 = `${l7.slice(0, -3)}${base.dir}_1`;
      const r8 = furni.resolve(l8);
      if (r8) { Object.assign(s, { name: r8.name, flip: r8.flip, reloc: false }); continue; }
      rename(furni, s, l7);
    }
    return sprites;
  }
  if (kind === 'lamp') {
    // Furniture Lamp Class update: b and c are re-derived from layer a's member name with the switch as frame; locZ b = a + 2, c = b + 2.
    if (sprites.length < 3) return sprites;
    const sw = ops.b?.frame ?? ops.c?.frame ?? 0;
    const items = sprites[0].name.split('_'), n = items.length;
    const head = items.slice(0, n - 6).join('_'), mid = items.slice(n - 5, n - 1).join('_');
    for (const [i, L] of [[1, 'b'], [2, 'c']]) rename(furni, sprites[i], `${head}_${L}_${mid}_${sw}`);
    sprites[1].z = sprites[0].z + 2; sprites[2].z = sprites[1].z + 2;
    return sprites;
  }
  // swap (dragon lamp, fan, barrier visibility, inferred states): last character of the current member name -> frame
  for (const [L, o] of Object.entries(ops)) {
    const s = at(L);
    if (!s) continue;
    if (o.frame !== undefined) rename(furni, s, swapLast(s.name, String(o.frame)));
    if (o.visible !== undefined) s.visible = o.visible;
  }
  return sprites;
}

const MIN_SPRITES = { dragonlamp: 7, fan: 4, barrier: 5, divider: 2, lamp: 3 };
const KIND = { divider: 'divider', lamp: 'lamp' };

/**
 * The sprites of one object for a direction and (optional) animation step.
 * mode: 'extension' (.data), a behaviour name, 'inferred' (frame = state guess) or null (static).
 */
export function solve(furni, { direction = 2, size = 64, step = null, frame = 0, exact = false } = {}) {
  const base = solveBase(furni, direction, size, { exact });
  if (!base) return null;
  const mode = furni.mode;
  let sprites;
  const dm = mode === 'extension' ? furni.dataModelFor(size) : null;
  if (dm && (dm.letters.length || dm.states.length)) sprites = applyExtension(furni, base, dm, step, size);
  else if (dm) sprites = base.sprites; // empty / invalid .data: the extension hands everything to Active Object Class
  else if (furni.behavior && step) sprites = base.sprites.length >= (MIN_SPRITES[furni.behavior] ?? 0) ? applyBehaviour(furni, KIND[furni.behavior] ?? 'swap', base, step) : base.sprites;
  else if (step) sprites = applyBehaviour(furni, furni.chain.includes('Furniture Plant Class') ? 'plant-strict' : 'plant', base, step, size);
  else if (frame) sprites = applyBehaviour(furni, 'plant', base, { layers: Object.fromEntries(base.sprites.map((s) => [s.layer, { frame }])) }, size);
  else sprites = base.sprites;
  return { ...base, sprites };
}
