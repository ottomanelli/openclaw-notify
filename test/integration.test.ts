import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import { registerNotifyCli } from "../src/cli.js";
import { openDb, closeDb } from "../src/db.js";
import { tick } from "../src/tick.js";
import type { NotifyConfig } from "../src/types.js";

let tmpDir: string;

function cfg(): NotifyConfig {
  return {
    tickIntervalSec: 300,
    destinations: {
      default: { channel: "telegram", chatId: "c1", threadId: null },
      work: { channel: "slack", chatId: "#alerts", threadId: null },
    },
    quietHours: null,
    llm: { enabled: false, provider: null, model: null },
    personality: null,
    dedupWindowMin: 15,
  };
}

function fakeRuntime() {
  const sends: Array<{ channel: string; to: string; text: string }> = [];
  const sendMessageTelegram = vi.fn(async (to: string, text: string) => {
    sends.push({ channel: "telegram", to, text });
    return { messageId: `m${sends.length}` };
  });
  const sendMessageSlack = vi.fn(async (to: string, text: string) => {
    sends.push({ channel: "slack", to, text });
    return { messageId: `m${sends.length}` };
  });
  return {
    sends,
    runtime: {
      modelAuth: { resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: undefined, source: "t", mode: "api-key" })) },
      channel: {
        telegram: { sendMessageTelegram },
        slack: { sendMessageSlack },
      },
    },
  };
}

describe("integration: enqueue via CLI → tick → deliver", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-integ-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes default and work enqueues to their channels in one tick", async () => {
    const config = cfg();
    const dbPath = path.join(tmpDir, "notifications.db");
    const { runtime, sends } = fakeRuntime();

    const logger = { debug() {}, info() {}, warn() {}, error() {} };

    const program = new Command();
    program.exitOverride();
    registerNotifyCli({
      program,
      dbPath,
      config,
      tickFn: async (opts) => {
        const db = openDb(dbPath);
        try { await tick(db, config, runtime as never, logger, opts); } finally { closeDb(db); }
      },
    });

    const origLog = console.log;
    console.log = () => {};
    try {
      await program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "todo",
        "--data", JSON.stringify({ text: "Buy beans" }),
        "--no-format",
      ]);
      await program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "meeting-bot",
        "--data", JSON.stringify({ text: "Standup at 10" }),
        "--no-format",
        "--destination", "work",
      ]);
      await program.parseAsync(["node", "cli", "notify", "send"]);
    } finally {
      console.log = origLog;
    }

    expect(sends.find((s) => s.channel === "telegram" && s.text.includes("Buy beans"))).toBeTruthy();
    expect(sends.find((s) => s.channel === "slack" && s.text.includes("Standup"))).toBeTruthy();

    const db = openDb(dbPath);
    const rows = db.prepare("SELECT * FROM notifications WHERE sent_at IS NULL").all();
    closeDb(db);
    expect(rows).toHaveLength(0);
  });
});
