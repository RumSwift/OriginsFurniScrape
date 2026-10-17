// All configuration comes from environment variables (see .env.example).
// `config` is a live singleton; call reload() after changing process.env (tests do).
import path from 'node:path';

const bool = (name, def) => {
  const v = process.env[name];
  return v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
};
const num = (name, def) => {
  const n = Number(process.env[name] ?? def);
  return Number.isFinite(n) ? n : def;
};

function compute() {
  const e = process.env;
  const DATA_DIR = e.DATA_DIR || '/data';
  return {
    DATA_DIR,
    FURNI_BASE_URL: e.FURNI_BASE_URL || 'https://images.habbo.com/habbo-origins/keystone/',
    FURNI_INDEX_URL: e.FURNI_INDEX_URL || '', // default: FURNI_BASE_URL + furniture-index.json
    ASSET_KEY: Buffer.from(e.HABBO_ASSET_BUNDLE_KEY || 'habbo-origins-local-packed-cast-key-v1'),
    // Politeness towards the content server
    SYNC_USER_AGENT: e.SYNC_USER_AGENT || 'furni-imager/1.0 (set SYNC_USER_AGENT to your site + contact)',
    SYNC_DELAY: num('SYNC_DELAY', 0.3), // seconds between requests (per worker)
    SYNC_CONCURRENCY: Math.max(1, Math.min(4, Math.trunc(num('SYNC_CONCURRENCY', 2)))),
    SYNC_INTERVAL_HOURS: num('SYNC_INTERVAL_HOURS', 6), // 0 disables the scheduler
    SYNC_ON_START: bool('SYNC_ON_START', true),
    SYNC_MAX_FAILURES: Math.trunc(num('SYNC_MAX_FAILURES', 8)),
    SYNC_MAX_BUNDLE_BYTES: Math.trunc(num('SYNC_MAX_BUNDLE_BYTES', 64 * 1024 * 1024)),
    KEEP_RAW: bool('KEEP_RAW', true), // keep downloaded .hcb files
    KEEP_IDX: bool('KEEP_IDX', false), // also write raw 8-bit indexed pixel data
    ADMIN_TOKEN: e.ADMIN_TOKEN || '', // empty = admin endpoints disabled
    FURNIDATA_URL: e.FURNIDATA_URL || '',
    CORS_ORIGINS: (e.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
    PORT: Math.trunc(num('PORT', 8000)),
    FURNI_DIR: path.join(DATA_DIR, 'furni'),
    RAW_DIR: path.join(DATA_DIR, 'hcb'),
    CACHE_DIR: path.join(DATA_DIR, 'cache'),
    DB_PATH: path.join(DATA_DIR, 'catalogue.sqlite'),
  };
}

export const config = compute();
export const reload = () => Object.assign(config, compute());
export const indexUrl = () => config.FURNI_INDEX_URL || config.FURNI_BASE_URL.replace(/\/+$/, '') + '/furniture-index.json';
