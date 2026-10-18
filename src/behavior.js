// Animation timelines, modelled on the client's furniture scripts (decoded from its runtime pack).
// A timeline is { steps: [{ ticks, layers: { <letter>: { frame?, visible?, blend? } } }], finite, source }.
// One tick = one client frame (the client movie runs at 15 fps, so TICKS_PER_SECOND = 15).
import { classChain } from './aliasdb.js';
import { extensionTimeline } from './client.js';

export const TICKS_PER_SECOND = 15;

const single = (layers, source) => ({ steps: [{ ticks: 1, layers }], finite: false, source });
const same = (letters, o) => Object.fromEntries(letters.map((l) => [l, o]));

/**
 * Hard-coded behaviours of the client's special classes. `states` are the stuffdata values the script understands
 * (0 = off/closed, 1 = on/open). Sprite numbers in the scripts map to layer letters (sprite 1 = a, 2 = b ...).
 */
const BEHAVIORS = {
  // Furniture Barrier Class: state "1" shows sprite 5 (layer e) for 20 ticks then hides it for 26 (blink), state "0" hides it.
  barrier: {
    chain: 'Furniture Barrier Class',
    states: [{ id: 0, label: 'off' }, { id: 1, label: 'on (blinking)' }],
    timeline: (state) => state === 1
      ? { steps: [{ ticks: 20, layers: { e: { visible: true } } }, { ticks: 26, layers: { e: { visible: false } } }], finite: false, source: 'barrier' }
      : single({ e: { visible: false } }, 'barrier'),
  },
  // Furniture Divider Class (gates, dividers): every layer shows the frame equal to the state (0 closed, 1 open).
  divider: {
    chain: 'Furniture Divider Class',
    states: [{ id: 0, label: 'closed' }, { id: 1, label: 'open' }],
    timeline: (state, furni) => single(same(furni.layers, { frame: state === 1 ? 1 : 0 }), 'divider'),
  },
  // Furniture Lamp Class: layers b and c use frame = switch (0 off, 1 on).
  lamp: {
    chain: 'Furniture Lamp Class',
    states: [{ id: 0, label: 'off' }, { id: 1, label: 'on' }],
    timeline: (state) => single(same(['b', 'c'], { frame: state === 1 ? 1 : 0 }), 'lamp'),
  },
  // Furniture DragonLamp Class: on = layers c, e, g frame 1 and layer f cycling frames 1..4, one frame every 2 ticks; off = all frame 0.
  dragonlamp: {
    chain: 'Furniture DragonLamp Class',
    states: [{ id: 0, label: 'off' }, { id: 1, label: 'on (animated)' }],
    timeline: (state) => state === 1
      ? { steps: [1, 2, 3, 4].map((f) => ({ ticks: 2, layers: { c: { frame: 1 }, e: { frame: 1 }, g: { frame: 1 }, f: { frame: f } } })), finite: false, source: 'dragonlamp' }
      : single(same(['c', 'e', 'f', 'g'], { frame: 0 }), 'dragonlamp'),
  },
  // Furniture Fan Class: on = layer c frame 1 and layer d cycling frames 1..3 (2 ticks each); off = frame 0.
  fan: {
    chain: 'Furniture Fan Class',
    states: [{ id: 0, label: 'off' }, { id: 1, label: 'on (animated)' }],
    timeline: (state) => state === 1
      ? { steps: [1, 2, 3].map((f) => ({ ticks: 2, layers: { c: { frame: 1 }, d: { frame: f } } })), finite: false, source: 'fan' }
      : single(same(['c', 'd'], { frame: 0 }), 'fan'),
  },
};

/** Name of the special behaviour a class runs, or null. */
export function behaviorOf(cls) {
  const chain = classChain(cls);
  for (const [name, b] of Object.entries(BEHAVIORS)) if (chain.includes(b.chain)) return name;
  return null;
}

export const behaviorStates = (name) => BEHAVIORS[name]?.states ?? null;

/**
 * -> timeline for a state. state === null -> a single empty step (the default pose).
 * Behaviour scripts use their own timelines; `.data` items run the Active Object Extension update loop (client.js);
 * anything else: the state number is taken as the sprite frame (a guess, marked states_inferred).
 */
export function timeline(furni, state) {
  if (state === null) return single({}, 'none');
  if (furni.behavior) return BEHAVIORS[furni.behavior].timeline(state, furni);
  if (furni.mode === 'extension') return extensionTimeline(furni.dataModelFor(64), state, { cls: furni.cls });
  return single(same(furni.layers, { frame: state }), 'inferred');
}

/** The step shown for index `i` (wraps). */
export function stepAt(furni, state, i = 0) {
  const t = timeline(furni, state);
  return t.steps[((i % t.steps.length) + t.steps.length) % t.steps.length];
}
