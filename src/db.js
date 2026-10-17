import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { config } from './config.js';

let cur = null; // { path, db }
const SCHEMA = `
CREATE TABLE IF NOT EXISTS bundles(
  name TEXT PRIMARY KEY, revision INTEGER, sha256 TEXT, byte_length INTEGER, path TEXT,
  first_seen REAL, synced_at REAL, status TEXT DEFAULT 'ok');
CREATE TABLE IF NOT EXISTS classes(class TEXT PRIMARY KEY, bundle TEXT);
CREATE INDEX IF NOT EXISTS classes_bundle ON classes(bundle);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);`;

export function db() {
  if (!cur || cur.path !== config.DB_PATH) {
    cur?.db.close();
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    const d = new DatabaseSync(config.DB_PATH);
    d.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;');
    d.exec(SCHEMA);
    cur = { path: config.DB_PATH, db: d };
  }
  return cur.db;
}
export const closeDb = () => { cur?.db.close(); cur = null; };
export const all = (sql, ...p) => db().prepare(sql).all(...p);
export const get = (sql, ...p) => db().prepare(sql).get(...p);
export const run = (sql, ...p) => db().prepare(sql).run(...p);
export function tx(fn) {
  const d = db();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
}
export const kvGet = (key, def = null) => get('SELECT value FROM kv WHERE key=?', key)?.value ?? def;
export const kvSet = (key, value) =>
  run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
