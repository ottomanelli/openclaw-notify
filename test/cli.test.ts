import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import { registerNotifyCli, runDoctor, type CliDeps } from "../src/cli.js";
import { openDb, closeDb } from "../src/db.js";
import { enqueue } from "../src/queue.js";
import type { TickResult } from "../src/tick.js";
import type { NotifyConfig } from "../src/types.js";

let tmpDir: string;

function baseConfig(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
  return {
    tickIntervalSec: 300,
    destinations: {
      default: { channel: "telegram", chatId: "d1", threadId: null },
      work: { channel: "slack", chatId: "#alerts", threadId: null },
    },
    quietHours: null,
    llm: { enabled: false, provider: null, model: null },
    personality: null,
    dedupWindowMin: 15,
    ...overrides,
  };
}

function defaultRuntime() {
  return {
    modelAuth: { resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: undefined })) },
    channel: {
      telegram: { sendMessageTelegram: vi.fn(async () => ({ messageId: "m" })) },
      slack: { sendMessageSlack: vi.fn(async () => ({ messageId: "m" })) },
      discord: { sendMessageDiscord: vi.fn(async () => ({ messageId: "m" })) },
      signal: { sendMessageSignal: vi.fn(async () => ({ messageId: "m" })) },
      imessage: { sendMessageIMessage: vi.fn(async () => ({ messageId: "m" })) },
    },
  };
}

function setup(
  cfg: NotifyConfig,
  runtime: ReturnType<typeof defaultRuntime> = defaultRuntime(),
  tickReturn: TickResult | void = undefined,
  remote: Pick<CliDeps, "flushRemote" | "doctorRemote"> = {},
) {
  const program = new Command();
  program.exitOverride();
  const tickFn = vi.fn(async (): Promise<TickResult | void> => tickReturn);
  registerNotifyCli({
    program,
    dbPath: path.join(tmpDir, "notifications.db"),
    config: cfg,
    tickFn,
    runtime: runtime as never,
    ...remote,
  });
  return { program, tickFn, runtime };
}

function captureStderr() {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return {
    lines,
    restore: () => { console.error = orig; },
  };
}

function captureStdout() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return {
    lines,
    restore: () => { console.log = orig; },
  };
}

describe("cli enqueue", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-cli-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inserts a row and prints its id", async () => {
    const { program } = setup(baseConfig());
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await program.parseAsync([
        "node", "cli",
        "notify", "enqueue",
        "--source", "todo",
        "--category", "reminder",
        "--data", JSON.stringify({ text: "Buy beans", priority: "high" }),
      ]);
    } finally {
      console.log = origLog;
    }
    expect(logs.join("\n")).toMatch(/^\d+$/m);
  });

  it("rejects bad JSON in --data", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync(["node", "cli", "notify", "enqueue", "--source", "s", "--data", "not-json"]),
    ).rejects.toThrow();
  });

  it("rejects unknown --destination", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "s",
        "--data", JSON.stringify({ text: "x" }),
        "--destination", "ghost",
      ]),
    ).rejects.toThrow(/destination/i);
  });

  it("rejects --source over the length cap", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "x".repeat(300),
        "--data", JSON.stringify({ text: "x" }),
      ]),
    ).rejects.toThrow(/source/i);
  });

  it("rejects --category over the length cap", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "s",
        "--category", "x".repeat(300),
        "--data", JSON.stringify({ text: "x" }),
      ]),
    ).rejects.toThrow(/category/i);
  });

  it("rejects --dedup-key over the length cap", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "s",
        "--data", JSON.stringify({ text: "x" }),
        "--dedup-key", "x".repeat(500),
      ]),
    ).rejects.toThrow(/dedup-key/i);
  });

  it("rejects --data.text over the length cap (prevents multi-MB payloads)", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "s",
        "--data", JSON.stringify({ text: "x".repeat(5000) }),
      ]),
    ).rejects.toThrow(/text/i);
  });

  it("rejects --data over the total JSON length cap (defends against giant extra fields)", async () => {
    const { program } = setup(baseConfig());
    // Short `text` to get past the text-length check, but a huge sibling
    // field that would bloat raw_data if we didn't cap the whole JSON.
    const big = JSON.stringify({ text: "ok", blob: "x".repeat(10_000) });
    await expect(
      program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "s",
        "--data", big,
      ]),
    ).rejects.toThrow(/data too long/i);
  });

  it("--no-format sets should_format=0", async () => {
    const { program } = setup(baseConfig());
    const origLog = console.log;
    console.log = () => {};
    try {
      await program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "s",
        "--data", JSON.stringify({ text: "x" }),
        "--no-format",
      ]);
    } finally {
      console.log = origLog;
    }
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path.join(tmpDir, "notifications.db"));
    const rows = db.prepare("SELECT should_format FROM notifications").all() as { should_format: number }[];
    expect(rows[0]?.should_format).toBe(0);
    db.close();
  });
});

