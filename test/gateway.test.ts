import { describe, expect, it, vi } from "vitest";
import {
  FLUSH_METHOD,
  DOCTOR_METHOD,
  FLUSH_TIMEOUT_MS,
  askGateway,
  doctorViaGateway,
  flushViaGateway,
  parseFlushRequest,
  whyNotAsked,
} from "../src/gateway.js";

// The errors OpenClaw's Gateway client throws, as far as this plugin reads them.
function transportError(kind: "closed" | "timeout", requestDispatched?: boolean): Error {
  const err = new Error(
    kind === "closed" ? "Gateway not reachable at ws://127.0.0.1:18789 (ECONNREFUSED)." : "gateway timeout after 180000ms",
  );
  err.name = "GatewayTransportError";
  Object.assign(err, { kind, connectionDetails: {}, ...(requestDispatched === undefined ? {} : { requestDispatched }) });
  return err;
}

function refusal(message: string): Error {
  const err = new Error(message);
  err.name = "GatewayClientRequestError";
  Object.assign(err, { gatewayCode: "INVALID_REQUEST" });
  return err;
}

describe("parseFlushRequest", () => {
  const destinations = ["default", "work"];

  it("reads nothing as a plain flush", () => {
    expect(parseFlushRequest(undefined, destinations)).toEqual({ force: false });
    expect(parseFlushRequest({}, destinations)).toEqual({ force: false });
  });

  it("keeps force and the three filters", () => {
    expect(
      parseFlushRequest(
        { force: true, onlyDestination: "work", onlySource: "calendar", onlyCategory: "day_reminders" },
        destinations,
      ),
    ).toEqual({ force: true, onlyDestination: "work", onlySource: "calendar", onlyCategory: "day_reminders" });
  });

  it("refuses a destination that is not configured", () => {
    expect(() => parseFlushRequest({ onlyDestination: "ghost" }, destinations)).toThrow(/Unknown destination "ghost"/);
  });

  it("refuses values of the wrong kind", () => {
    expect(() => parseFlushRequest({ force: "yes" }, destinations)).toThrow(/force/);
    expect(() => parseFlushRequest({ onlySource: 7 }, destinations)).toThrow(/onlySource/);
    expect(() => parseFlushRequest({ onlyCategory: "" }, destinations)).toThrow(/onlyCategory/);
    expect(() => parseFlushRequest({ onlySource: "x".repeat(300) }, destinations)).toThrow(/onlySource/);
  });
});

describe("whyNotAsked", () => {
  it("says so when this OpenClaw has no Gateway client", () => {
    const err = new Error("nope");
    err.name = "NoGatewayClient";
    expect(whyNotAsked(err, FLUSH_METHOD)).toMatch(/no Gateway client/);
  });

  it("says no Gateway is running when the connection never opened", () => {
    expect(whyNotAsked(transportError("closed"), FLUSH_METHOD)).toMatch(/no Gateway is running/);
    expect(whyNotAsked(transportError("closed", false), FLUSH_METHOD)).toMatch(/no Gateway is running/);
  });

  it("says the Gateway has an older plugin when it does not know the method", () => {
    expect(whyNotAsked(refusal(`unknown method: ${FLUSH_METHOD}`), FLUSH_METHOD)).toMatch(/older version/);
  });

  it("gives no reason when the Gateway may have started on it", () => {
    expect(whyNotAsked(transportError("timeout"), FLUSH_METHOD)).toBeNull();
    expect(whyNotAsked(transportError("closed", true), FLUSH_METHOD)).toBeNull();
  });

  it("gives no reason when the Gateway refused for a reason of its own", () => {
    expect(whyNotAsked(refusal('Unknown destination "ghost"'), FLUSH_METHOD)).toBeNull();
    expect(whyNotAsked(refusal("unknown method: something.else"), FLUSH_METHOD)).toBeNull();
  });
});

describe("askGateway", () => {
  it("hands back what the Gateway answered", async () => {
    const call = vi.fn(async () => ({ any: "thing" }));
    expect(await askGateway(call, "x.y", { a: 1 }, 500)).toEqual({ answered: true, value: { any: "thing" } });
    expect(call).toHaveBeenCalledWith("x.y", { a: 1 }, 500);
  });

  it("reports 'not asked' so the caller can do the work itself", async () => {
    const call = vi.fn(async () => { throw transportError("closed"); });
    expect(await askGateway(call, FLUSH_METHOD, {}, 500)).toEqual({ answered: false, why: "no Gateway is running" });
  });

  it("throws, rather than doing the work twice, when the Gateway timed out", async () => {
    const call = vi.fn(async () => { throw transportError("timeout"); });
    await expect(askGateway(call, FLUSH_METHOD, {}, 500)).rejects.toThrow(/did not answer.*may still be working/);
  });

  it("throws with the Gateway's own words when it refused", async () => {
    const call = vi.fn(async () => { throw refusal('Unknown destination "ghost"'); });
    await expect(askGateway(call, FLUSH_METHOD, {}, 500)).rejects.toThrow(/refused: Unknown destination "ghost"/);
  });
});

describe("flushViaGateway", () => {
  it("asks the Gateway to flush and returns its counts", async () => {
    const counts = { delivered: 2, failedTransient: 0, failedTerminal: 0 };
    const call = vi.fn(async () => ({ result: counts }));
    const answer = await flushViaGateway({ force: true, onlySource: "calendar" }, call);
    expect(answer).toEqual({ answered: true, value: counts });
    expect(call).toHaveBeenCalledWith(FLUSH_METHOD, { force: true, onlySource: "calendar" }, FLUSH_TIMEOUT_MS);
  });

  it("passes on 'skipped' answers", async () => {
    const counts = { skipped: "quiet-hours", delivered: 0, failedTransient: 0, failedTerminal: 0 };
    const answer = await flushViaGateway({ force: false }, vi.fn(async () => ({ result: counts })));
    expect(answer).toEqual({ answered: true, value: counts });
  });

  it("returns no counts when the Gateway ran no tick", async () => {
    expect(await flushViaGateway({ force: false }, vi.fn(async () => ({})))).toEqual({ answered: true, value: undefined });
    expect(await flushViaGateway({ force: false }, vi.fn(async () => ({ result: "nonsense" })))).toEqual({
      answered: true,
      value: undefined,
    });
  });

  it("says so when no Gateway answers", async () => {
    const call = vi.fn(async () => { throw transportError("closed"); });
    expect(await flushViaGateway({ force: false }, call)).toEqual({ answered: false, why: "no Gateway is running" });
  });
});

describe("doctorViaGateway", () => {
  it("returns the Gateway's report", async () => {
    const call = vi.fn(async (_method: string, _params: unknown, _timeoutMs: number) => ({
      ok: true,
      lines: ["✓ config: valid"],
    }));
    expect(await doctorViaGateway({ skipLlm: true }, call)).toEqual({
      answered: true,
      value: { ok: true, lines: ["✓ config: valid"] },
    });
    expect(call.mock.calls[0][0]).toBe(DOCTOR_METHOD);
    expect(call.mock.calls[0][1]).toEqual({ skipLlm: true });
  });

  it("throws on an answer that is not a report", async () => {
    await expect(doctorViaGateway({ skipLlm: true }, vi.fn(async () => ({ ok: "yes" })))).rejects.toThrow(/unreadable/);
  });
});
