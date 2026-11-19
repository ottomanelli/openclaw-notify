import { describe, expect, it, vi } from "vitest";
import { deliver, setHostConfig, stripMarkdown } from "../src/deliver.js";
import { channelLooksUsable, validateDestinations } from "../src/validate.js";
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
