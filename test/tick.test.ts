import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb, closeDb, type Db } from "../src/db.js";
import { enqueue, getPending } from "../src/queue.js";
import { tick } from "../src/tick.js";
import type { NotifyConfig } from "../src/types.js";

let tmpDir: string;
let db: Db;

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

function fakeRuntime() {
  const sends: Array<{ channel: string; to: string; text: string }> = [];
  const sendMessageTelegram = vi.fn(async (to: string, text: string) => {
    sends.push({ channel: "telegram", to, text });
    return { messageId: `m-${sends.length}` };
  });
  const sendMessageSlack = vi.fn(async (to: string, text: string) => {
    sends.push({ channel: "slack", to, text });
    return { messageId: `m-${sends.length}` };
  });
  return {
    sends,
    sendMessageTelegram,
    sendMessageSlack,
    runtime: {
      modelAuth: { resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: undefined, source: "t", mode: "api-key" })) },
      channel: {
        telegram: { sendMessageTelegram },
        slack: { sendMessageSlack },
      },
    },
  };
}

const logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("tick", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-tick-"));
    db = openDb(path.join(tmpDir, "notifications.db"));
  });
  afterEach(() => {
    closeDb(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns early during quiet hours without delivering", async () => {
    enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    const { runtime, sends } = fakeRuntime();
    const cfg = baseConfig({ quietHours: { start: "00:00", end: "23:59", tz: "UTC" } });
    const r = await tick(db, cfg, runtime as never, logger, { force: false });
    expect(sends).toHaveLength(0);
    expect(getPending(db)).toHaveLength(1);
    expect(r.skipped).toBe("quiet-hours");
    expect(r.delivered).toBe(0);
  });

  it("returns skipped:no-rows when the queue is empty", async () => {
    const { runtime } = fakeRuntime();
    const r = await tick(db, baseConfig(), runtime as never, logger, { force: false });
    expect(r.skipped).toBe("no-rows");
    expect(r.delivered).toBe(0);
  });

  it("returns counts that reflect deliveries and transient failures", async () => {
    enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "ok" }, shouldFormat: false, dedupKey: null });
    enqueue(db, { source: "b", category: null, destination: "work", rawData: { text: "fail" }, shouldFormat: false, dedupKey: null });
    const { runtime, sendMessageSlack } = fakeRuntime();
    sendMessageSlack.mockRejectedValueOnce(new Error("boom"));
    const r = await tick(db, baseConfig(), runtime as never, logger, { force: false });
    expect(r.skipped).toBeUndefined();
    expect(r.delivered).toBe(1);
    expect(r.failedTransient).toBe(1);
    expect(r.failedTerminal).toBe(0);
  });

  it("delivers to different destinations as separate messages", async () => {
    enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "personal" }, shouldFormat: false, dedupKey: null });
    enqueue(db, { source: "b", category: null, destination: "work", rawData: { text: "alerty" }, shouldFormat: false, dedupKey: null });
    const { runtime, sends } = fakeRuntime();
    await tick(db, baseConfig(), runtime as never, logger, { force: false });
    expect(sends.some((s) => s.channel === "telegram" && s.text.includes("personal"))).toBe(true);
    expect(sends.some((s) => s.channel === "slack" && s.text.includes("alerty"))).toBe(true);
    expect(getPending(db)).toHaveLength(0);
  });

  it("leaves rows unsent when destination is unknown", async () => {
    enqueue(db, { source: "a", category: null, destination: "ghost", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    const { runtime, sends } = fakeRuntime();
    const warnSpy = vi.fn();
    await tick(db, baseConfig(), runtime as never, { ...logger, warn: warnSpy }, { force: false });
    expect(sends).toHaveLength(0);
    expect(getPending(db)).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("leaves rows unsent when delivery throws", async () => {
    enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    const { runtime, sends, sendMessageTelegram } = fakeRuntime();
    sendMessageTelegram.mockRejectedValueOnce(new Error("boom"));
    await tick(db, baseConfig(), runtime as never, logger, { force: false });
    // Row is released (not stuck reserved) so it shows up for retry next tick.
    expect(getPending(db)).toHaveLength(1);
    expect(sends).toHaveLength(0);
    const row = db.prepare("SELECT reserved_at FROM notifications WHERE sent_at IS NULL").get() as { reserved_at: number | null };
    expect(row.reserved_at).toBeNull();
  });

  it("--force bypasses quiet hours", async () => {
    enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "x" }, shouldFormat: false, dedupKey: null });
    const { runtime, sends } = fakeRuntime();
    const cfg = baseConfig({ quietHours: { start: "00:00", end: "23:59", tz: "UTC" } });
    await tick(db, cfg, runtime as never, logger, { force: true });
    expect(sends).toHaveLength(1);
    expect(getPending(db)).toHaveLength(0);
  });

  it("skips destinations not in activeDestinations set and leaves rows unsent", async () => {
    enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "p" }, shouldFormat: false, dedupKey: null });
    enqueue(db, { source: "b", category: null, destination: "work", rawData: { text: "w" }, shouldFormat: false, dedupKey: null });
    const { runtime, sends } = fakeRuntime();
    const warnSpy = vi.fn();
    await tick(db, baseConfig(), runtime as never, { ...logger, warn: warnSpy }, {
      force: false,
      activeDestinations: new Set(["default"]),
    });
    expect(sends).toHaveLength(1);
    expect(sends[0].channel).toBe("telegram");
    // "work" row stays pending; warn fires for the inactive destination.
    expect(getPending(db)).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/work.*channel not registered/));
  });

  it("limits to a single destination when --destination is given", async () => {
    enqueue(db, { source: "a", category: null, destination: "default", rawData: { text: "p" }, shouldFormat: false, dedupKey: null });
    enqueue(db, { source: "b", category: null, destination: "work", rawData: { text: "w" }, shouldFormat: false, dedupKey: null });
    const { runtime, sends } = fakeRuntime();
    await tick(db, baseConfig(), runtime as never, logger, { force: false, onlyDestination: "work" });
    expect(sends).toHaveLength(1);
    expect(sends[0].channel).toBe("slack");
    expect(getPending(db)).toHaveLength(1);
  });
});
