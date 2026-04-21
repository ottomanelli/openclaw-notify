import Database, { type Database as Db } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  category TEXT,
  destination TEXT NOT NULL DEFAULT 'default',
  raw_data TEXT NOT NULL,
  should_format INTEGER NOT NULL,
  dedup_key TEXT,
  created_at INTEGER NOT NULL,
  reserved_at INTEGER,
  sent_at INTEGER,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  failed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_pending
  ON notifications (sent_at, destination, created_at);
-- Dedup filters by (dedup_key, destination, sent_at IS NULL, reserved_at,
-- created_at). Including destination keeps a concurrent queue with many
-- destinations from degrading the dedup lookup to a range scan per row.
CREATE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications (dedup_key, destination, sent_at);
`;

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}

export function closeDb(db: Db): void {
  db.close();
}

export type { Db };
