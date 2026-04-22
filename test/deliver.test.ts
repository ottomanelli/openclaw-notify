import { describe, it, expect, vi } from "vitest";
import { deliver } from "../src/deliver.js";
import type { Destination } from "../src/types.js";

function fakeRuntime(overrides: {
  sendMessageTelegram?: ReturnType<typeof vi.fn>;
  sendMessageSlack?: ReturnType<typeof vi.fn>;
  sendMessageDiscord?: ReturnType<typeof vi.fn>;
  telegramMissing?: boolean;
  slackMissing?: boolean;
  discordMissing?: boolean;
} = {}) {
  const sendMessageTelegram = overrides.sendMessageTelegram ?? vi.fn(async () => ({ messageId: "m1", chatId: "c" }));
  const sendMessageSlack = overrides.sendMessageSlack ?? vi.fn(async () => ({ messageId: "m1", chatId: "c" }));
  const sendMessageDiscord = overrides.sendMessageDiscord ?? vi.fn(async () => ({ messageId: "m1", chatId: "c" }));
  const channel: Record<string, unknown> = {};
  if (!overrides.telegramMissing) channel.telegram = { sendMessageTelegram };
  if (!overrides.slackMissing) channel.slack = { sendMessageSlack };
  if (!overrides.discordMissing) channel.discord = { sendMessageDiscord };
  return {
    sendMessageTelegram,
    sendMessageSlack,
    sendMessageDiscord,
    runtime: { channel },
  };
}

