import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import notifyPlugin from "../index.js";

let tmpDir: string;

function pluginConfig() {
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

const SEND_FN_BY_CHANNEL: Record<string, string> = {
  telegram: "sendMessageTelegram",
  discord:  "sendMessageDiscord",
  slack:    "sendMessageSlack",
  signal:   "sendMessageSignal",
  imessage: "sendMessageIMessage",
};

function fakeRuntime(opts: { registered?: string[] } = {}) {
  const registered = opts.registered ?? ["telegram", "slack"];
  const sends: Array<{ channel: string; to: string; text: string }> = [];
  const channel: Record<string, unknown> = {};
  for (const c of registered) {
    const fnName = SEND_FN_BY_CHANNEL[c];
    channel[c] = {
      [fnName]: vi.fn(async (to: string, text: string) => {
        sends.push({ channel: c, to, text });
        return { messageId: `m${sends.length}` };
      }),
    };
  }
  return {
    sends,
    runtime: {
      modelAuth: { resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: undefined })) },
      channel,
    },
  };
}

describe("index: plugin register()", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-index-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers CLI under 'notify' and a notify-flusher service, sharing a single DB path", async () => {
    const { runtime, sends } = fakeRuntime();

    const registerCli = vi.fn();
    const registerService = vi.fn();
    const api = {
      pluginConfig: pluginConfig(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      resolvePath: (p: string) => path.join(tmpDir, p.replace(/^~\/?/, "")),
      runtime,
      registerCli,
      registerService,
    };

    notifyPlugin.register!(api as never);

    expect(registerCli).toHaveBeenCalledTimes(1);
    const cliOpts = registerCli.mock.calls[0][1];
    expect(cliOpts).toEqual({ commands: ["notify"] });

    expect(registerService).toHaveBeenCalledTimes(1);
    const serviceDef = registerService.mock.calls[0][0];
    expect(serviceDef.id).toBe("notify-flusher");

    // Drive the CLI registrar, then enqueue → send to prove DB path is shared.
    const program = new Command();
    program.exitOverride();
    const cliRegistrar = registerCli.mock.calls[0][0];
    cliRegistrar({ program });

    const origLog = console.log;
    console.log = () => {};
    try {
      await program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "todo",
        "--data", JSON.stringify({ text: "Buy beans" }),
        "--no-format",
      ]);
      await program.parseAsync(["node", "cli", "notify", "send"]);
    } finally {
      console.log = origLog;
    }

    expect(sends.find((s) => s.channel === "telegram" && s.text.includes("Buy beans"))).toBeTruthy();

    // Service start + stop should run without throwing given a valid config.
    await serviceDef.start({});
    await serviceDef.stop();
  });

  it("retries validation on subsequent ticks when a channel registers late", async () => {
    // Start with no telegram registered. After the first (failing) tick, add
    // it to the runtime and prove the next tick recovers without restart.
    const sends: Array<{ channel: string; to: string; text: string }> = [];
    const runtime = {
      modelAuth: { resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: undefined })) },
      channel: {} as Record<string, unknown>,
    };
    const errorSpy = vi.fn();
    const registerCli = vi.fn();
    const registerService = vi.fn();
    const api = {
      pluginConfig: {
        tickIntervalSec: 300,
        destinations: { default: { channel: "telegram", chatId: "c1", threadId: null } },
        quietHours: null,
        llm: { enabled: false, provider: null, model: null },
        personality: null,
        dedupWindowMin: 15,
      },
      logger: { debug() {}, info() {}, warn() {}, error: errorSpy },
      resolvePath: (p: string) => path.join(tmpDir, p.replace(/^~\/?/, "")),
      runtime,
      registerCli,
      registerService,
    };

    notifyPlugin.register!(api as never);

    const program = new Command();
    program.exitOverride();
    const cliRegistrar = registerCli.mock.calls[0][0];
    cliRegistrar({ program });

    const origLog = console.log;
    console.log = () => {};
    try {
      // Enqueue a row. First send: channel not registered → error logged,
      // row stays pending.
      await program.parseAsync([
        "node", "cli", "notify", "enqueue",
        "--source", "todo",
        "--data", JSON.stringify({ text: "retry me" }),
        "--no-format",
      ]);
      await program.parseAsync(["node", "cli", "notify", "send"]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/destinations\.default is unusable/));

      // Simulate the telegram channel plugin finally registering.
      runtime.channel.telegram = {
        sendMessageTelegram: vi.fn(async (to: string, text: string) => {
          sends.push({ channel: "telegram", to, text });
          return { messageId: "m1" };
        }),
      };

      // Second send: validation retries, succeeds, row is delivered.
      await program.parseAsync(["node", "cli", "notify", "send"]);
    } finally {
      console.log = origLog;
    }

    expect(sends.some((s) => s.text.includes("retry me"))).toBe(true);
  });

  it("service start short-circuits when destinations.default channel is unregistered", async () => {
    const { runtime } = fakeRuntime({ registered: ["slack"] });
    const errorSpy = vi.fn();
    const registerService = vi.fn();
    const api = {
      pluginConfig: pluginConfig(),
      logger: { debug() {}, info() {}, warn() {}, error: errorSpy },
      resolvePath: (p: string) => path.join(tmpDir, p.replace(/^~\/?/, "")),
      runtime,
      registerCli: vi.fn(),
      registerService,
    };

    notifyPlugin.register!(api as never);

    const serviceDef = registerService.mock.calls[0][0];
    await serviceDef.start({});
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/destinations\.default is unusable/));
    // Stop is safe to call even when start short-circuited.
    await serviceDef.stop();
  });
});
