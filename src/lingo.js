// Tiny parser for the Lingo property-list syntax used by the .props / .data members.
//   ["b": [#zshift: [-75], #ink: 36], "a": [#zshift: [100, 100, -100]]]
//   [ states:[1,2,3], layers:[ a:[ [frames:[0]], [frames:[1]] ] ] ]
// Symbols (#ink) become plain strings; [:] is an empty object. Dicts are null-prototype objects.
export class LingoError extends Error {}

const TOK = /\s*(?:(--[^\n]*)|("(?:[^"\\]|\\.)*")|(#?[A-Za-z_][A-Za-z0-9_.]*)|(-?\d+(?:\.\d+)?)|([\[\],:]))/y;

function tokens(text) {
  text = text.replace(/\r/g, '\n');
  const out = [];
  let pos = 0;
  while (pos < text.length) {
    if (!text.slice(pos).trim()) break;
    TOK.lastIndex = pos;
    const m = TOK.exec(text);
    if (!m) throw new LingoError(`unexpected character at ${pos}: ${JSON.stringify(text.slice(pos, pos + 12))}`);
    pos = TOK.lastIndex;
    const [, comment, str, ident, num, punct] = m;
    if (comment) continue;
    if (str !== undefined) out.push(['s', str.slice(1, -1).replace(/\\"/g, '"')]);
    else if (ident !== undefined) out.push(['i', ident.replace(/^#/, '')]);
    else if (num !== undefined) out.push(['n', Number(num)]);
    else out.push(['p', punct]);
  }
  return out;
}

const isP = (t, v) => t && t[0] === 'p' && t[1] === v;

export function parse(text) {
  const t = tokens(text);
  if (!t.length) throw new LingoError('empty');
  return value(t, 0, 0)[0];
}

function value(t, i, depth) {
  if (depth > 40) throw new LingoError('nesting too deep');
  if (i >= t.length) throw new LingoError('unexpected end');
  const [kind, v] = t[i];
  if (kind !== 'p') return [v, i + 1];
  if (v !== '[') throw new LingoError(`unexpected ${JSON.stringify(v)}`);
  i++;
  if (isP(t[i], ':') && isP(t[i + 1], ']')) return [Object.create(null), i + 2];
  const items = [];
  const kv = Object.create(null);
  let isDict = false;
  for (;;) {
    if (i >= t.length) throw new LingoError('unterminated list');
    if (isP(t[i], ']')) { i++; break; }
    if (isP(t[i], ',')) { i++; continue; }
    if (t[i][0] !== 'p' && isP(t[i + 1], ':')) {
      const key = String(t[i][1]);
      let val;
      [val, i] = value(t, i + 2, depth + 1);
      kv[key] = val;
      isDict = true;
    } else {
      let val;
      [val, i] = value(t, i, depth + 1);
      items.push(val);
    }
  }
  return [isDict ? kv : items, i];
}
