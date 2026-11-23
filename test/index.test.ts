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

describe("index: the Gateway does the work for the CLI", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-index-gw-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  type Handler = (request: { params?: unknown; respond: ReturnType<typeof vi.fn> }) => Promise<void>;

  // Current OpenClaw: channels are reached through adapters. `loaded` are the channels
  // whose adapter loads in this process (all of them in the Gateway, none in a CLI).
  function adapterRuntime(loaded: string[]) {
    const sends: Array<{ channel: string; to: string; text: string }> = [];
    return {
      sends,
      runtime: {
        modelAuth: { resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: undefined })) },
        channel: {
          outbound: {
            loadAdapter: vi.fn(async (id: string) =>
              loaded.includes(id)
                ? {
                    sendText: async ({ to, text }: { to: string; text: string }) => {
                      sends.push({ channel: id, to, text });
                      return { messageId: `m${sends.length}` };
                    },
                  }
                : undefined),
          },
        },
      },
    };
  }

  function register(runtime: unknown, destinations: Record<string, unknown>) {
    const registerCli = vi.fn();
    const methods = new Map<string, { handler: Handler; opts: { scope?: string } }>();
    const warn = vi.fn();
    const api = {
      pluginConfig: { ...pluginConfig(), destinations },
      config: {},
      logger: { debug() {}, info() {}, warn, error() {} },
      resolvePath: (p: string) => path.join(tmpDir, p.replace(/^~\/?/, "")),
      runtime,
      registerCli,
      registerService: vi.fn(),
      registerGatewayMethod: (name: string, handler: Handler, opts: { scope?: string }) => {
        methods.set(name, { handler, opts });
      },
    };
    notifyPlugin.register!(api as never);
    const program = new Command();
    program.exitOverride();
    registerCli.mock.calls[0][0]({ program });
    return { program, methods, warn };
  }

  async function run(program: Command, ...args: string[]) {
    const out: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => out.push("stderr: " + a.map(String).join(" "));
    try {
      await program.parseAsync(["node", "cli", "notify", ...args]);
    } finally {
      console.log = origLog;
      console.error = origError;
    }
    return out.join("\n");
  }

  const phone = { default: { channel: "pushapp", chatId: "phone", threadId: null } };

  it("registers notify.flush and notify.doctor for operators who may write", () => {
    const { methods } = register(adapterRuntime(["pushapp"]).runtime, phone);
    expect([...methods.keys()].sort()).toEqual(["notify.doctor", "notify.flush"]);
    expect(methods.get("notify.flush")!.opts.scope).toBe("operator.write");
    expect(methods.get("notify.doctor")!.opts.scope).toBe("operator.write");
  });

  it("notify.flush sends what is waiting, to a channel this plugin has no details of", async () => {
    const { runtime, sends } = adapterRuntime(["pushapp"]);
    const { program, methods } = register(runtime, phone);
    await run(program, "enqueue", "--source", "calendar", "--category", "day_reminders",
      "--data", JSON.stringify({ text: "Dentist at 3" }), "--no-format");
    await run(program, "enqueue", "--source", "todo", "--data", JSON.stringify({ text: "Buy beans" }), "--no-format");

    const respond = vi.fn();
    await methods.get("notify.flush")!.handler({ params: { onlySource: "calendar" }, respond });

    expect(respond).toHaveBeenCalledWith(true, { result: { delivered: 1, failedTransient: 0, failedTerminal: 0 } }, undefined);
    expect(sends).toEqual([{ channel: "pushapp", to: "phone", text: "calendar — Dentist at 3" }]);
  });

  it("notify.flush refuses a request it cannot read", async () => {
    const { methods } = register(adapterRuntime(["pushapp"]).runtime, phone);
    const respond = vi.fn();
    await methods.get("notify.flush")!.handler({ params: { onlyDestination: "ghost" }, respond });
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: 'Unknown destination "ghost"',
    });
  });

  it("notify.doctor answers with the report as the Gateway sees it", async () => {
    const { methods } = register(adapterRuntime(["pushapp"]).runtime, phone);
    const respond = vi.fn();
    await methods.get("notify.doctor")!.handler({ params: { skipLlm: true }, respond });
    const [ok, report] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toMatch(/destination "default": pushapp channel registered/);
  });

  it("with no Gateway, the CLI leaves a chat's rows waiting instead of failing them", async () => {
    // A CLI process: the adapter loader exists and finds no channel.
    const { runtime, sends } = adapterRuntime([]);
    const { program } = register(runtime, phone);
    await run(program, "enqueue", "--source", "todo", "--data", JSON.stringify({ text: "Buy beans" }), "--no-format");

    const out = await run(program, "send");
    expect(out).toMatch(/stderr: notify: flushing in this process \(this OpenClaw has no Gateway client for plugins\)/);
    expect(out).toMatch(/delivered 0, left 1 pending/);
    expect(sends).toHaveLength(0);

    // Nothing was tried, so nothing counts towards the retry budget.
    const rows = JSON.parse(await run(program, "list")) as Array<{ delivery_attempts: number; failed_at: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery_attempts).toBe(0);
    expect(rows[0].failed_at).toBeNull();
  });

  it("with no Gateway, the CLI still delivers a destination made of webhooks", async () => {
    const posts: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      posts.push(`${String(url)} ${String(init?.body)}`);
      return new Response("{}", { status: 200 });
    }) as never;
    try {
      const { program } = register(adapterRuntime([]).runtime, {
        default: { channel: "telegram", webhooks: [{ url: "http://127.0.0.1:9/hook" }] },
      });
      await run(program, "enqueue", "--source", "todo", "--data", JSON.stringify({ text: "Buy beans" }), "--no-format");
      expect(await run(program, "send")).toMatch(/delivered 1$/);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatch(/Buy beans/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
