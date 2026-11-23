import type { TickResult } from "./tick.js";

// Why this exists. `openclaw notify send` run from a script (a scheduled job, a producer
// that wants its message out now) is a short-lived CLI process. OpenClaw loads neither
// the channel plugins nor the model credentials into such a process, so from there a
// chat cannot be reached and nothing can be LLM-formatted; only webhooks work. The
// running Gateway has both. So the CLI asks the Gateway to do the work, through Gateway
// methods this plugin registers (index.ts), and does it itself only when no Gateway
// answers.

export const FLUSH_METHOD = "notify.flush";
export const DOCTOR_METHOD = "notify.doctor";

// A flush may format with an LLM (up to 30 s a batch) and then send; give it room.
export const FLUSH_TIMEOUT_MS = 180_000;
export const DOCTOR_TIMEOUT_MS = 60_000;

export type FlushRequest = {
  force: boolean;
  onlyDestination?: string;
  onlySource?: string;
  onlyCategory?: string;
};

/** What the Gateway answers to FLUSH_METHOD. No `result`: no tick ran there. */
export type FlushReply = { result?: TickResult };

/** Calls a Gateway method from this process and returns its payload. */
export type GatewayCall = (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;

export type GatewayAnswer<T> =
  | { answered: true; value: T }
  // No Gateway is running, or the one running has no such method: nothing was asked of
  // it, and the caller does the work itself. `why` is for the person reading the output.
  | { answered: false; why: string };

const MAX_FILTER_LEN = 256;

/** Checks what a caller sent to FLUSH_METHOD. Throws with words for the caller. */
export function parseFlushRequest(params: unknown, destinations: readonly string[]): FlushRequest {
  const given = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
  const text = (key: string): string | undefined => {
    const value = given[key];
    if (value == null) return undefined;
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_FILTER_LEN) {
      throw new Error(`${key}: must be a non-empty string of at most ${MAX_FILTER_LEN} characters`);
    }
    return value;
  };
  if (given.force != null && typeof given.force !== "boolean") {
    throw new Error("force: must be true or false");
  }
  const onlyDestination = text("onlyDestination");
  if (onlyDestination && !destinations.includes(onlyDestination)) {
    throw new Error(`Unknown destination "${onlyDestination}"`);
  }
  const request: FlushRequest = { force: given.force === true };
  if (onlyDestination) request.onlyDestination = onlyDestination;
  const onlySource = text("onlySource");
  if (onlySource) request.onlySource = onlySource;
  const onlyCategory = text("onlyCategory");
  if (onlyCategory) request.onlyCategory = onlyCategory;
  return request;
}

function field(err: unknown, key: string): unknown {
  return err && typeof err === "object" ? (err as Record<string, unknown>)[key] : undefined;
}

/**
 * Why a failed call means "nobody was asked" (so doing the work here is safe), or null
 * when the Gateway may have started on it or refused it.
 */
export function whyNotAsked(err: unknown, method: string): string | null {
  // Thrown by gateway-client.ts: this OpenClaw predates the client it uses.
  if (field(err, "name") === "NoGatewayClient") return "this OpenClaw has no Gateway client for plugins";
  const message = err instanceof Error ? err.message : String(err);
  if (field(err, "name") === "GatewayTransportError") {
    // Closed before the request went out: connection refused, Gateway not up yet.
    if (field(err, "kind") === "closed" && field(err, "requestDispatched") !== true) {
      return "no Gateway is running";
    }
    return null;
  }
  // The Gateway is up but loaded a version of this plugin from before the method.
  if (message.includes(`unknown method: ${method}`)) {
    return "the running Gateway has an older version of this plugin (restart it)";
  }
  return null;
}

export async function askGateway<T>(
  call: GatewayCall,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<GatewayAnswer<T>> {
  try {
    return { answered: true, value: (await call(method, params, timeoutMs)) as T };
  } catch (err) {
    const why = whyNotAsked(err, method);
    if (why) return { answered: false, why };
    const first = (err instanceof Error ? err.message : String(err)).split("\n", 1)[0];
    throw new Error(
      field(err, "name") === "GatewayTransportError"
        ? `the Gateway did not answer (${first}). It may still be working on it: check with "openclaw notify list" before trying again.`
        : `the Gateway refused: ${first}`,
    );
  }
}

function isTickResult(value: unknown): value is TickResult {
  const v = value as Record<string, unknown> | null;
  return Boolean(v) && typeof v === "object"
    && typeof v!.delivered === "number"
    && typeof v!.failedTransient === "number"
    && typeof v!.failedTerminal === "number";
}

/** Has the running Gateway flush the queue. `value` undefined: it ran no tick. */
export async function flushViaGateway(
  request: FlushRequest,
  call: GatewayCall,
): Promise<GatewayAnswer<TickResult | undefined>> {
  const answer = await askGateway<FlushReply>(call, FLUSH_METHOD, request, FLUSH_TIMEOUT_MS);
  if (!answer.answered) return answer;
  const result = answer.value?.result;
  return { answered: true, value: isTickResult(result) ? result : undefined };
}

export type DoctorReport = { ok: boolean; lines: string[] };

/** Has the running Gateway run the doctor, where channels and model keys can be seen. */
export async function doctorViaGateway(
  request: { skipLlm: boolean },
  call: GatewayCall,
): Promise<GatewayAnswer<DoctorReport>> {
  const answer = await askGateway<DoctorReport>(call, DOCTOR_METHOD, request, DOCTOR_TIMEOUT_MS);
  if (!answer.answered) return answer;
  const report = answer.value;
  if (!report || typeof report.ok !== "boolean" || !Array.isArray(report.lines)) {
    throw new Error("the Gateway answered the doctor with something unreadable");
  }
  return { answered: true, value: { ok: report.ok, lines: report.lines.map(String) } };
}
