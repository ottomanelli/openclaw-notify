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
  failed_at INTEGER,
  next_attempt_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_pending
  ON notifications (sent_at, destination, created_at);
-- Dedup filters by (source, dedup_key, destination, sent_at IS NULL,
-- reserved_at, created_at). Source is in the key so two consumers can both
-- use an ergonomic key like "reminder:42" without colliding. Including
-- destination keeps a concurrent queue with many destinations from
-- degrading the dedup lookup to a range scan per row.
CREATE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications (source, dedup_key, destination, sent_at);
`;

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // CLI and service run as separate processes against the same WAL-mode DB
  // and can transiently contend on writes. Default is 0 (fail immediately),
  // which surfaces SQLITE_BUSY for what is actually a routine lock conflict.
  // Retry inside SQLite for up to 5 s first.
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  // Idempotent column add — on a fresh install the column already exists
  // via SCHEMA; on an upgrade from an earlier version this installs it
  // without touching data. Uses pragma instead of try/catch so a real DDL
  // error still surfaces.
  const cols = db.pragma("table_info(notifications)") as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "next_attempt_at")) {
    db.exec("ALTER TABLE notifications ADD COLUMN next_attempt_at INTEGER");
  }
  // Notification content can include personal reminders, calendar subjects,
  // etc. Default umask leaves the file world-readable; tighten it. No-op on
  // Windows (Node's chmod only touches the read-only bit there).
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // File may not exist yet on exotic FSes, or we may not own it on a
    // re-open; not fatal.
  }
  return db;
}

export function closeDb(db: Db): void {
  db.close();
}

export type { Db };
