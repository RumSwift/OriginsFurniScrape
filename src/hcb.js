// Reader for the HABBOCB1 cast-package container used by the furniture bundles.
//   "HABBOCB1" | u32 big-endian manifest length | JSON manifest (plaintext) | encrypted asset blob
// Cipher "xor-sha256-v1": keystream block i = SHA256(key || nonce(16) || u64_be(i)); asset offsets
// in the manifest are relative to the start of the blob.
import { createHash } from 'node:crypto';

export const MAGIC = Buffer.from('HABBOCB1');
export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const DEFAULT_KEY = Buffer.from('habbo-origins-local-packed-cast-key-v1');

export class BundleError extends Error {}

function xorKeystream(key, nonce, data) {
  const out = Buffer.allocUnsafe(data.length);
  const ctr = Buffer.alloc(8);
  for (let i = 0, blk = 0; i < data.length; i += 32, blk++) {
    ctr.writeBigUInt64BE(BigInt(blk));
    const ks = createHash('sha256').update(key).update(nonce).update(ctr).digest();
    const end = Math.min(32, data.length - i);
    for (let j = 0; j < end; j++) out[i + j] = data[i + j] ^ ks[j];
  }
  return out;
}

/** Build a bundle (used by the tests; mirrors the real format). */
export function seal(manifest, assets, key = DEFAULT_KEY, nonce = Buffer.alloc(16, 1)) {
  const entries = [];
  const parts = [];
  let off = 0;
  for (const [id, data] of Object.entries(assets)) {
    entries.push({ id, offset: off, length: data.length });
    parts.push(data);
    off += data.length;
  }
  const man = { ...manifest, format: 'habbo-cast-package', encoding: 'xor-sha256-v1', version: 1, nonce: nonce.toString('hex'), assets: entries };
  const mj = Buffer.from(JSON.stringify(man));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(mj.length);
  return Buffer.concat([MAGIC, len, mj, xorKeystream(key, nonce, Buffer.concat(parts))]);
}

/** Returns { manifest, assets: Map<id, Buffer> }. Throws BundleError on anything unexpected. */
export function parseBundle(data, key = DEFAULT_KEY, maxManifest = 8 << 20) {
  if (data.length < 12 || !data.subarray(0, 8).equals(MAGIC)) throw new BundleError('not a HABBOCB1 bundle');
  const n = data.readUInt32BE(8);
  if (n < 2 || n > maxManifest || 12 + n > data.length) throw new BundleError('bad manifest length');
  let man;
  try {
    man = JSON.parse(data.subarray(12, 12 + n).toString('utf8'));
  } catch (e) {
    throw new BundleError(`manifest is not JSON: ${e.message}`);
  }
  if (!man || typeof man !== 'object' || man.format !== 'habbo-cast-package' || man.encoding !== 'xor-sha256-v1')
    throw new BundleError('unsupported manifest format/encoding');
  if (typeof man.nonce !== 'string' || !/^([0-9a-f]{2})*$/i.test(man.nonce)) throw new BundleError('bad nonce');
  const nonce = Buffer.from(man.nonce, 'hex');
  if (nonce.length !== 16) throw new BundleError('nonce must be 16 bytes');
  const plain = xorKeystream(key, nonce, data.subarray(12 + n));
  const assets = new Map();
  for (const a of man.assets || []) {
    const off = Number(a?.offset), length = Number(a?.length);
    if (a?.id === undefined || !Number.isInteger(off) || !Number.isInteger(length)) throw new BundleError('bad asset entry');
    if (off < 0 || length < 0 || off + length > plain.length) throw new BundleError('asset range outside payload');
    assets.set(String(a.id), plain.subarray(off, off + length));
  }
  for (const [id, b] of assets)
    if (id.endsWith('/png') && !b.subarray(0, 8).equals(PNG_SIG)) throw new BundleError('PNG signature mismatch: wrong key or corrupt bundle');
  return { manifest: man, assets };
}