describe("cli send", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-send-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls tickFn with force=false by default", async () => {
    const { program, tickFn } = setup(baseConfig());
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send"]); } finally { cap.restore(); }
    expect(tickFn).toHaveBeenCalledWith({ force: false, onlyDestination: undefined });
  });

  it("passes --force", async () => {
    const { program, tickFn } = setup(baseConfig());
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send", "--force"]); } finally { cap.restore(); }
    expect(tickFn).toHaveBeenCalledWith({ force: true, onlyDestination: undefined });
  });

  it("passes --destination", async () => {
    const { program, tickFn } = setup(baseConfig());
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send", "--destination", "work"]); } finally { cap.restore(); }
    expect(tickFn).toHaveBeenCalledWith({ force: false, onlyDestination: "work" });
  });

  it("passes --source and --category", async () => {
    const { program, tickFn } = setup(baseConfig());
    const cap = captureStdout();
    try {
      await program.parseAsync(["node", "cli", "notify", "send", "--source", "calendar", "--category", "day_reminders"]);
    } finally { cap.restore(); }
    expect(tickFn).toHaveBeenCalledWith({
      force: false, onlyDestination: undefined, onlySource: "calendar", onlyCategory: "day_reminders",
    });
  });

  it("rejects unknown --destination on send", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync(["node", "cli", "notify", "send", "--destination", "ghost"]),
    ).rejects.toThrow(/destination/i);
  });

  it("prints a delivered/failed summary", async () => {
    const { program } = setup(baseConfig(), defaultRuntime(), {
      delivered: 3, failedTransient: 1, failedTerminal: 0,
    });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send"]); } finally { cap.restore(); }
    const out = cap.lines.join("\n");
    expect(out).toMatch(/delivered 3/);
    expect(out).toMatch(/failed 1 \(will retry\)/);
  });

  it("flags terminal failures distinctly from transient ones", async () => {
    const { program } = setup(baseConfig(), defaultRuntime(), {
      delivered: 0, failedTransient: 0, failedTerminal: 2,
    });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send"]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toMatch(/failed 2 \(exceeded retry budget\)/);
  });

  it("reports 'skipped: quiet hours' when the tick was blocked", async () => {
    const { program } = setup(baseConfig(), defaultRuntime(), {
      delivered: 0, failedTransient: 0, failedTerminal: 0, skipped: "quiet-hours",
    });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send"]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toMatch(/quiet hours/);
  });

  it("reports 'no pending rows' when the queue was empty", async () => {
    const { program } = setup(baseConfig(), defaultRuntime(), {
      delivered: 0, failedTransient: 0, failedTerminal: 0, skipped: "no-rows",
    });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send"]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toEqual("no pending rows");
  });

  it("surfaces backing-off rows in the 'no pending' message", async () => {
    // A row with next_attempt_at > now looks like an empty queue to getPending
    // (and so tick returns skipped: "no-rows"), but the send summary should
    // tell the operator a retry is pending rather than silently lying.
    const dbPath = path.join(tmpDir, "notifications.db");
    const db = openDb(dbPath);
    try {
      enqueue(db, {
        source: "a", category: null, destination: "default",
        rawData: { text: "x" }, shouldFormat: false, dedupKey: null,
      });
      db.prepare("UPDATE notifications SET next_attempt_at = ? WHERE id = 1")
        .run(Date.now() + 8 * 60_000);
    } finally {
      closeDb(db);
    }
    const { program } = setup(baseConfig(), defaultRuntime(), {
      delivered: 0, failedTransient: 0, failedTerminal: 0, skipped: "no-rows",
    });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send"]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toMatch(/no pending rows \(1 backing off, next in \d+m\)/);
  });

  it("counts only the chosen source's backing-off rows when --source is given", async () => {
    const dbPath = path.join(tmpDir, "notifications.db");
    const db = openDb(dbPath);
    try {
      enqueue(db, {
        source: "todo", category: null, destination: "default",
        rawData: { text: "x" }, shouldFormat: true, dedupKey: null,
      });
      db.prepare("UPDATE notifications SET next_attempt_at = ? WHERE id = 1")
        .run(Date.now() + 8 * 60_000);
    } finally {
      closeDb(db);
    }
    const { program } = setup(baseConfig(), defaultRuntime(), {
      delivered: 0, failedTransient: 0, failedTerminal: 0, skipped: "no-rows",
    });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send", "--source", "calendar"]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toEqual("no pending rows");
  });

  it("prints a 'no tick ran' hint when the plugin short-circuited", async () => {
    const { program } = setup(baseConfig());  // default tickFn returns void
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send"]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toMatch(/no tick ran/);
  });
});

