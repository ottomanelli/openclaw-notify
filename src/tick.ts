import type { Db } from "./db.js";
import { getPending, markSent, claimRows, releaseRows } from "./queue.js";
import { nowInQuietHours } from "./schedule.js";
import { formatBatch, renderTemplate } from "./format.js";
import { deliver } from "./deliver.js";
import type { NotifyConfig, QueueRow, Destination, RuntimeBridge } from "./types.js";

export type TickLogger = {
  debug(m: string): void;
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
};

export type TickOptions = {
  force?: boolean;
  onlyDestination?: string;
  activeDestinations?: Set<string>;
};

export type TickResult = {
  // "quiet-hours": the window blocked the tick (only when force=false).
  // "no-rows": nothing pending. Included so callers can tell "nothing to do"
  // from "quiet hours silenced you."
  // undefined: at least one destination was attempted.
  skipped?: "quiet-hours" | "no-rows";
  delivered: number;        // rows stamped sent_at this tick
  failedTransient: number;  // rows released for retry on the next tick
  failedTerminal: number;   // rows that crossed MAX_DELIVERY_ATTEMPTS
};

// Throttle per destination-name so a misconfigured destination doesn't spam
// one warning per tick. A 10-minute floor matches the validation-error
// throttle in index.ts.
const DEST_WARN_THROTTLE_MS = 10 * 60_000;
const lastDestWarnAt = new Map<string, number>();
function maybeWarn(logger: TickLogger, key: string, message: string): void {
  const now = Date.now();
  const last = lastDestWarnAt.get(key) ?? 0;
  if (now - last < DEST_WARN_THROTTLE_MS) return;
  lastDestWarnAt.set(key, now);
  logger.warn(message);
}

export async function tick(
  db: Db,
  cfg: NotifyConfig,
  runtime: RuntimeBridge,
  logger: TickLogger,
  opts: TickOptions = {},
): Promise<TickResult> {
  const result: TickResult = { delivered: 0, failedTransient: 0, failedTerminal: 0 };

  if (!opts.force && nowInQuietHours(cfg.quietHours)) {
    logger.debug("notify: quiet hours — skipping tick");
    return { ...result, skipped: "quiet-hours" };
  }

  const rows = getPending(db);
  if (rows.length === 0) return { ...result, skipped: "no-rows" };

  const groups = new Map<string, QueueRow[]>();
  for (const r of rows) {
    if (opts.onlyDestination && r.destination !== opts.onlyDestination) continue;
    const list = groups.get(r.destination) ?? [];
    list.push(r);
    groups.set(r.destination, list);
  }

  for (const [destName, group] of groups) {
    const destCfg: Destination | undefined = cfg.destinations[destName];
    if (!destCfg) {
      maybeWarn(
        logger,
        `unknown:${destName}`,
        `notify: unknown destination "${destName}" (${group.length} rows); leaving unsent`,
      );
      continue;
    }
    if (opts.activeDestinations && !opts.activeDestinations.has(destName)) {
      maybeWarn(
        logger,
        `inactive:${destName}`,
        `notify: destination "${destName}" channel not registered (${group.length} rows); leaving unsent`,
      );
      continue;
    }

    const formatBatches: { rows: QueueRow[]; useLlm: boolean }[] = [
      { rows: group.filter((r) => r.should_format === 1), useLlm: true },
      { rows: group.filter((r) => r.should_format === 0), useLlm: false },
    ].filter((b) => b.rows.length > 0);

    for (const batch of formatBatches) {
      // Atomic claim: returns only rows this tick actually reserved AND
      // their current raw_data (in case a concurrent dedup updated it
      // between getPending and here).
      const claimed = claimRows(db, batch.rows.map((r) => r.id));
      if (claimed.length === 0) continue;
      if (claimed.length < batch.rows.length) {
        logger.debug(
          `notify: ${batch.rows.length - claimed.length}/${batch.rows.length} rows for "${destName}" claimed elsewhere`,
        );
      }
      const claimedIds = claimed.map((r) => r.id);
      try {
        const message = batch.useLlm
          ? await formatBatch(runtime, claimed, cfg.llm, cfg.personality, { channel: destCfg.channel, logger })
          : renderTemplate(claimed, destCfg.channel);
        const deliveryResult = await deliver(runtime, destCfg, message);
        if (deliveryResult.ok) {
          markSent(db, claimedIds);
          result.delivered += claimedIds.length;
        } else {
          const { retried, failed } = releaseRows(db, claimedIds);
          result.failedTransient += retried.length;
          result.failedTerminal += failed.length;
          logger.warn(`notify: delivery to "${destName}" failed (${claimed.length} rows): ${deliveryResult.error}`);
          if (failed.length > 0) {
            logger.error(
              `notify: ${failed.length} row(s) exceeded max delivery attempts for "${destName}" and were moved to failed state (ids: ${failed.join(", ")})`,
            );
          }
        }
      } catch (err) {
        const { retried, failed } = releaseRows(db, claimedIds);
        result.failedTransient += retried.length;
        result.failedTerminal += failed.length;
        logger.warn(
          `notify: tick batch threw for "${destName}" (${claimed.length} rows): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (failed.length > 0) {
          logger.error(
            `notify: ${failed.length} row(s) exceeded max delivery attempts for "${destName}" and were moved to failed state (ids: ${failed.join(", ")})`,
          );
        }
      }
    }
  }
  return result;
}
