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
  // Idempotent column upgrades for installs predating later schema
  // revisions. CREATE TABLE IF NOT EXISTS won't add new columns to an
  // existing table, so each column added after the initial publish needs
  // its own ALTER. Order matters: keep the earliest-added column first.
  const existing = new Set(
    (db.pragma("table_info(notifications)") as Array<{ name: string }>).map((c) => c.name),
  );
  const COLUMN_UPGRADES: Array<{ name: string; ddl: string }> = [
    { name: "delivery_attempts", ddl: "ALTER TABLE notifications ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0" },
    { name: "failed_at", ddl: "ALTER TABLE notifications ADD COLUMN failed_at INTEGER" },
    { name: "next_attempt_at", ddl: "ALTER TABLE notifications ADD COLUMN next_attempt_at INTEGER" },
  ];
  for (const u of COLUMN_UPGRADES) {
    if (!existing.has(u.name)) db.exec(u.ddl);
  }
  // Index upgrade: the dedup index used to be (dedup_key, sent_at) before
  // we scoped dedup to (source, dedup_key, destination). CREATE INDEX IF
  // NOT EXISTS won't replace an index of the same name with a different
  // shape, so detect drift and DROP+recreate.
  const dedupCols = (db.pragma("index_info(idx_notifications_dedup)") as Array<{ name: string }>).map((c) => c.name);
  const wantedDedup = ["source", "dedup_key", "destination", "sent_at"];
  const dedupOutdated = dedupCols.length > 0 &&
    (dedupCols.length !== wantedDedup.length || dedupCols.some((c, i) => c !== wantedDedup[i]));
  if (dedupOutdated) {
    db.exec("DROP INDEX idx_notifications_dedup");
    db.exec("CREATE INDEX idx_notifications_dedup ON notifications (source, dedup_key, destination, sent_at)");
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
