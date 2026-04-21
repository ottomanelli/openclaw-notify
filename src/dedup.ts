import type { Db } from "./db.js";

export type DedupOpts = {
  dedupWindowMin: number;
};

// A row with a live reservation is excluded (it's mid-delivery — mutating it
// would change a payload in flight). But a reservation that's past the
// staleness window belongs to a crashed tick, so it's safe to fold into.
// Without this, a crashed tick + fresh enqueue under the same dedup key
// produces two rows and two deliveries after the stale reservation is
// reclaimed.
export function findActiveDedupRow(
  db: Db,
  dedupKey: string,
  destination: string,
  windowMs: number,
  reservationTimeoutMs: number,
): { id: number } | null {
  const now = Date.now();
  const cutoff = now - windowMs;
  const staleBefore = now - reservationTimeoutMs;
  return db
    .prepare(
      `SELECT id FROM notifications
       WHERE dedup_key = ? AND destination = ?
         AND sent_at IS NULL
         AND failed_at IS NULL
         AND (reserved_at IS NULL OR reserved_at < ? OR reserved_at > ?)
         AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(dedupKey, destination, staleBefore, now, cutoff) as { id: number } | undefined ?? null;
}

export function updateDedupRow(
  db: Db,
  id: number,
  rawDataJson: string,
): void {
  // Reset delivery_attempts so a fresh enqueue gets a fresh retry budget;
  // folding into a crash-recovered row shouldn't inherit its attempt count.
  db.prepare(
    `UPDATE notifications
     SET raw_data = ?, created_at = ?, delivery_attempts = 0, reserved_at = NULL
     WHERE id = ?`,
  ).run(rawDataJson, Date.now(), id);
}