describe("cli send through the running Gateway", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-send-gw-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const counts: TickResult = { delivered: 2, failedTransient: 0, failedTerminal: 0 };

  it("asks the Gateway, prints its counts, and does nothing in this process", async () => {
    const flushRemote = vi.fn(async () => ({ answered: true as const, value: counts }));
    const { program, tickFn } = setup(baseConfig(), defaultRuntime(), undefined, { flushRemote });
    const cap = captureStdout();
    try {
      await program.parseAsync([
        "node", "cli", "notify", "send", "--force", "--source", "calendar", "--category", "day_reminders",
      ]);
    } finally { cap.restore(); }
    expect(flushRemote).toHaveBeenCalledWith({ force: true, onlySource: "calendar", onlyCategory: "day_reminders" });
    expect(tickFn).not.toHaveBeenCalled();
    expect(cap.lines.join("\n")).toBe("delivered 2");
  });

  it("prints the Gateway's 'quiet hours' answer", async () => {
    const flushRemote = vi.fn(async () => ({
      answered: true as const,
      value: { skipped: "quiet-hours" as const, delivered: 0, failedTransient: 0, failedTerminal: 0 },
    }));
    const { program } = setup(baseConfig(), defaultRuntime(), undefined, { flushRemote });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send"]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toMatch(/skipped: quiet hours/);
  });

  it("says no tick ran when the Gateway ran none", async () => {
    const flushRemote = vi.fn(async () => ({ answered: true as const, value: undefined }));
    const { program, tickFn } = setup(baseConfig(), defaultRuntime(), counts, { flushRemote });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send"]); } finally { cap.restore(); }
    expect(tickFn).not.toHaveBeenCalled();
    expect(cap.lines.join("\n")).toMatch(/no tick ran/);
  });

  it("flushes in this process, and says why, when no Gateway answers", async () => {
    const flushRemote = vi.fn(async () => ({ answered: false as const, why: "no Gateway is running" }));
    const { program, tickFn } = setup(baseConfig(), defaultRuntime(), counts, { flushRemote });
    const out = captureStdout();
    const err = captureStderr();
    try { await program.parseAsync(["node", "cli", "notify", "send", "--source", "todo"]); }
    finally { out.restore(); err.restore(); }
    expect(tickFn).toHaveBeenCalledWith({ force: false, onlySource: "todo" });
    expect(err.lines.join("\n")).toMatch(/flushing in this process \(no Gateway is running\)/);
    expect(out.lines.join("\n")).toBe("delivered 2");
  });

  it("--local does not ask the Gateway", async () => {
    const flushRemote = vi.fn();
    const { program, tickFn } = setup(baseConfig(), defaultRuntime(), counts, { flushRemote: flushRemote as never });
    const out = captureStdout();
    const err = captureStderr();
    try { await program.parseAsync(["node", "cli", "notify", "send", "--local"]); }
    finally { out.restore(); err.restore(); }
    expect(flushRemote).not.toHaveBeenCalled();
    expect(tickFn).toHaveBeenCalledWith({ force: false });
    expect(err.lines).toHaveLength(0);
  });

  it("fails, without flushing here, when the Gateway may still be working on it", async () => {
    const flushRemote = vi.fn(async () => { throw new Error("the Gateway did not answer"); });
    const { program, tickFn } = setup(baseConfig(), defaultRuntime(), counts, { flushRemote });
    await expect(program.parseAsync(["node", "cli", "notify", "send"])).rejects.toThrow(/did not answer/);
    expect(tickFn).not.toHaveBeenCalled();
  });

  it("says how many rows were left for a destination this process cannot use", async () => {
    const left: TickResult = { delivered: 1, failedTransient: 0, failedTerminal: 0, leftUnsent: 3 };
    const { program } = setup(baseConfig(), defaultRuntime(), left);
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "send"]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toMatch(/^delivered 1, left 3 pending/);
  });

  it("checks the filters before asking anyone", async () => {
    const flushRemote = vi.fn();
    // A fresh program each time: commander keeps option values between parses.
    const fresh = () => setup(baseConfig(), defaultRuntime(), undefined, { flushRemote: flushRemote as never }).program;
    await expect(
      fresh().parseAsync(["node", "cli", "notify", "send", "--destination", "ghost"]),
    ).rejects.toThrow(/Unknown --destination/);
    await expect(
      fresh().parseAsync(["node", "cli", "notify", "send", "--source", "x".repeat(65)]),
    ).rejects.toThrow(/--source too long/);
    expect(flushRemote).not.toHaveBeenCalled();
  });
});

