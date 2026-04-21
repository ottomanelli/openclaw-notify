import type { Command } from "commander";
import type { NotifyConfig } from "./types.js";
import { openDb, closeDb } from "./db.js";
import { enqueue, purge } from "./queue.js";

// Caps exist so a rogue consumer can't fill the index with megabyte keys.
const MAX_SOURCE_LEN = 64;
const MAX_CATEGORY_LEN = 64;
const MAX_DEDUP_KEY_LEN = 256;
// Covers data.text, which flows through the LLM prompt AND the template
// fallback AND the channel's send API. 4 KB is well above any legitimate
// reminder payload and well below most channel message limits.
const MAX_TEXT_LEN = 4096;

function checkLen(flag: string, val: string | undefined, max: number): void {
  if (val !== undefined && val.length > max) {
    throw new Error(`--${flag} too long: ${val.length} chars (max ${max})`);
  }
}

export type CliDeps = {
  program: Command;
  dbPath: string;
  config: NotifyConfig;
  tickFn: (opts: { force: boolean; onlyDestination?: string }) => Promise<void>;
};

export function registerNotifyCli(deps: CliDeps): void {
  const { program, dbPath, config } = deps;
  const notify = program.command("notify").description("Notifications queue and delivery");

  notify
    .command("enqueue")
    .description("Enqueue a notification for batched delivery")
    .requiredOption("--source <name>", "Producer id (e.g. todo, calendar)")
    .option("--category <name>", "Optional subtype (e.g. reminder)")
    .requiredOption("--data <json>", "JSON payload with at least a \"text\" field")
    .option("--no-format", "Skip LLM; use template fallback")
    .option("--destination <name>", "Named destination from config", "default")
    .option("--dedup-key <key>", "Stable key; repeat enqueues within window update in place")
    .action(async (opts: {
      source: string;
      category?: string;
      data: string;
      format: boolean;
      destination: string;
      dedupKey?: string;
    }) => {
      if (!(opts.destination in config.destinations)) {
        throw new Error(`Unknown --destination "${opts.destination}". Known: ${Object.keys(config.destinations).join(", ")}`);
      }
      checkLen("source", opts.source, MAX_SOURCE_LEN);
      checkLen("category", opts.category, MAX_CATEGORY_LEN);
      checkLen("dedup-key", opts.dedupKey, MAX_DEDUP_KEY_LEN);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(opts.data);
      } catch (err) {
        throw new Error(`--data must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (typeof parsed.text !== "string" || parsed.text.length === 0) {
        throw new Error(`--data.text is required and must be a non-empty string`);
      }
      if (parsed.text.length > MAX_TEXT_LEN) {
        throw new Error(`--data.text too long: ${parsed.text.length} chars (max ${MAX_TEXT_LEN})`);
      }
      const db = openDb(dbPath);
      try {
        const id = enqueue(
          db,
          {
            source: opts.source,
            category: opts.category ?? null,
            destination: opts.destination,
            rawData: parsed,
            shouldFormat: opts.format !== false,
            dedupKey: opts.dedupKey ?? null,
          },
          { dedupWindowMin: config.dedupWindowMin },
        );
        console.log(String(id));
      } finally {
        closeDb(db);
      }
    });

  notify
    .command("send")
    .description("Flush pending notifications now (respects quiet hours unless --force)")
    .option("--force", "Bypass quiet-hours check", false)
    .option("--destination <name>", "Limit to a single destination")
    .action(async (opts: { force: boolean; destination?: string }) => {
      if (opts.destination && !(opts.destination in config.destinations)) {
        throw new Error(`Unknown --destination "${opts.destination}"`);
      }
      await deps.tickFn({ force: !!opts.force, onlyDestination: opts.destination });
    });

  notify
    .command("list")
    .description("List queue rows (pending only by default)")
    .option("--all", "Include sent and failed rows")
    .option("--failed", "Only rows that exceeded the retry budget")
    .action(async (opts: { all?: boolean; failed?: boolean }) => {
      const db = openDb(dbPath);
      try {
        let sql: string;
        if (opts.failed) {
          sql = "SELECT * FROM notifications WHERE failed_at IS NOT NULL ORDER BY failed_at ASC";
        } else if (opts.all) {
          sql = "SELECT * FROM notifications ORDER BY created_at ASC";
        } else {
          sql = "SELECT * FROM notifications WHERE sent_at IS NULL AND failed_at IS NULL ORDER BY created_at ASC";
        }
        const rows = db.prepare(sql).all();
        console.log(JSON.stringify(rows, null, 2));
      } finally {
        closeDb(db);
      }
    });

  notify
    .command("purge")
    .description("Delete sent rows older than a duration (e.g. 30d)")
    .requiredOption("--older-than <duration>", "e.g. 30d, 14d, 7d")
    .action(async (opts: { olderThan: string }) => {
      const days = parseDurationToDays(opts.olderThan);
      const db = openDb(dbPath);
      try {
        const deleted = purge(db, days);
        console.log(`deleted ${deleted}`);
      } finally {
        closeDb(db);
      }
    });
}

function parseDurationToDays(input: string): number {
  const match = input.trim().toLowerCase().match(/^(\d+)([dhw])$/);
  if (!match) throw new Error(`Invalid duration "${input}". Expected form: 30d, 12h, 2w`);
  const n = Number(match[1]);
  let days: number;
  switch (match[2]) {
    case "d": days = n; break;
    case "h": days = n / 24; break;
    case "w": days = n * 7; break;
    default:  throw new Error("unreachable");
  }
  // Reject 0d / 0h / 0w — those would purge everything sent, which is almost
  // never the intent and if it is the user can pass 1h to nearly the same effect.
  if (days <= 0) {
    throw new Error(`Invalid duration "${input}": must be positive (e.g. 1d, 12h, 1w)`);
  }
  return days;
}
