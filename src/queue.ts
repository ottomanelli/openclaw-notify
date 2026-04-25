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

// After a failed delivery, how long to wait before the next attempt,
// indexed by `delivery_attempts` after the increment. A channel outage that
// lasts an hour shouldn't require operator action — the row retries on its
// own as backoff elapses. Schedule totals ~3.8 days of coverage, which is
// the span we're willing to spend before declaring the row dead.
const BACKOFF_SCHEDULE_MS: readonly number[] = [
  2 * 60_000,        // attempt 1 failed →  2 min
  10 * 60_000,       // attempt 2 failed → 10 min
  30 * 60_000,       // attempt 3 failed → 30 min
  2 * 3600_000,      // attempt 4 failed →  2 h
  6 * 3600_000,      // attempt 5 failed →  6 h
  12 * 3600_000,     // attempt 6 failed → 12 h
  24 * 3600_000,     // attempt 7 failed → 24 h
  24 * 3600_000,     // attempt 8 failed → 24 h
  24 * 3600_000,     // attempt 9 failed → 24 h
];

// Once `delivery_attempts` reaches this value the row is tombstoned (stamped
// failed_at) and skipped on future ticks. `notify retry --id <n>` or `--all`
// re-enters the row into the queue with a fresh budget. `notify doctor`
// flags non-zero counts.
export const MAX_DELIVERY_ATTEMPTS = BACKOFF_SCHEDULE_MS.length + 1;

// After a failed attempt, how long to wait before the next one. `attempts`
// is the post-increment value (i.e. the count of failures so far). The
// caller converts this to a wall-clock deadline via `now + backoffMs(...)`.
export function backoffMsForAttempts(attempts: number): number {
  const idx = Math.max(0, attempts - 1);
  return BACKOFF_SCHEDULE_MS[Math.min(idx, BACKOFF_SCHEDULE_MS.length - 1)];
}

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
      input.source,
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
  // `next_attempt_at > now` hides rows that are still in backoff after a
  // previous failed delivery — they'll reappear once the deadline elapses.
  return db
    .prepare(
      `SELECT * FROM notifications
       WHERE sent_at IS NULL
         AND failed_at IS NULL
         AND (reserved_at IS NULL OR reserved_at < ? OR reserved_at > ?)
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(staleBefore, now, now, limit) as QueueRow[];
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
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     RETURNING *`,
  );
  return stmt.all(now, ...ids, staleBefore, now, now) as QueueRow[];
}

// Release reservations after a failed delivery. Increments attempts and
// stamps next_attempt_at = now + backoff, so the row will re-enter the
// queue on a later tick once the deadline elapses. Rows that reach
// MAX_DELIVERY_ATTEMPTS are tombstoned (failed_at) so the queue can't
// loop on a permanently-broken row.
export function releaseRows(db: Db, ids: number[]): { retried: number[]; failed: number[] } {
  if (ids.length === 0) return { retried: [], failed: [] };
  const now = Date.now();
  const placeholders = ids.map(() => "?").join(",");

  const tx = db.transaction((idList: number[]) => {
    const rowsAfter = db
      .prepare(
        `UPDATE notifications
         SET reserved_at = NULL,
             delivery_attempts = delivery_attempts + 1
         WHERE id IN (${placeholders})
         RETURNING id, delivery_attempts`,
      )
      .all(...idList) as { id: number; delivery_attempts: number }[];

    const setNext = db.prepare(
      `UPDATE notifications SET next_attempt_at = ? WHERE id = ?`,
    );
    const markFailed = db.prepare(
      `UPDATE notifications
       SET failed_at = ?, next_attempt_at = NULL
       WHERE id = ? AND failed_at IS NULL`,
    );

    const retried: number[] = [];
    const failed: number[] = [];
    for (const r of rowsAfter) {
      if (r.delivery_attempts >= MAX_DELIVERY_ATTEMPTS) {
        markFailed.run(now, r.id);
        failed.push(r.id);
      } else {
        setNext.run(now + backoffMsForAttempts(r.delivery_attempts), r.id);
        retried.push(r.id);
      }
    }
    return { retried, failed };
  });

  return tx(ids);
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

// Reset failed rows so they become eligible again. Clears failed_at,
// delivery_attempts, reserved_at, and next_attempt_at so the row enters
// the next tick exactly as a fresh enqueue would. If `ids` is omitted all
// failed rows are retried. Returns the number of rows touched.
export function retryFailed(db: Db, ids?: number[]): number {
  if (ids && ids.length === 0) return 0;
  if (ids) {
    const placeholders = ids.map(() => "?").join(",");
    const res = db
      .prepare(
        `UPDATE notifications
         SET failed_at = NULL, delivery_attempts = 0, reserved_at = NULL, next_attempt_at = NULL
         WHERE id IN (${placeholders}) AND failed_at IS NOT NULL`,
      )
      .run(...ids);
    return res.changes;
  }
  const res = db
    .prepare(
      `UPDATE notifications
       SET failed_at = NULL, delivery_attempts = 0, reserved_at = NULL, next_attempt_at = NULL
       WHERE failed_at IS NOT NULL`,
    )
    .run();
  return res.changes;
}

export function purge(db: Db, olderThanDays: number): number {
  const cutoff = Date.now() - olderThanDays * 86400_000;
  const result = db
    .prepare(`DELETE FROM notifications WHERE sent_at IS NOT NULL AND sent_at < ?`)
    .run(cutoff);
  return result.changes;
}