describe("cli doctor through the running Gateway", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-doctor-gw-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("prints the Gateway's report and takes its verdict", async () => {
    const doctorRemote = vi.fn(async () => ({
      answered: true as const,
      value: { ok: false, lines: ['✗ destination "default": pushapp channel NOT registered'] },
    }));
    const { program } = setup(baseConfig(), defaultRuntime(), undefined, { doctorRemote });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "doctor", "--skip-llm"]); } finally { cap.restore(); }
    expect(doctorRemote).toHaveBeenCalledWith({ skipLlm: true });
    expect(cap.lines[0]).toBe("Checked in the running Gateway.");
    expect(cap.lines.join("\n")).toMatch(/pushapp channel NOT registered/);
    expect(process.exitCode).toBe(1);
  });

  it("checks from this process, and says so, when no Gateway answers", async () => {
    const doctorRemote = vi.fn(async () => ({ answered: false as const, why: "no Gateway is running" }));
    const { program } = setup(baseConfig(), defaultRuntime(), undefined, { doctorRemote });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "doctor", "--skip-llm"]); } finally { cap.restore(); }
    expect(cap.lines[0]).toMatch(/Checked from this process \(no Gateway is running\)/);
    expect(cap.lines.join("\n")).toMatch(/config: valid/);
  });

  it("--local does not ask the Gateway", async () => {
    const doctorRemote = vi.fn();
    const { program } = setup(baseConfig(), defaultRuntime(), undefined, { doctorRemote: doctorRemote as never });
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "doctor", "--skip-llm", "--local"]); } finally { cap.restore(); }
    expect(doctorRemote).not.toHaveBeenCalled();
    expect(cap.lines[0]).toMatch(/Checked from this process \(--local\)/);
  });
});