describe("deliver", () => {
  it("calls sendMessageTelegram with chatId, text, and a numeric messageThreadId for telegram", async () => {
    const { runtime, sendMessageTelegram } = fakeRuntime();
    const dest: Destination = { channel: "telegram", chatId: "123", threadId: 7 };
    const result = await deliver(runtime as never, dest, "hello");
    expect(result).toEqual({ ok: true, messageId: "m1" });
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "hello",
      expect.objectContaining({ textMode: "markdown", messageThreadId: 7 }),
    );
  });

  it("passes a string threadId to slack as threadTs", async () => {
    const { runtime, sendMessageSlack } = fakeRuntime();
    const dest: Destination = { channel: "slack", chatId: "#alerts", threadId: "1700000000.000100" };
    const result = await deliver(runtime as never, dest, "hi");
    expect(result.ok).toBe(true);
    expect(sendMessageSlack).toHaveBeenCalledWith(
      "#alerts",
      "hi",
      expect.objectContaining({ threadTs: "1700000000.000100" }),
    );
  });

  it("returns { ok: false, error } when the channel namespace is missing", async () => {
    const { runtime } = fakeRuntime({ discordMissing: true });
    const dest: Destination = { channel: "discord", chatId: "abc", threadId: null };
    const result = await deliver(runtime as never, dest, "hi");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/discord channel not registered/);
  });

  it("returns { ok: false, error } when the send function throws", async () => {
    const { runtime } = fakeRuntime({
      sendMessageTelegram: vi.fn(async () => { throw new Error("boom"); }) as never,
    });
    const dest: Destination = { channel: "telegram", chatId: "123", threadId: null };
    const result = await deliver(runtime as never, dest, "hi");
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("passes short messages through unmodified", async () => {
    const { runtime, sendMessageTelegram } = fakeRuntime();
    const dest: Destination = { channel: "telegram", chatId: "123", threadId: null };
    const message = "abc".repeat(1000); // 3000 chars, under telegram's 4000 cap
    await deliver(runtime as never, dest, message);
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram).toHaveBeenCalledWith("123", message, expect.any(Object));
  });

  it("truncates messages with ellipsis when they exceed the channel's per-message ceiling", async () => {
    const { runtime, sendMessageTelegram } = fakeRuntime();
    const dest: Destination = { channel: "telegram", chatId: "123", threadId: null };
    const longMessage = "abc".repeat(2000); // 6000 chars, exceeds telegram's 4000 cap
    await deliver(runtime as never, dest, longMessage);
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    const sentText = sendMessageTelegram.mock.calls[0][1] as string;
    expect(sentText.length).toBe(4000);
    expect(sentText.endsWith("…")).toBe(true);
  });

  it("applies a tighter ceiling on discord (2000-char hard limit)", async () => {
    const { runtime, sendMessageDiscord } = fakeRuntime();
    const dest: Destination = { channel: "discord", chatId: "c1", threadId: null };
    const longMessage = "x".repeat(5000);
    await deliver(runtime as never, dest, longMessage);
    const sentText = sendMessageDiscord.mock.calls[0][1] as string;
    expect(sentText.length).toBe(1990);
    expect(sentText.endsWith("…")).toBe(true);
  });

  it("retries telegram as plain text when the first send fails with a markdown parse error", async () => {
    const calls: Array<{ text: string; opts: { textMode?: string } }> = [];
    const sendMessageTelegram = vi.fn(async (_to: string, text: string, opts: { textMode?: string }) => {
      calls.push({ text, opts });
      if (opts.textMode === "markdown") {
        throw new Error("Bad Request: can't parse entities: Character '_' is reserved");
      }
      return { messageId: "m-plain" };
    }) as never;
    const { runtime } = fakeRuntime({ sendMessageTelegram });
    const dest: Destination = { channel: "telegram", chatId: "123", threadId: null };
    const result = await deliver(runtime as never, dest, "oops *foo_bar");
    expect(result).toEqual({ ok: true, messageId: "m-plain" });
    expect(calls).toHaveLength(2);
    expect(calls[0].opts.textMode).toBe("markdown");
    expect(calls[1].opts.textMode).toBe("plain");
  });

  it("retries signal as plain text when the first send fails with a markdown-looking error", async () => {
    const sendMessageSignal = vi.fn(async (_to: string, _text: string, opts: { textMode?: string }) => {
      if (opts.textMode === "markdown") throw new Error("markdown rendering failed");
      return { messageId: "m-plain" };
    }) as never;
    const runtime = { channel: { signal: { sendMessageSignal } } };
    const dest: Destination = { channel: "signal", chatId: "+15551234567", threadId: null };
    const result = await deliver(runtime as never, dest, "hi");
    expect(result).toEqual({ ok: true, messageId: "m-plain" });
    expect(sendMessageSignal).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry non-markdown errors on telegram", async () => {
    const sendMessageTelegram = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    }) as never;
    const { runtime } = fakeRuntime({ sendMessageTelegram });
    const dest: Destination = { channel: "telegram", chatId: "123", threadId: null };
    const result = await deliver(runtime as never, dest, "hi");
    expect(result.ok).toBe(false);
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
  });

  it("does NOT plain-text-retry on discord (channel has no textMode)", async () => {
    const sendMessageDiscord = vi.fn(async () => {
      throw new Error("Bad Request: markdown parse failed");
    }) as never;
    const { runtime } = fakeRuntime({ sendMessageDiscord });
    const dest: Destination = { channel: "discord", chatId: "c1", threadId: null };
    const result = await deliver(runtime as never, dest, "hi");
    expect(result.ok).toBe(false);
    expect(sendMessageDiscord).toHaveBeenCalledTimes(1);
  });

  it("returns the plain-text attempt's error if the retry also fails", async () => {
    const sendMessageTelegram = vi.fn(async (_to: string, _text: string, opts: { textMode?: string }) => {
      if (opts.textMode === "markdown") throw new Error("can't parse entities");
      throw new Error("downstream unavailable");
    }) as never;
    const { runtime } = fakeRuntime({ sendMessageTelegram });
    const dest: Destination = { channel: "telegram", chatId: "123", threadId: null };
    const result = await deliver(runtime as never, dest, "hi");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("downstream unavailable");
    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
  });
});
