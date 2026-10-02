import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");
export const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, "lottery.db");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slots INTEGER NOT NULL CHECK (slots > 0),
  seed TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS roster_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  version INTEGER NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, version)
);

CREATE TABLE IF NOT EXISTS roster_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roster_version_id INTEGER NOT NULL REFERENCES roster_versions(id),
  person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  weight INTEGER NOT NULL CHECK (weight > 0),
  line_no INTEGER NOT NULL,
  UNIQUE (roster_version_id, person_id)
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  roster_version_id INTEGER NOT NULL REFERENCES roster_versions(id),
  seed TEXT NOT NULL,
  algo_version TEXT NOT NULL,
  slots INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, roster_version_id, seed)
);

CREATE TABLE IF NOT EXISTS draw_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  person_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('winner','waitlist')),
  UNIQUE (batch_id, person_id),
  UNIQUE (batch_id, position)
);

CREATE TABLE IF NOT EXISTS replacements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL,
  abandoned_person_id TEXT NOT NULL,
  promoted_person_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (batch_id, seq),
  UNIQUE (batch_id, abandoned_person_id)
);
`;

export function openDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

/** 在事务中执行，出错回滚，保证确认/递补原子完成 */
export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
