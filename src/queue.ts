import type { Db } from "./db.js";
import type { QueueRow } from "./types.js";
import { findActiveDedupRow, updateDedupRow, type DedupOpts } from "./dedup.js";

// Cap per tick so a backed-up queue (e.g. after a long outage) can't blow
// out an LLM context window or SMS the entire backlog in one message.
export const MAX_PER_TICK = 50;

// Rows whose reserved_at is older than this are treated as abandoned — the
// tick that claimed them crashed before markSent/releaseRows could run.
// Longer than any legitimate tick (seconds) but short enough to recover
// quickly from a gateway crash.
export const RESERVATION_TIMEOUT_MS = 10 * 60_000;

// After this many failed delivery attempts, a row goes to the terminal
// "failed" state. Prevents an LLM output that consistently trips a channel's
// markdown parser from looping forever and blocking the queue. Operator can
// inspect via `notify list --failed`.
export const MAX_DELIVERY_ATTEMPTS = 5;

export type EnqueueInput = {
  source: string;
  category: string | null;
  destination: string;
  rawData: Record<string, unknown>;
  shouldFormat: boolean;
  dedupKey: string | null;
};

export function enqueue(db: Db, input: EnqueueInput, opts?: DedupOpts): number {
  const rawDataJson = JSON.stringify(input.rawData);

  if (input.dedupKey && opts && opts.dedupWindowMin > 0) {
    const windowMs = opts.dedupWindowMin * 60_000;
    const existing = findActiveDedupRow(
      db,
      input.dedupKey,
      input.destination,
      windowMs,
      RESERVATION_TIMEOUT_MS,
    );
    if (existing) {
      updateDedupRow(db, existing.id, rawDataJson);
      return existing.id;
    }
  }

  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO notifications (source, category, destination, raw_data, should_format, dedup_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.source,
    input.category,
    input.destination,
    rawDataJson,
    input.shouldFormat ? 1 : 0,
    input.dedupKey,
    now,
  );
  return Number(result.lastInsertRowid);
}

export function getPending(db: Db, limit: number = MAX_PER_TICK): QueueRow[] {
  const now = Date.now();
  const staleBefore = now - RESERVATION_TIMEOUT_MS;
  // `reserved_at > now` covers a backward clock jump (NTP correction, VM
  // restore) that would otherwise leave a row stuck until wall time catches
  // up to its old reservation timestamp.
  return db
    .prepare(
      `SELECT * FROM notifications
       WHERE sent_at IS NULL
         AND failed_at IS NULL
         AND (reserved_at IS NULL OR reserved_at < ? OR reserved_at > ?)
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(staleBefore, now, limit) as QueueRow[];
}

// Atomically claim rows and return their current contents.
//
// This closes three races that a separate SELECT + UPDATE cannot:
//   1. A concurrent dedup enqueue can mutate raw_data between a read and
//      a later reserve. RETURNING gives us the post-claim snapshot.
//   2. Two tick processes both reading the same pending set both try to
//      reserve — only the rows actually updated (reserved_at was NULL
//      or stale) come back; the caller must not deliver rows it didn't
//      claim.
//   3. A prior tick that crashed between claim and markSent left its
//      rows reserved forever. Rows with reserved_at older than the
//      timeout are eligible for re-claim.
export function claimRows(db: Db, ids: number[]): QueueRow[] {
  if (ids.length === 0) return [];
  const now = Date.now();
  const staleBefore = now - RESERVATION_TIMEOUT_MS;
  const placeholders = ids.map(() => "?").join(",");
  const stmt = db.prepare(
    `UPDATE notifications SET reserved_at = ?
     WHERE id IN (${placeholders})
       AND sent_at IS NULL
       AND failed_at IS NULL
       AND (reserved_at IS NULL OR reserved_at < ? OR reserved_at > ?)
     RETURNING *`,
  );
  return stmt.all(now, ...ids, staleBefore, now) as QueueRow[];
}

// Release reservations after a failed delivery. Increments attempts; if a
// row has now exceeded the max it's stamped `failed_at` so subsequent ticks
// skip it. Returns the ids that exceeded the cap so the caller can log.
export function releaseRows(db: Db, ids: number[]): { retried: number[]; failed: number[] } {
  if (ids.length === 0) return { retried: [], failed: [] };
  const now = Date.now();
  const placeholders = ids.map(() => "?").join(",");
  const incrementStmt = db.prepare(
    `UPDATE notifications
     SET reserved_at = NULL,
         delivery_attempts = delivery_attempts + 1
     WHERE id IN (${placeholders})`,
  );
  const markFailedStmt = db.prepare(
    `UPDATE notifications
     SET failed_at = ?
     WHERE id IN (${placeholders}) AND delivery_attempts >= ? AND failed_at IS NULL
     RETURNING id`,
  );
  const tx = db.transaction((idList: number[]) => {
    incrementStmt.run(...idList);
    return markFailedStmt.all(now, ...idList, MAX_DELIVERY_ATTEMPTS) as { id: number }[];
  });
  const failedRows = tx(ids);
  const failed = failedRows.map((r) => r.id);
  const failedSet = new Set(failed);
  return { retried: ids.filter((id) => !failedSet.has(id)), failed };
}

export function markSent(db: Db, ids: number[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const placeholders = ids.map(() => "?").join(",");
  const stmt = db.prepare(`UPDATE notifications SET sent_at = ? WHERE id IN (${placeholders})`);
  const tx = db.transaction((idList: number[]) => {
    stmt.run(now, ...idList);
  });
  tx(ids);
}

export function purge(db: Db, olderThanDays: number): number {
  const cutoff = Date.now() - olderThanDays * 86400_000;
  const result = db
    .prepare(`DELETE FROM notifications WHERE sent_at IS NOT NULL AND sent_at < ?`)
    .run(cutoff);
  return result.changes;
}
