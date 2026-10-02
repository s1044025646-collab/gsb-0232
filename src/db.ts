import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
export const DEFAULT_DB_PATH = path.join(DATA_DIR, 'lottery.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  quota INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  algo_version TEXT NOT NULL,
  max_candidates INTEGER NOT NULL,
  max_weight INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS roster_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  version_no INTEGER NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, version_no)
);

CREATE TABLE IF NOT EXISTS draw_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  roster_version_id INTEGER NOT NULL REFERENCES roster_versions(id),
  seed INTEGER NOT NULL,
  algo_version TEXT NOT NULL,
  quota INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, roster_version_id, seed)
);

CREATE TABLE IF NOT EXISTS draw_entries (
  batch_id INTEGER NOT NULL REFERENCES draw_batches(id),
  position INTEGER NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  weight INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('winner', 'waitlist')),
  PRIMARY KEY (batch_id, position)
);

CREATE TABLE IF NOT EXISTS forfeits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES draw_batches(id),
  candidate_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (batch_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES draw_batches(id),
  forfeit_id INTEGER NOT NULL REFERENCES forfeits(id),
  candidate_id TEXT,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}
