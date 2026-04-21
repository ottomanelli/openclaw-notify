import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createNotifyService } from "../src/service.js";

describe("createNotifyService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs tick once on start, then every intervalMs", async () => {
    const tickFn = vi.fn(async () => {});
    const svc = createNotifyService({ intervalMs: 1000, tickFn });
    await svc.start();
    expect(tickFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tickFn).toHaveBeenCalledTimes(4);
    await svc.stop();
  });

  it("stop clears the interval", async () => {
    const tickFn = vi.fn(async () => {});
    const svc = createNotifyService({ intervalMs: 1000, tickFn });
    await svc.start();
    await svc.stop();
    tickFn.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tickFn).not.toHaveBeenCalled();
  });

  it("does not overlap a long-running tick (chained setTimeout)", async () => {
    // With setInterval, a tick slower than the interval would pile up
    // overlapping concurrent calls. With chained setTimeout, the next tick
    // is only scheduled after the previous resolves.
    let resolveFirst: () => void = () => {};
    const firstInflight = new Promise<void>((r) => { resolveFirst = r; });
    let callCount = 0;
    const tickFn = vi.fn(async () => {
      callCount++;
      // Only the first tick blocks — later ticks resolve immediately.
      if (callCount === 1) await firstInflight;
    });
    const svc = createNotifyService({ intervalMs: 1000, tickFn });
    // Do NOT await start — the first tick is deliberately hung.
    const startPromise = svc.start();
    // Yield microtasks so the first tick enters tickFn and increments count.
    await Promise.resolve();
    await Promise.resolve();
    expect(callCount).toBe(1);

    // Advance well past many intervals. setInterval would fire repeatedly
    // and we'd see callCount climb. Chained setTimeout hasn't scheduled
    // anything yet because the first tick is still pending.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callCount).toBe(1);

    // Release the first tick. Now scheduleNext runs, and the next tick
    // fires one interval later.
    resolveFirst();
    await startPromise;
    await vi.advanceTimersByTimeAsync(1500);
    expect(callCount).toBeGreaterThanOrEqual(2);
    await svc.stop();
  });

  it("swallows tick errors so the loop keeps running", async () => {
    const tickFn = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const svc = createNotifyService({ intervalMs: 1000, tickFn });
    await svc.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(tickFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    await svc.stop();
  });

  it("stop() awaits an in-flight tick (graceful shutdown)", async () => {
    // stop() should not resolve while a tick is mid-flight. Otherwise a
    // SIGTERM mid-delivery returns to the host before the row is marked
    // sent, leaving a 10-min reservation gap and a likely redelivery.
    let resolveTick: () => void = () => {};
    const inflight = new Promise<void>((r) => { resolveTick = r; });
    let tickResolved = false;
    const tickFn = vi.fn(async () => {
      await inflight;
      tickResolved = true;
    });
    const svc = createNotifyService({ intervalMs: 1000, tickFn });
    const startPromise = svc.start();
    // Let the first tick enter tickFn.
    await Promise.resolve();
    await Promise.resolve();
    expect(tickFn).toHaveBeenCalledTimes(1);

    // stop() now. It must wait for the in-flight tick.
    let stopResolved = false;
    const stopPromise = svc.stop().then(() => { stopResolved = true; });
    // Microtask flush: stop hasn't returned because tick is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(tickResolved).toBe(false);

    // Release the tick. Now both start and stop resolve.
    resolveTick();
    await startPromise;
    await stopPromise;
    expect(tickResolved).toBe(true);
    expect(stopResolved).toBe(true);
  });
});
