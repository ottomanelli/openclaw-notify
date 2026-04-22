import type { Command } from "commander";
import type { NotifyConfig, RuntimeBridge } from "./types.js";
import { openDb, closeDb } from "./db.js";
import { enqueue, purge } from "./queue.js";
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
    const pending = db
      .prepare(
        "SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM notifications WHERE sent_at IS NULL AND failed_at IS NULL",
      )
      .get() as { c: number; oldest: number | null };
    const failed = db
      .prepare("SELECT COUNT(*) AS c FROM notifications WHERE failed_at IS NOT NULL")
      .get() as { c: number };
    let queueLine = `queue: ${pending.c} pending, ${failed.c} failed`;
    if (pending.oldest != null) {
      const ageMin = Math.round((Date.now() - pending.oldest) / 60_000);
      queueLine += `, oldest pending ${ageMin}m old`;
    }
    // Warn (not fail) if failed rows exist — the queue is still operational,
    // but the operator should know they're accumulating.
    const marker = failed.c > 0 ? "•" : "✓";
    lines.push(`${marker} ${queueLine}`);
    if (failed.c > 0) lines.push(`  → run "openclaw notify list --failed" to inspect`);
  } finally {
    closeDb(db);
  }

  return { ok, lines };
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
