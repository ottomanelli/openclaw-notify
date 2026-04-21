import { describe, it, expect, vi } from "vitest";
import { validateDestinations } from "../src/validate.js";
import type { NotifyConfig } from "../src/types.js";

const logger = {
  debug() {}, info() {}, warn: vi.fn(), error() {},
};

const cfg = (dests: Record<string, { channel: string; chatId: string }>): NotifyConfig => ({
  tickIntervalSec: 300,
  destinations: Object.fromEntries(
    Object.entries(dests).map(([k, v]) => [k, { ...v, threadId: null } as never]),
  ),
  quietHours: null,
  llm: { enabled: false, provider: null, model: null },
  personality: null,
  dedupWindowMin: 15,
});

const SEND_FN_BY_CHANNEL: Record<string, string> = {
  telegram: "sendMessageTelegram",
  discord:  "sendMessageDiscord",
  slack:    "sendMessageSlack",
  signal:   "sendMessageSignal",
  imessage: "sendMessageIMessage",
};

function fakeRuntime(registered: string[]) {
  const channel: Record<string, unknown> = {};
  for (const c of registered) {
    const fnName = SEND_FN_BY_CHANNEL[c];
    channel[c] = { [fnName]: async () => ({ messageId: "x" }) };
  }
  return { channel };
}

describe("validateDestinations", () => {
  it("returns all destinations when every channel namespace is registered", () => {
    const active = validateDestinations(
      cfg({
        default: { channel: "telegram", chatId: "a" },
        work: { channel: "slack", chatId: "b" },
      }),
      fakeRuntime(["telegram", "slack"]) as never,
      logger,
    );
    expect([...active].sort()).toEqual(["default", "work"]);
  });

  it("excludes destinations whose channel namespace is missing and logs a warning", () => {
    const warnSpy = vi.fn();
    const active = validateDestinations(
      cfg({
        default: { channel: "telegram", chatId: "a" },
        work: { channel: "discord", chatId: "b" },
      }),
      fakeRuntime(["telegram"]) as never,
      { ...logger, warn: warnSpy },
    );
    expect([...active]).toEqual(["default"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/discord|work/));
  });

  it("throws when `default` is excluded", () => {
    expect(() =>
      validateDestinations(
        cfg({ default: { channel: "discord", chatId: "a" } }),
        fakeRuntime(["telegram"]) as never,
        logger,
      ),
    ).toThrow(/default/);
  });

  it("excludes destinations whose namespace is present but lacks the send function", () => {
    const warnSpy = vi.fn();
    const runtime = {
      channel: {
        telegram: { sendMessageTelegram: async () => ({ messageId: "x" }) },
        slack: { /* no sendMessageSlack */ },
      },
    };
    const active = validateDestinations(
      cfg({
        default: { channel: "telegram", chatId: "a" },
        work: { channel: "slack", chatId: "b" },
      }),
      runtime as never,
      { ...logger, warn: warnSpy },
    );
    expect([...active]).toEqual(["default"]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
