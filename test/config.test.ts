import { describe, it, expect } from "vitest";
import { resolveConfig, ConfigError } from "../src/config.js";

describe("resolveConfig", () => {
  it("applies defaults for missing fields when destinations.default exists", () => {
    const raw = { destinations: { default: { channel: "telegram", chatId: "c" } } };
    const cfg = resolveConfig(raw);
    expect(cfg.tickIntervalSec).toBe(1800);
    expect(cfg.llm.enabled).toBe(true);
    expect(cfg.dedupWindowMin).toBe(15);
    expect(cfg.quietHours).toBeNull();
    expect(cfg.destinations.default.channel).toBe("telegram");
  });

  it("throws when destinations.default is missing", () => {
    expect(() => resolveConfig({})).toThrow(ConfigError);
    expect(() => resolveConfig({ destinations: { other: { channel: "telegram", chatId: "c" } } })).toThrow(
      /default/,
    );
  });

  it("throws on unknown channel", () => {
    expect(() =>
      resolveConfig({ destinations: { default: { channel: "fax", chatId: "c" } } }),
    ).toThrow(/channel/);
  });

  it("preserves quietHours when supplied", () => {
    const cfg = resolveConfig({
      destinations: { default: { channel: "telegram", chatId: "c" } },
      quietHours: { start: "21:00", end: "08:00", tz: "America/New_York" },
    });
    expect(cfg.quietHours).toEqual({ start: "21:00", end: "08:00", tz: "America/New_York" });
  });

  it("rejects partial quietHours (missing start)", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c" } },
        quietHours: { end: "08:00", tz: "America/New_York" },
      }),
    ).toThrow(/start/);
  });

  it("rejects quietHours with malformed HH:MM", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c" } },
        quietHours: { start: "9am", end: "5pm", tz: "America/New_York" },
      }),
    ).toThrow(/HH:MM/);
  });

  it("rejects quietHours hours out of range (25:00, 24:00)", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c" } },
        quietHours: { start: "25:00", end: "08:00", tz: "America/New_York" },
      }),
    ).toThrow(/HH:MM/);
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c" } },
        quietHours: { start: "08:00", end: "24:00", tz: "America/New_York" },
      }),
    ).toThrow(/HH:MM/);
  });

  it("accepts quietHours 23:59 (max valid)", () => {
    const cfg = resolveConfig({
      destinations: { default: { channel: "telegram", chatId: "c" } },
      quietHours: { start: "00:00", end: "23:59", tz: "UTC" },
    });
    expect(cfg.quietHours?.end).toBe("23:59");
  });

  it("rejects quietHours when start === end", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c" } },
        quietHours: { start: "22:00", end: "22:00", tz: "UTC" },
      }),
    ).toThrow(/identical/);
  });

  it("rejects invalid IANA timezone at parse time", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c" } },
        quietHours: { start: "21:00", end: "08:00", tz: "Not/A_Real_Zone" },
      }),
    ).toThrow(/timezone/i);
  });

  it("rejects tickIntervalSec below the floor (manifest minimum: 10), negative, NaN, string", () => {
    for (const bad of [0, 5, 9, -10, NaN, "100"]) {
      expect(() =>
        resolveConfig({
          destinations: { default: { channel: "telegram", chatId: "c" } },
          tickIntervalSec: bad as never,
        }),
      ).toThrow(/tickIntervalSec/);
    }
  });

  it("accepts tickIntervalSec === 10 (floor)", () => {
    const cfg = resolveConfig({
      destinations: { default: { channel: "telegram", chatId: "c" } },
      tickIntervalSec: 10,
    });
    expect(cfg.tickIntervalSec).toBe(10);
  });

  it("rejects dedupWindowMin < 0 or NaN", () => {
    for (const bad of [-1, NaN, "15"]) {
      expect(() =>
        resolveConfig({
          destinations: { default: { channel: "telegram", chatId: "c" } },
          dedupWindowMin: bad as never,
        }),
      ).toThrow(/dedupWindowMin/);
    }
  });

  it("accepts dedupWindowMin=0 (disables dedup)", () => {
    const cfg = resolveConfig({
      destinations: { default: { channel: "telegram", chatId: "c" } },
      dedupWindowMin: 0,
    });
    expect(cfg.dedupWindowMin).toBe(0);
  });

  it("accepts numeric threadId on telegram", () => {
    const cfg = resolveConfig({
      destinations: { default: { channel: "telegram", chatId: "c", threadId: 123 } },
    });
    expect(cfg.destinations.default.threadId).toBe(123);
  });

  it("accepts numeric-string threadId on telegram", () => {
    const cfg = resolveConfig({
      destinations: { default: { channel: "telegram", chatId: "c", threadId: "456" } },
    });
    expect(cfg.destinations.default.threadId).toBe("456");
  });

  it("rejects non-numeric string threadId on telegram", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c", threadId: "main" } },
      }),
    ).toThrow(/integer/);
  });

  it("rejects empty-string threadId on telegram", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c", threadId: "" } },
      }),
    ).toThrow(/integer/);
  });

  it("rejects threadId on channels that don't support threads (discord)", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "discord", chatId: "c", threadId: 123 } },
      }),
    ).toThrow(/does not support threads/);
  });

  it("rejects threadId on signal", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "signal", chatId: "c", threadId: "x" } },
      }),
    ).toThrow(/does not support threads/);
  });

  it("rejects threadId on imessage", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "imessage", chatId: "c", threadId: 1 } },
      }),
    ).toThrow(/does not support threads/);
  });

  it("accepts arbitrary string threadId on slack (it's a timestamp)", () => {
    const cfg = resolveConfig({
      destinations: { default: { channel: "slack", chatId: "#a", threadId: "1700000000.000100" } },
    });
    expect(cfg.destinations.default.threadId).toBe("1700000000.000100");
  });

  it("merges llm overrides", () => {
    const cfg = resolveConfig({
      destinations: { default: { channel: "telegram", chatId: "c" } },
      llm: { enabled: false, provider: "anthropic", model: null },
    });
    expect(cfg.llm).toEqual({ enabled: false, provider: "anthropic", model: null });
  });

  it("accepts all known llm providers", () => {
    for (const provider of ["anthropic", "openai", "google", "groq", "ollama"]) {
      const cfg = resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c" } },
        llm: { enabled: true, provider, model: null },
      });
      expect(cfg.llm.provider).toBe(provider);
    }
  });

  it("rejects unknown llm.provider (typo silently disables LLM formatting otherwise)", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c" } },
        llm: { enabled: true, provider: "anthorpic", model: null },
      }),
    ).toThrow(/llm\.provider/);
  });

  it("accepts llm.provider=null and undefined", () => {
    const c1 = resolveConfig({
      destinations: { default: { channel: "telegram", chatId: "c" } },
      llm: { enabled: true, provider: null, model: null },
    });
    expect(c1.llm.provider).toBeNull();
    const c2 = resolveConfig({
      destinations: { default: { channel: "telegram", chatId: "c" } },
      llm: { enabled: true },
    });
    expect(c2.llm.provider).toBeNull();
  });

  it("rejects personality over the length cap", () => {
    expect(() =>
      resolveConfig({
        destinations: { default: { channel: "telegram", chatId: "c" } },
        personality: "x".repeat(3000),
      }),
    ).toThrow(/personality/);
  });

  it("rejects non-object quietHours (string, array, number)", () => {
    for (const bad of ["21:00-08:00", [21, 8], 2100]) {
      expect(() =>
        resolveConfig({
          destinations: { default: { channel: "telegram", chatId: "c" } },
          quietHours: bad as never,
        }),
      ).toThrow(/quietHours/);
    }
  });
});
