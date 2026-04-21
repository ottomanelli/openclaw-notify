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
): Promise<void> {
  if (!opts.force && nowInQuietHours(cfg.quietHours)) {
    logger.debug("notify: quiet hours — skipping tick");
    return;
  }

  const rows = getPending(db);
  if (rows.length === 0) return;

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
        const result = await deliver(runtime, destCfg, message);
        if (result.ok) {
          markSent(db, claimedIds);
        } else {
          const { failed } = releaseRows(db, claimedIds);
          logger.warn(`notify: delivery to "${destName}" failed (${claimed.length} rows): ${result.error}`);
          if (failed.length > 0) {
            logger.error(
              `notify: ${failed.length} row(s) exceeded max delivery attempts for "${destName}" and were moved to failed state (ids: ${failed.join(", ")})`,
            );
          }
        }
      } catch (err) {
        const { failed } = releaseRows(db, claimedIds);
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
}
