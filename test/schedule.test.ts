import { describe, it, expect } from "vitest";
import { nowInQuietHours } from "../src/schedule.js";

describe("nowInQuietHours", () => {
  it("returns false when quietHours is null", () => {
    expect(nowInQuietHours(null, new Date("2026-04-17T10:00:00Z"))).toBe(false);
  });

  it("handles same-day window (09:00-17:00)", () => {
    const cfg = { start: "09:00", end: "17:00", tz: "America/New_York" };
    // 2026-04-17 noon ET = 16:00 UTC
    expect(nowInQuietHours(cfg, new Date("2026-04-17T16:00:00Z"))).toBe(true);
    // 2026-04-17 08:00 ET = 12:00 UTC
    expect(nowInQuietHours(cfg, new Date("2026-04-17T12:00:00Z"))).toBe(false);
  });

  it("handles midnight-wrap window (21:00-08:00)", () => {
    const cfg = { start: "21:00", end: "08:00", tz: "America/New_York" };
    // 2026-04-17 22:00 ET = 02:00 UTC next day
    expect(nowInQuietHours(cfg, new Date("2026-04-18T02:00:00Z"))).toBe(true);
    // 2026-04-17 07:30 ET = 11:30 UTC
    expect(nowInQuietHours(cfg, new Date("2026-04-17T11:30:00Z"))).toBe(true);
    // 2026-04-17 08:00 ET = 12:00 UTC (boundary = not quiet)
    expect(nowInQuietHours(cfg, new Date("2026-04-17T12:00:00Z"))).toBe(false);
    // 2026-04-17 12:00 ET = 16:00 UTC
    expect(nowInQuietHours(cfg, new Date("2026-04-17T16:00:00Z"))).toBe(false);
  });

  it("respects timezone — same wall clock different tz", () => {
    const cfg = { start: "21:00", end: "08:00", tz: "Asia/Tokyo" };
    // 2026-04-17 22:00 Tokyo = 13:00 UTC
    expect(nowInQuietHours(cfg, new Date("2026-04-17T13:00:00Z"))).toBe(true);
  });
});