describe("cli retry", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-retry-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedFailedRow(): number {
    const db = openDb(path.join(tmpDir, "notifications.db"));
    try {
      const id = enqueue(db, {
        source: "todo", category: null, destination: "default",
        rawData: { text: "x" }, shouldFormat: false, dedupKey: null,
      });
      db.prepare("UPDATE notifications SET failed_at = ?, delivery_attempts = 5 WHERE id = ?").run(Date.now(), id);
      return id;
    } finally {
      closeDb(db);
    }
  }

  it("requires --id or --all", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync(["node", "cli", "notify", "retry"]),
    ).rejects.toThrow(/--id|--all/);
  });

  it("--id clears failed_at on that row and leaves others alone", async () => {
    const a = seedFailedRow();
    const b = seedFailedRow();
    const { program } = setup(baseConfig());
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "retry", "--id", String(a)]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toMatch(new RegExp(`retried ${a}`));
    const db = openDb(path.join(tmpDir, "notifications.db"));
    try {
      const rowA = db.prepare("SELECT failed_at, delivery_attempts FROM notifications WHERE id = ?").get(a) as { failed_at: number | null; delivery_attempts: number };
      const rowB = db.prepare("SELECT failed_at, delivery_attempts FROM notifications WHERE id = ?").get(b) as { failed_at: number | null; delivery_attempts: number };
      expect(rowA.failed_at).toBeNull();
      expect(rowA.delivery_attempts).toBe(0);
      expect(rowB.failed_at).not.toBeNull();
      expect(rowB.delivery_attempts).toBe(5);
    } finally {
      closeDb(db);
    }
  });

  it("--id that doesn't name a failed row is a no-op with a clear message", async () => {
    const { program } = setup(baseConfig());
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "retry", "--id", "999"]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toMatch(/no failed row with id 999/);
  });

  it("--all clears every failed row and reports the count", async () => {
    seedFailedRow();
    seedFailedRow();
    seedFailedRow();
    const { program } = setup(baseConfig());
    const cap = captureStdout();
    try { await program.parseAsync(["node", "cli", "notify", "retry", "--all"]); } finally { cap.restore(); }
    expect(cap.lines.join("\n")).toMatch(/retried 3/);
    const db = openDb(path.join(tmpDir, "notifications.db"));
    try {
      const remaining = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE failed_at IS NOT NULL").get() as { c: number };
      expect(remaining.c).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("rejects a non-positive --id value", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync(["node", "cli", "notify", "retry", "--id", "0"]),
    ).rejects.toThrow(/positive integer/);
  });
});

describe("cli list / purge", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-listp-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("list prints JSON of pending rows by default", async () => {
    const { program } = setup(baseConfig());
    const origLog = console.log;
    console.log = () => {};
    await program.parseAsync([
      "node", "cli", "notify", "enqueue",
      "--source", "todo",
      "--data", JSON.stringify({ text: "a" }),
    ]);
    const logs: string[] = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await program.parseAsync(["node", "cli", "notify", "list"]);
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].source).toBe("todo");
  });

  it("rejects --older-than 0d (would purge everything)", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync(["node", "cli", "notify", "purge", "--older-than", "0d"]),
    ).rejects.toThrow(/positive/);
  });

  it("rejects --older-than malformed", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync(["node", "cli", "notify", "purge", "--older-than", "1.5d"]),
    ).rejects.toThrow(/duration/i);
  });

  it("purge --older-than 30d deletes old sent rows", async () => {
    const { program } = setup(baseConfig());
    const origLog = console.log;
    console.log = () => {};
    await program.parseAsync([
      "node", "cli", "notify", "enqueue",
      "--source", "todo",
      "--data", JSON.stringify({ text: "a" }),
    ]);
    console.log = origLog;
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path.join(tmpDir, "notifications.db"));
    const cutoff = Date.now() - 40 * 86400_000;
    db.prepare("UPDATE notifications SET sent_at = ?, created_at = ?").run(cutoff, cutoff);
    db.close();

    const logs: string[] = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await program.parseAsync(["node", "cli", "notify", "purge", "--older-than", "30d"]);
    } finally {
      console.log = origLog;
    }
    expect(logs.join("\n")).toMatch(/deleted 1/i);
  });
});

