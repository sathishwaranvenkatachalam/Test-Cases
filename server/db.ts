import Database from 'better-sqlite3';
import fs from 'node:fs';

const path = process.env.DB_PATH || 'data/app.db';
if (path !== ':memory:') fs.mkdirSync('data', { recursive: true });

export const db = new Database(path);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,            -- normalizeKey(canonical_text)
  canonical_text TEXT NOT NULL,
  mutability TEXT NOT NULL DEFAULT 'mutating' CHECK (mutability IN ('safe','mutating','reset')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  external_id TEXT, title TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS case_steps (
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  step_id INTEGER NOT NULL REFERENCES steps(id),
  params_json TEXT NOT NULL DEFAULT '{}',
  expected TEXT,
  PRIMARY KEY (case_id, position));
CREATE TABLE IF NOT EXISTS merge_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  new_step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  candidate_step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('action','assert')),
  params_hash TEXT NOT NULL DEFAULT '',   -- '' for kind=action
  expected_hash TEXT NOT NULL DEFAULT '', -- '' for kind=action
  code TEXT NOT NULL,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (step_id, kind, params_hash, expected_hash));
CREATE TABLE IF NOT EXISTS ingest_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, file_path TEXT NOT NULL,
  payload_json TEXT, status TEXT NOT NULL DEFAULT 'parsed' CHECK (status IN ('parsed','previewed','committed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL CHECK (mode IN ('claude','playwright')),
  scope TEXT NOT NULL CHECK (scope IN ('all','unverified','failed')),
  flow_ids TEXT NOT NULL, base_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed','cancelled','error')),
  error TEXT, stats_json TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT);
CREATE TABLE IF NOT EXISTS run_case_results (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass','fail','skipped','error')),
  note TEXT,
  PRIMARY KEY (run_id, case_id));
CREATE TABLE IF NOT EXISTS run_step_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  flow_id INTEGER NOT NULL, node_id TEXT NOT NULL, step_text TEXT NOT NULL,
  status TEXT NOT NULL, observed TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  line TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);
