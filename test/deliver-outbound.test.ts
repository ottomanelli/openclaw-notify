import { describe, expect, it, vi } from "vitest";
import { deliver, setHostConfig, stripMarkdown } from "../src/deliver.js";
import { channelLooksUsable, destinationUsableHere, validateDestinations } from "../src/validate.js";
import type { Destination, RuntimeBridge } from "../src/types.js";

const dest: Destination = { channel: "telegram", chatId: "123", threadId: null } as Destination;
const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function runtimeWith(sendText: unknown, legacy = false): RuntimeBridge {
  return {
    modelAuth: { resolveApiKeyForProvider: async () => ({}) },
    channel: {
      outbound: { loadAdapter: vi.fn(async () => (sendText ? { sendText } : undefined)) },
      ...(legacy ? { telegram: { sendMessageTelegram: vi.fn(async () => ({ messageId: "old" })) } } : {}),
    },
  } as unknown as RuntimeBridge;
}

describe("deliver through the outbound adapter", () => {
  it("loads the channel's adapter and sends the text with the host config", async () => {
    const sendText = vi.fn(async () => ({ messageId: "m42", channel: "telegram" }));
    const runtime = runtimeWith(sendText);
    setHostConfig({ marker: true });
    const result = await deliver(runtime, { ...dest, threadId: 7 } as Destination, "*hello*");
    expect(result).toEqual({ ok: true, messageId: "m42" });
    expect(runtime.channel.outbound!.loadAdapter).toHaveBeenCalledWith("telegram");
    expect(sendText).toHaveBeenCalledWith({ cfg: { marker: true }, to: "123", text: "*hello*", threadId: 7 });
  });

  it("prefers the adapter over the old per-channel function", async () => {
    const sendText = vi.fn(async () => ({ messageId: "new" }));
    const runtime = runtimeWith(sendText, true);
    expect(await deliver(runtime, dest, "hi")).toEqual({ ok: true, messageId: "new" });
    expect(runtime.channel.telegram!.sendMessageTelegram).not.toHaveBeenCalled();
  });

  it("reports a channel with no adapter as a failure, without throwing", async () => {
    const result = await deliver(runtimeWith(null), dest, "hi");
    expect(result).toEqual({ ok: false, error: "telegram channel not registered" });
  });

  it("retries without Markdown marks when the channel rejects the formatting", async () => {
    const sendText = vi.fn()
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockResolvedValueOnce({ messageId: "plain" });
    const result = await deliver(runtimeWith(sendText), dest, "*bold* and _it_");
    expect(result).toEqual({ ok: true, messageId: "plain" });
    expect(sendText.mock.calls[1][0].text).toBe("bold and it");
  });

  it("strips the usual Markdown marks", () => {
    expect(stripMarkdown("# Title\n*a* _b_ `c` ~d~")).toBe("Title\na b c d");
  });
});

describe("validation with the outbound loader", () => {
  it("treats every configured channel as usable when the loader exists", () => {
    const runtime = runtimeWith(null);
    expect(channelLooksUsable(runtime, "telegram")).toBe(true);
    const active = validateDestinations(
      { destinations: { default: dest } } as never, runtime, logger);
    expect(active.has("default")).toBe(true);
  });
});

describe("a channel this plugin has no details of", () => {
  const phone = { channel: "pushapp", chatId: "phone", threadId: null } as Destination;

  it("is sent through its adapter like any other", async () => {
    const sendText = vi.fn(async (_ctx: Record<string, unknown>) => ({ messageId: "push-1" }));
    const runtime = runtimeWith(sendText);
    expect(await deliver(runtime, phone, "Dentist at 3")).toEqual({ ok: true, messageId: "push-1" });
    expect(runtime.channel.outbound!.loadAdapter).toHaveBeenCalledWith("pushapp");
    expect(sendText.mock.calls[0][0]).toMatchObject({ to: "phone", text: "Dentist at 3" });
  });

  it("is cut to the length its adapter says it takes", async () => {
    const sendText = vi.fn(async (_ctx: Record<string, unknown>) => ({ messageId: "m" }));
    const runtime = {
      modelAuth: { resolveApiKeyForProvider: async () => ({}) },
      channel: { outbound: { loadAdapter: vi.fn(async () => ({ sendText, textChunkLimit: 20 })) } },
    } as unknown as RuntimeBridge;
    await deliver(runtime, phone, "x".repeat(50));
    const sent = sendText.mock.calls[0][0].text as string;
    expect(sent).toHaveLength(20);
    expect(sent.endsWith("…")).toBe(true);
  });

  it("is cut to 4000 characters when its adapter gives no length", async () => {
    const sendText = vi.fn(async (_ctx: Record<string, unknown>) => ({ messageId: "m" }));
    await deliver(runtimeWith(sendText), phone, "x".repeat(5000));
    expect((sendText.mock.calls[0][0].text as string)).toHaveLength(4000);
  });

  it("fails with a reason on an OpenClaw too old to have adapters", async () => {
    const old = {
      modelAuth: { resolveApiKeyForProvider: async () => ({}) },
      channel: { telegram: { sendMessageTelegram: vi.fn(async () => ({ messageId: "old" })) } },
    } as unknown as RuntimeBridge;
    const result = await deliver(old, phone, "hi");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pushapp channel not registered/);
  });
});

describe("destinationUsableHere", () => {
  it("is true for webhooks with no chat, whatever is loaded", async () => {
    expect(await destinationUsableHere(runtimeWith(null), { channel: "telegram", chatId: null })).toBe(true);
  });

  it("asks for the adapter when there is a chat", async () => {
    expect(await destinationUsableHere(runtimeWith(vi.fn()), { channel: "pushapp", chatId: "phone" })).toBe(true);
    // A plain CLI process: the loader exists and finds nothing.
    expect(await destinationUsableHere(runtimeWith(null), { channel: "pushapp", chatId: "phone" })).toBe(false);
  });

  it("treats a loader that throws as not usable", async () => {
    const runtime = {
      modelAuth: { resolveApiKeyForProvider: async () => ({}) },
      channel: { outbound: { loadAdapter: vi.fn(async () => { throw new Error("boom"); }) } },
    } as unknown as RuntimeBridge;
    expect(await destinationUsableHere(runtime, { channel: "telegram", chatId: "1" })).toBe(false);
  });

  it("on an old OpenClaw, looks for the channel's send function", async () => {
    const old = {
      modelAuth: { resolveApiKeyForProvider: async () => ({}) },
      channel: { telegram: { sendMessageTelegram: vi.fn() } },
    } as unknown as RuntimeBridge;
    expect(await destinationUsableHere(old, { channel: "telegram", chatId: "1" })).toBe(true);
    expect(await destinationUsableHere(old, { channel: "slack", chatId: "1" })).toBe(false);
    expect(await destinationUsableHere(old, { channel: "pushapp", chatId: "1" })).toBe(false);
  });
});
