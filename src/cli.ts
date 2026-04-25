import type { Command } from "commander";
import type { NotifyConfig, RuntimeBridge } from "./types.js";
import { openDb, closeDb } from "./db.js";
import { enqueue, purge, retryFailed } from "./queue.js";
import type { TickResult } from "./tick.js";
import { callLlm, selectProviderAndModel } from "./format.js";
import { SEND_FN_BY_CHANNEL } from "./validate.js";

// Caps exist so a rogue consumer can't fill the index with megabyte keys.
const MAX_SOURCE_LEN = 64;
const MAX_CATEGORY_LEN = 64;
const MAX_DEDUP_KEY_LEN = 256;
// Covers data.text, which flows through the LLM prompt AND the template
// fallback AND the channel's send API. 4 KB is well above any legitimate
// reminder payload and well below most channel message limits.
const MAX_TEXT_LEN = 4096;
// Hard cap on the full --data JSON string before parsing. Stops a rogue
// consumer from shoving megabytes of extra fields alongside a short `text`
// and growing the DB indefinitely (only `text` flows through delivery, but
// the whole payload is persisted in raw_data).
const MAX_DATA_JSON_LEN = 8192;

function checkLen(flag: string, val: string | undefined, max: number): void {
  if (val !== undefined && val.length > max) {
    throw new Error(`--${flag} too long: ${val.length} chars (max ${max})`);
  }
}

export type CliDeps = {
  program: Command;
  dbPath: string;
  config: NotifyConfig;
  tickFn: (opts: { force: boolean; onlyDestination?: string }) => Promise<TickResult | void>;
  runtime: RuntimeBridge;
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
      if (opts.data.length > MAX_DATA_JSON_LEN) {
        throw new Error(`--data too long: ${opts.data.length} chars (max ${MAX_DATA_JSON_LEN})`);
      }
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
      const r = await deps.tickFn({ force: !!opts.force, onlyDestination: opts.destination });
      // If the plugin entrypoint short-circuited (e.g. destinations failed to
      // validate), we get void — print something so `notify send` is never
      // silent.
      if (!r) {
        console.log("no tick ran (destinations unvalidated; check logs)");
        return;
      }
      if (r.skipped === "quiet-hours") {
        console.log("skipped: quiet hours (pass --force to override)");
      } else if (r.skipped === "no-rows") {
        // "no-rows" only means the tick found nothing READY — rows that are
        // backing off after a prior failed delivery are hidden by getPending.
        // Silently saying "no pending rows" when the queue actually has
        // retrying rows would mislead an operator investigating "why didn't
        // my alert fire?", so surface the count and the next deadline.
        const db = openDb(dbPath);
        try {
          const now = Date.now();
          const row = db
            .prepare(
              `SELECT COUNT(*) AS c, MIN(next_attempt_at) AS nextAt
               FROM notifications
               WHERE sent_at IS NULL AND failed_at IS NULL AND next_attempt_at > ?`,
            )
            .get(now) as { c: number; nextAt: number | null };
          if (row.c > 0 && row.nextAt != null) {
            console.log(`no pending rows (${row.c} backing off, next in ${formatRelativeMs(row.nextAt - now)})`);
          } else {
            console.log("no pending rows");
          }
        } finally {
          closeDb(db);
        }
      } else {
        const parts = [`delivered ${r.delivered}`];
        if (r.failedTransient > 0) parts.push(`failed ${r.failedTransient} (will retry)`);
        if (r.failedTerminal > 0) parts.push(`failed ${r.failedTerminal} (exceeded retry budget)`);
        console.log(parts.join(", "));
      }
    });

  notify
    .command("retry")
    .description("Reset rows stamped failed_at so the next tick will re-deliver")
    .option("--id <n>", "Only retry this id")
    .option("--all", "Retry every failed row", false)
    .action(async (opts: { id?: string; all?: boolean }) => {
      if (!opts.id && !opts.all) {
        throw new Error("notify retry: pass --id <n> or --all");
      }
      const db = openDb(dbPath);
      try {
        if (opts.id) {
          const n = Number(opts.id);
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error(`--id must be a positive integer, got "${opts.id}"`);
          }
          const changed = retryFailed(db, [n]);
          console.log(changed === 1 ? `retried ${n}` : `no failed row with id ${n}`);
        } else {
          const changed = retryFailed(db);
          console.log(`retried ${changed}`);
        }
      } finally {
        closeDb(db);
      }
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

  notify
    .command("doctor")
    .description("Probe config, destinations, LLM provider, and queue health")
    .option("--skip-llm", "Skip the live LLM probe (no API call)", false)
    .action(async (opts: { skipLlm?: boolean }) => {
      const report = await runDoctor({
        dbPath,
        config: deps.config,
        runtime: deps.runtime,
        skipLlm: !!opts.skipLlm,
      });
      for (const line of report.lines) console.log(line);
      // Non-zero exit when something is unhealthy so `notify doctor` composes
      // with shell scripts, CI, and systemd `ExecStartPre=`.
      if (!report.ok) process.exitCode = 1;
    });
}

