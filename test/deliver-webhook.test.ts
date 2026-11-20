import { describe, it, expect, vi } from "vitest";
import { deliver, sendWebhook } from "../src/deliver.js";
import { resolveConfig, ConfigError } from "../src/config.js";

const ok = () => vi.fn(async () => new Response("{}", { status: 200 }));
const refuse = () => vi.fn(async () => new Response("no", { status: 500 }));
const hook = { url: "http://relay.example/notify", headers: { Authorization: "Bearer t" } };

function runtimeWith(sendText: (...args: unknown[]) => unknown) {
  return { channel: { outbound: { loadAdapter: async () => ({ sendText }) } } } as never;
}

describe("webhook delivery", () => {
  it("posts the text, a plain copy and what it is about", async () => {
    const fetchImpl = ok();
    await sendWebhook(hook, "*Pay* the bill", { destination: "default", sources: ["todo"], count: 1 }, fetchImpl as never);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(hook.url);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "*Pay* the bill", plain: "Pay the bill", destination: "default", sources: ["todo"], count: 1,
    });
  });

  it("treats a non-2xx answer as a failure", async () => {
    await expect(sendWebhook(hook, "x", {}, refuse() as never)).rejects.toThrow("webhook answered 500");
  });

  it("with webhooks only, they are the delivery", async () => {
    const fetchImpl = ok();
    const result = await deliver(runtimeWith(() => { throw new Error("no chat should be used"); }),
      { channel: "telegram", chatId: null, threadId: null, webhooks: [hook] }, "hello", {}, fetchImpl as never);
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("with webhooks only, a failing webhook fails the delivery so it is retried", async () => {
    const result = await deliver(runtimeWith(() => ({})),
      { channel: "telegram", chatId: null, threadId: null, webhooks: [hook] }, "hello", {}, refuse() as never);
    expect(result.ok).toBe(false);
  });

  it("with a chat too, the chat decides and a failing webhook is only reported", async () => {
    const sendText = vi.fn(async () => ({ messageId: "7" }));
    const result = await deliver(runtimeWith(sendText),
      { channel: "telegram", chatId: "123", threadId: null, webhooks: [hook] }, "hello", {}, refuse() as never);
    expect(result.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(result.ok && result.webhookErrors?.[0]).toContain("relay.example");
  });

  it("does not call the webhooks when the chat fails", async () => {
    const fetchImpl = ok();
    const result = await deliver(runtimeWith(async () => { throw new Error("chat down"); }),
      { channel: "telegram", chatId: "123", threadId: null, webhooks: [hook] }, "hello", {}, fetchImpl as never);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a destination without webhooks behaves as before", async () => {
    const fetchImpl = ok();
    const result = await deliver(runtimeWith(async () => ({ messageId: "9" })),
      { channel: "telegram", chatId: "123", threadId: null }, "hello", {}, fetchImpl as never);
    expect(result).toEqual({ ok: true, messageId: "9" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("webhook config", () => {
  const base = { tickIntervalSec: 1800 };

  it("accepts a chat with webhooks", () => {
    const cfg = resolveConfig({ ...base, destinations: { default: { channel: "telegram", chatId: "1", webhooks: [{ url: "http://a.example/x", headers: { A: "b" } }] } } });
    expect(cfg.destinations.default.webhooks).toEqual([{ url: "http://a.example/x", headers: { A: "b" } }]);
    expect(cfg.destinations.default.chatId).toBe("1");
  });

  it("accepts webhooks with no chat", () => {
    const cfg = resolveConfig({ ...base, destinations: { default: { webhooks: [{ url: "https://a.example/x" }] } } });
    expect(cfg.destinations.default).toEqual({ channel: "telegram", chatId: null, threadId: null, webhooks: [{ url: "https://a.example/x", headers: {} }] });
  });

  it("still needs a chat when there are no webhooks", () => {
    expect(() => resolveConfig({ ...base, destinations: { default: { channel: "telegram" } } })).toThrow(ConfigError);
  });

  it("rejects an address that is not http(s) and headers that are not strings", () => {
    expect(() => resolveConfig({ ...base, destinations: { default: { webhooks: [{ url: "ftp://a/x" }] } } })).toThrow(ConfigError);
    expect(() => resolveConfig({ ...base, destinations: { default: { webhooks: [{ url: "http://a/x", headers: { A: 1 } }] } } })).toThrow(ConfigError);
  });

  it("leaves a plain chat destination exactly as it was", () => {
    const cfg = resolveConfig({ ...base, destinations: { default: { channel: "telegram", chatId: "1" } } });
    expect(cfg.destinations.default).toEqual({ channel: "telegram", chatId: "1", threadId: null });
  });
});
