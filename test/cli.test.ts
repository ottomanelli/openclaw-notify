import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import { registerNotifyCli } from "../src/cli.js";
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

function setup(cfg: NotifyConfig) {
  const program = new Command();
  program.exitOverride();
  const tickFn = vi.fn(async () => {});
  registerNotifyCli({
    program,
    dbPath: path.join(tmpDir, "notifications.db"),
    config: cfg,
    tickFn,
  });
  return { program, tickFn };
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
