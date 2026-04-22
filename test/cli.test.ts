import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import { registerNotifyCli, runDoctor } from "../src/cli.js";
import { openDb, closeDb } from "../src/db.js";
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

function setup(cfg: NotifyConfig, runtime: ReturnType<typeof defaultRuntime> = defaultRuntime()) {
  const program = new Command();
  program.exitOverride();
  const tickFn = vi.fn(async () => {});
  registerNotifyCli({
    program,
    dbPath: path.join(tmpDir, "notifications.db"),
    config: cfg,
    tickFn,
    runtime: runtime as never,
  });
  return { program, tickFn, runtime };
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
    await program.parseAsync(["node", "cli", "notify", "send"]);
    expect(tickFn).toHaveBeenCalledWith({ force: false, onlyDestination: undefined });
  });

  it("passes --force", async () => {
    const { program, tickFn } = setup(baseConfig());
    await program.parseAsync(["node", "cli", "notify", "send", "--force"]);
    expect(tickFn).toHaveBeenCalledWith({ force: true, onlyDestination: undefined });
  });

  it("passes --destination", async () => {
    const { program, tickFn } = setup(baseConfig());
    await program.parseAsync(["node", "cli", "notify", "send", "--destination", "work"]);
    expect(tickFn).toHaveBeenCalledWith({ force: false, onlyDestination: "work" });
  });

  it("rejects unknown --destination on send", async () => {
    const { program } = setup(baseConfig());
    await expect(
      program.parseAsync(["node", "cli", "notify", "send", "--destination", "ghost"]),
    ).rejects.toThrow(/destination/i);
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
    expect(report.lines.join("\n")).toMatch(/llm: anthropic\/claude-haiku-4-5 — responded in \d+ms \("pong"\)/);
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
    expect(report.lines.join("\n")).toMatch(/llm: anthropic\/claude-haiku-4-5 — LLM HTTP 404: model not found/);
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
});