describe("cli doctor", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-doctor-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function doctorDeps(overrides: {
    cfg?: NotifyConfig;
    runtime?: ReturnType<typeof defaultRuntime>;
    fetchFn?: typeof fetch;
    skipLlm?: boolean;
  } = {}) {
    return {
      dbPath: path.join(tmpDir, "notifications.db"),
      config: overrides.cfg ?? baseConfig(),
      runtime: (overrides.runtime ?? defaultRuntime()) as never,
      skipLlm: overrides.skipLlm ?? false,
      fetchFn: overrides.fetchFn,
    };
  }

  it("reports ok when config, destinations, and queue are healthy (llm disabled)", async () => {
    const report = await runDoctor(doctorDeps());
    expect(report.ok).toBe(true);
    const out = report.lines.join("\n");
    expect(out).toMatch(/config: valid/);
    expect(out).toMatch(/destination "default".*telegram channel registered/);
    expect(out).toMatch(/destination "work".*slack channel registered/);
    expect(out).toMatch(/llm: disabled/);
    expect(out).toMatch(/queue: 0 pending, 0 failed/);
  });

  it("does not look for a channel when a destination is webhooks with no chat", async () => {
    const cfg = baseConfig({
      destinations: {
        default: {
          channel: "telegram", chatId: null, threadId: null,
          webhooks: [{ url: "http://127.0.0.1:9/hook", headers: {} }],
        },
      },
    });
    const runtime = defaultRuntime();
    delete (runtime.channel as Record<string, unknown>).telegram;
    const report = await runDoctor(doctorDeps({ cfg, runtime, skipLlm: true }));
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toMatch(/destination "default": 1 webhook, no chat/);
  });

  it("--skip-llm suppresses the probe even when llm is enabled", async () => {
    const cfg = baseConfig({ llm: { enabled: true, provider: "anthropic", model: null } });
    const runtime = defaultRuntime();
    runtime.modelAuth = {
      resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "sk-test" })),
    } as never;
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const report = await runDoctor(doctorDeps({ cfg, runtime, fetchFn, skipLlm: true }));
    expect(report.lines.join("\n")).toMatch(/llm: probe skipped/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports a destination as not-registered and fails overall when its channel namespace is missing", async () => {
    const runtime = defaultRuntime();
    // Slack plugin is not installed.
    delete (runtime.channel as Record<string, unknown>).slack;
    const report = await runDoctor(doctorDeps({ runtime, skipLlm: true }));
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/destination "work": slack channel NOT registered/);
  });

  it("reports a destination as not-registered when the send function isn't on the channel namespace", async () => {
    const runtime = defaultRuntime();
    // Plugin loaded but exposes the wrong method shape — simulates a drifted
    // channel plugin after a contract change.
    runtime.channel.telegram = { notTheRightFn: vi.fn() } as never;
    const report = await runDoctor(doctorDeps({ runtime, skipLlm: true }));
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/destination "default": telegram channel NOT registered/);
  });

  it("reports no-api-key when LLM is enabled but no provider resolves", async () => {
    const cfg = baseConfig({ llm: { enabled: true, provider: null, model: null } });
    const runtime = defaultRuntime();
    runtime.modelAuth = { resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: undefined })) } as never;
    const report = await runDoctor(doctorDeps({ cfg, runtime }));
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/llm: no provider has an API key/);
  });

  it("reports, rather than crashing, when model keys cannot be read from this process", async () => {
    const cfg = baseConfig({ llm: { enabled: true, provider: "openai", model: null } });
    const runtime = defaultRuntime();
    runtime.modelAuth = {
      resolveApiKeyForProvider: vi.fn(async () => { throw new Error("Shared auth store ownership is not prepared"); }),
    } as never;
    const report = await runDoctor(doctorDeps({ cfg, runtime }));
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/llm: model keys cannot be read from this process — Shared auth store/);
  });

  it("probes the LLM with a tiny prompt and reports success", async () => {
    const cfg = baseConfig({ llm: { enabled: true, provider: "anthropic", model: null } });
    const runtime = defaultRuntime();
    runtime.modelAuth = {
      resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "sk-test" })),
    } as never;
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ text: "pong" }] }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const report = await runDoctor(doctorDeps({ cfg, runtime, fetchFn }));
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toMatch(/llm: anthropic\/claude-haiku-5-5 — responded in \d+ms \("pong"\)/);
  });

  it("probes through OpenClaw when it offers its own completion, and reports the model that answered", async () => {
    const runtime = defaultRuntime();
    const complete = vi.fn(async (_params: Record<string, unknown>) => ({ text: "pong", provider: "anthropic", model: "claude-sonnet-5-5" }));
    (runtime as Record<string, unknown>).llm = { complete };
    runtime.modelAuth = { resolveApiKeyForProvider: vi.fn(async () => { throw new Error("no key lookup is expected"); }) } as never;
    const fetchFn = vi.fn(async () => { throw new Error("no request of the plugin's own is expected"); }) as unknown as typeof fetch;

    let report = await runDoctor(doctorDeps({ cfg: baseConfig({ llm: { enabled: true, provider: null, model: null } }), runtime, fetchFn }));
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toMatch(/✓ llm: anthropic\/claude-sonnet-5-5 through OpenClaw \(its own model\) — responded in \d+ms \("pong"\)/);
    expect(complete.mock.calls[0][0]).toMatchObject({ purpose: "notify.doctor" });
    expect(complete.mock.calls[0][0]).not.toHaveProperty("model");

    complete.mockImplementationOnce(async () => ({ text: "pong", provider: "anthropic", model: "claude-haiku-5-5" }));
    report = await runDoctor(doctorDeps({ cfg: baseConfig({ llm: { enabled: true, provider: "anthropic", model: "claude-haiku-5-5" } }), runtime, fetchFn }));
    expect(report.lines.join("\n")).toMatch(/✓ llm: anthropic\/claude-haiku-5-5 through OpenClaw — responded/);
    expect(complete.mock.calls[1][0]).toMatchObject({ model: "anthropic/claude-haiku-5-5" });

    complete.mockImplementationOnce(async () => { throw new Error("model override is not allowed for plugin notify"); });
    report = await runDoctor(doctorDeps({ cfg: baseConfig({ llm: { enabled: true, provider: "anthropic", model: "claude-haiku-5-5" } }), runtime, fetchFn }));
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/✗ llm: anthropic\/claude-haiku-5-5 through OpenClaw — model override is not allowed.*allowModelOverride: true/);
  });

  it("reports LLM failure with the underlying error message", async () => {
    const cfg = baseConfig({ llm: { enabled: true, provider: "anthropic", model: null } });
    const runtime = defaultRuntime();
    runtime.modelAuth = {
      resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "sk-test" })),
    } as never;
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "model not found",
    })) as unknown as typeof fetch;
    const report = await runDoctor(doctorDeps({ cfg, runtime, fetchFn }));
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/llm: anthropic\/claude-haiku-5-5 — LLM HTTP 404: model not found/);
  });

  it("reports queue depth and flags failed rows so the operator inspects them", async () => {
    const dbPath = path.join(tmpDir, "notifications.db");
    const db = openDb(dbPath);
    const now = Date.now();
    db.prepare(
      "INSERT INTO notifications (source, category, destination, raw_data, should_format, dedup_key, created_at, sent_at, delivery_attempts) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("todo", null, "default", JSON.stringify({ text: "pending" }), 0, null, now - 180_000, null, 0);
    db.prepare(
      "INSERT INTO notifications (source, category, destination, raw_data, should_format, dedup_key, created_at, sent_at, failed_at, delivery_attempts) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("todo", null, "default", JSON.stringify({ text: "dead" }), 0, null, now - 900_000, null, now - 600_000, 5);
    closeDb(db);

    const report = await runDoctor({
      dbPath,
      config: baseConfig(),
      runtime: defaultRuntime() as never,
      skipLlm: true,
    });
    expect(report.lines.join("\n")).toMatch(/queue: 1 pending, 1 failed, oldest pending 3m old/);
    expect(report.lines.join("\n")).toMatch(/notify list --failed/);
  });

  it("separates backing-off rows from ready-now ones in the queue line", async () => {
    const dbPath = path.join(tmpDir, "notifications.db");
    const db = openDb(dbPath);
    const now = Date.now();
    // One ready row.
    db.prepare(
      "INSERT INTO notifications (source, category, destination, raw_data, should_format, dedup_key, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run("todo", null, "default", JSON.stringify({ text: "ready" }), 0, null, now - 120_000);
    // Two backing-off rows (failed once, waiting on backoff).
    db.prepare(
      "INSERT INTO notifications (source, category, destination, raw_data, should_format, dedup_key, created_at, delivery_attempts, next_attempt_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("todo", null, "default", JSON.stringify({ text: "wait1" }), 0, null, now - 60_000, 1, now + 5 * 60_000);
    db.prepare(
      "INSERT INTO notifications (source, category, destination, raw_data, should_format, dedup_key, created_at, delivery_attempts, next_attempt_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("todo", null, "default", JSON.stringify({ text: "wait2" }), 0, null, now - 30_000, 2, now + 15 * 60_000);
    closeDb(db);

    const report = await runDoctor({
      dbPath,
      config: baseConfig(),
      runtime: defaultRuntime() as never,
      skipLlm: true,
    });
    expect(report.lines.join("\n")).toMatch(/queue: 1 pending \(2 backing off\), 0 failed/);
  });

  it("flags unsent rows bound to destinations that are no longer in config", async () => {
    const dbPath = path.join(tmpDir, "notifications.db");
    const db = openDb(dbPath);
    const now = Date.now();
    // A row for a destination the current config doesn't define (e.g. the
    // operator renamed "family" to "home" but rows are still queued).
    db.prepare(
      "INSERT INTO notifications (source, category, destination, raw_data, should_format, dedup_key, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run("todo", null, "family", JSON.stringify({ text: "orphan" }), 0, null, now);
    db.prepare(
      "INSERT INTO notifications (source, category, destination, raw_data, should_format, dedup_key, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run("todo", null, "family", JSON.stringify({ text: "orphan2" }), 0, null, now);
    closeDb(db);

    const report = await runDoctor({
      dbPath,
      config: baseConfig(),  // only "default" + "work"
      runtime: defaultRuntime() as never,
      skipLlm: true,
    });
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/2 unsent row\(s\) bound to unknown destination "family"/);
  });

  it("surfaces unset optional knobs (quietHours, personality) as tips", async () => {
    const report = await runDoctor(doctorDeps());
    const out = report.lines.join("\n");
    expect(out).toMatch(/Tips \(optional\):/);
    expect(out).toMatch(/quietHours not set/);
    expect(out).toMatch(/personality not set/);
    expect(out).toMatch(/openclaw config set plugins\.notify\.config/);
  });

  it("hints to add named destinations when only 'default' is configured", async () => {
    const cfg = baseConfig({
      destinations: { default: { channel: "telegram", chatId: "d1", threadId: null } },
    });
    const report = await runDoctor(doctorDeps({ cfg }));
    expect(report.lines.join("\n")).toMatch(/destinations: only "default"/);
  });

  it("emits no tips section when every optional knob is set", async () => {
    const cfg = baseConfig({
      quietHours: { start: "21:00", end: "08:00", tz: "America/New_York" },
      personality: "Casual but organized.",
      // baseConfig already has two destinations (default + work)
    });
    const report = await runDoctor(doctorDeps({ cfg }));
    const out = report.lines.join("\n");
    expect(out).not.toMatch(/Tips \(optional\):/);
    expect(out).not.toMatch(/quietHours not set/);
    expect(out).not.toMatch(/personality not set/);
  });
});