type DoctorReport = { ok: boolean; lines: string[] };

// Extracted so tests can call it without going through commander and stdout.
export async function runDoctor(params: {
  dbPath: string;
  config: NotifyConfig;
  runtime: RuntimeBridge;
  skipLlm: boolean;
  fetchFn?: typeof fetch;
}): Promise<DoctorReport> {
  const { dbPath, config, runtime, skipLlm, fetchFn = fetch } = params;
  const lines: string[] = [];
  let ok = true;

  // Config was already parsed by the plugin entrypoint — if we got here, it's valid.
  lines.push("✓ config: valid");

  for (const [name, dest] of Object.entries(config.destinations)) {
    const fnName = SEND_FN_BY_CHANNEL[dest.channel];
    const ns = (runtime.channel as Record<string, unknown>)[dest.channel] as
      | Record<string, unknown>
      | undefined;
    if (ns && typeof ns[fnName] === "function") {
      lines.push(`✓ destination "${name}": ${dest.channel} channel registered`);
    } else {
      lines.push(`✗ destination "${name}": ${dest.channel} channel NOT registered`);
      ok = false;
    }
  }

  if (!config.llm.enabled) {
    lines.push("- llm: disabled (template fallback only)");
  } else if (skipLlm) {
    lines.push("- llm: probe skipped (--skip-llm)");
  } else {
    const resolved = await selectProviderAndModel(runtime, config.llm);
    if (!resolved) {
      lines.push("✗ llm: no provider has an API key — batches will use template fallback");
      ok = false;
    } else {
      // Tiny throwaway prompt: < 10 tokens each way, effectively free on
      // every metered provider but still exercises the real URL, auth,
      // and response-parsing path.
      try {
        const started = Date.now();
        const out = await callLlm(resolved, "Respond with a single word.", "ping", fetchFn);
        const ms = Date.now() - started;
        const snippet = out.trim().replace(/\s+/g, " ").slice(0, 40);
        lines.push(`✓ llm: ${resolved.provider}/${resolved.model} — responded in ${ms}ms ("${snippet}")`);
      } catch (err) {
        lines.push(
          `✗ llm: ${resolved.provider}/${resolved.model} — ${err instanceof Error ? err.message : String(err)}`,
        );
        ok = false;
      }
    }
  }

  const db = openDb(dbPath);
  try {
    const now = Date.now();
    const stats = db
      .prepare(
        `SELECT
           SUM(CASE WHEN sent_at IS NULL AND failed_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?) THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN sent_at IS NULL AND failed_at IS NULL AND next_attempt_at > ? THEN 1 ELSE 0 END) AS backingOff,
           SUM(CASE WHEN failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed,
           MIN(CASE WHEN sent_at IS NULL AND failed_at IS NULL THEN created_at END) AS oldest
         FROM notifications`,
      )
      .get(now, now) as { pending: number | null; backingOff: number | null; failed: number | null; oldest: number | null };
    const pending = stats.pending ?? 0;
    const backingOff = stats.backingOff ?? 0;
    const failed = stats.failed ?? 0;
    let queueLine = `queue: ${pending} pending`;
    if (backingOff > 0) queueLine += ` (${backingOff} backing off)`;
    queueLine += `, ${failed} failed`;
    if (stats.oldest != null) {
      const ageMin = Math.round((now - stats.oldest) / 60_000);
      queueLine += `, oldest pending ${ageMin}m old`;
    }
    // Warn (not fail) if failed rows exist — the queue is still operational,
    // but the operator should know they're accumulating.
    const marker = failed > 0 ? "•" : "✓";
    lines.push(`${marker} ${queueLine}`);
    if (failed > 0) lines.push(`  → run "openclaw notify list --failed" to inspect, then "notify retry" or delete`);

    // Orphan check: rows pinned to a destination the config no longer
    // defines. Those rows will never deliver until the destination comes
    // back or an operator reroutes them.
    const stranded = db
      .prepare(
        `SELECT destination, COUNT(*) AS c
         FROM notifications
         WHERE sent_at IS NULL
         GROUP BY destination`,
      )
      .all() as { destination: string; c: number }[];
    const orphans = stranded.filter((r) => !(r.destination in config.destinations));
    if (orphans.length > 0) {
      ok = false;
      for (const o of orphans) {
        lines.push(`✗ ${o.c} unsent row(s) bound to unknown destination "${o.destination}" (not in current config)`);
      }
    }
  } finally {
    closeDb(db);
  }

  return { ok, lines };
}

// Compact human-readable relative duration — "45s", "8m", "2h", "1h15m".
// Minutes-granularity past a minute (sub-minute precision isn't useful for a
// backoff deadline an operator is eyeballing), hours with remainder minutes
// once it tips past an hour.
function formatRelativeMs(ms: number): string {
  if (ms <= 0) return "now";
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${hr}h` : `${hr}h${rem}m`;
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
