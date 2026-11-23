import type { NotifyConfig, ChannelName, KnownChannel, Destination, WebhookTarget } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// A channel is named by its OpenClaw channel id: one of the bundled ones, or any other
// installed channel plugin's. Whether it is installed is only known when a message is
// sent, so all that is checked here is that it looks like an id.
const CHANNEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CHANNEL_ID_HELP = "must be an OpenClaw channel id (telegram, discord, slack, signal, imessage, or another installed channel's id)";

function isChannelId(value: unknown): value is ChannelName {
  return typeof value === "string" && CHANNEL_ID.test(value);
}

// These channels have no threads, and would silently discard a threadId in deliver.ts —
// reject at parse time so a user doesn't spend debugging cycles wondering why their
// "thread" never materializes. Any other channel is handed the threadId as given.
const CHANNELS_WITHOUT_THREADS: ReadonlySet<KnownChannel> = new Set(["discord", "signal", "imessage"]);

// Must match PROVIDER_PRIORITY in format.ts. Duplicated here so the config
// module has no runtime dependency on format.ts (avoids pulling node:crypto
// into a config-only import).
const VALID_LLM_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic", "openai", "google", "groq", "ollama",
]);

// Personality is concatenated into the LLM system prompt for every batch.
// An unbounded string wastes tokens on every request; cap at a reasonable
// paragraph length.
const MAX_PERSONALITY_LEN = 2048;

// Floor for tick interval. Matches the `minimum: 10` in openclaw.plugin.json;
// anything below this is abusive to LLM/channel APIs.
const MIN_TICK_INTERVAL_SEC = 10;

function parseWebhooks(name: string, raw: unknown): WebhookTarget[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError(`destinations.${name}.webhooks: must be a list`);
  }
  return raw.map((entry, i) => {
    const where = `destinations.${name}.webhooks[${i}]`;
    if (!entry || typeof entry !== "object") throw new ConfigError(`${where}: must be an object`);
    const e = entry as Record<string, unknown>;
    let parsed: URL;
    try {
      parsed = new URL(String(e.url ?? ""));
    } catch {
      throw new ConfigError(`${where}.url: must be an http(s) address`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ConfigError(`${where}.url: must be an http(s) address`);
    }
    const headers: Record<string, string> = {};
    if (e.headers != null) {
      if (typeof e.headers !== "object" || Array.isArray(e.headers)) {
        throw new ConfigError(`${where}.headers: must be an object of strings`);
      }
      for (const [key, value] of Object.entries(e.headers as Record<string, unknown>)) {
        if (typeof value !== "string") throw new ConfigError(`${where}.headers.${key}: must be a string`);
        headers[key] = value;
      }
    }
    return { url: parsed.toString(), headers };
  });
}

function parseDestination(name: string, raw: unknown): Destination {
  if (!raw || typeof raw !== "object") {
    throw new ConfigError(`destinations.${name}: must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const webhooks = parseWebhooks(name, o.webhooks);
  // Webhooks alone are enough: no chat is needed then. `channel` may still be given to
  // choose the message style (it defaults to telegram's).
  if (webhooks.length > 0 && (o.chatId == null || o.chatId === "")) {
    const style = o.channel == null ? "telegram" : o.channel;
    if (!isChannelId(style)) {
      throw new ConfigError(`destinations.${name}.channel: ${CHANNEL_ID_HELP}`);
    }
    if (o.threadId != null) {
      throw new ConfigError(`destinations.${name}.threadId: needs a chatId`);
    }
    return { channel: style, chatId: null, threadId: null, webhooks };
  }
  const channel = o.channel;
  const chatId = o.chatId;
  if (!isChannelId(channel)) {
    throw new ConfigError(`destinations.${name}.channel: ${CHANNEL_ID_HELP}`);
  }
  if (typeof chatId !== "string" || chatId.length === 0) {
    throw new ConfigError(`destinations.${name}.chatId: required non-empty string (or give webhooks)`);
  }
  const threadId = o.threadId;
  if (threadId != null && typeof threadId !== "string" && typeof threadId !== "number") {
    throw new ConfigError(`destinations.${name}.threadId: must be string, number, or null`);
  }
  if (threadId != null && CHANNELS_WITHOUT_THREADS.has(channel as KnownChannel)) {
    throw new ConfigError(`destinations.${name}.threadId: "${channel}" channel does not support threads; remove threadId or use telegram/slack`);
  }
  // Telegram message_thread_id is an integer over the wire. Reject empty
  // strings and non-integers here rather than silently sending NaN/0 at
  // delivery time.
  if (threadId != null && channel === "telegram") {
    const asStr = String(threadId);
    if (!/^-?\d+$/.test(asStr)) {
      throw new ConfigError(`destinations.${name}.threadId: telegram thread IDs must be integers (got "${threadId}")`);
    }
  }
  return {
    channel,
    chatId,
    threadId: (threadId ?? null) as string | number | null,
    ...(webhooks.length > 0 ? { webhooks } : {}),
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function resolveConfig(raw: unknown): NotifyConfig {
  const o = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});

  const destsRaw = o.destinations;
  if (!destsRaw || typeof destsRaw !== "object" || !("default" in destsRaw)) {
    throw new ConfigError("destinations.default is required");
  }
  const destinations: Record<string, Destination> = {};
  for (const [name, d] of Object.entries(destsRaw as Record<string, unknown>)) {
    destinations[name] = parseDestination(name, d);
  }

  const qh = o.quietHours;
  let quietHours: NotifyConfig["quietHours"] = null;
  if (qh !== undefined && qh !== null) {
    // Reject strings, arrays, numbers, booleans, etc. so a user who writes
    // `"quietHours": "21:00-08:00"` sees a loud error instead of silently
    // getting no quiet hours at all.
    if (typeof qh !== "object" || Array.isArray(qh)) {
      throw new ConfigError(`quietHours: must be an object with start/end/tz, or null/omitted`);
    }
    const q = qh as Record<string, unknown>;
    for (const field of ["start", "end", "tz"] as const) {
      if (typeof q[field] !== "string" || q[field] === "") {
        throw new ConfigError(`quietHours.${field}: required non-empty string when quietHours is set`);
      }
    }
    const hhmm = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!hhmm.test(q.start as string) || !hhmm.test(q.end as string)) {
      throw new ConfigError(`quietHours.start / quietHours.end: must be "HH:MM" in 00:00–23:59`);
    }
    if (q.start === q.end) {
      throw new ConfigError(`quietHours.start and quietHours.end are identical ("${q.start}") — ambiguous (always quiet? never?). Use distinct times, or omit quietHours entirely.`);
    }
    try {
      // Validates that the string is a known IANA zone (and not garbage) so
      // we fail at boot, not on the first tick.
      new Intl.DateTimeFormat(undefined, { timeZone: q.tz as string });
    } catch {
      throw new ConfigError(`quietHours.tz: invalid IANA timezone "${q.tz}"`);
    }
    quietHours = { start: q.start as string, end: q.end as string, tz: q.tz as string };
  }

  let tickIntervalSec = 1800;
  if (o.tickIntervalSec !== undefined) {
    if (!isFiniteNumber(o.tickIntervalSec) || o.tickIntervalSec < MIN_TICK_INTERVAL_SEC) {
      throw new ConfigError(`tickIntervalSec: must be a finite number >= ${MIN_TICK_INTERVAL_SEC} (got ${JSON.stringify(o.tickIntervalSec)})`);
    }
    tickIntervalSec = o.tickIntervalSec;
  }

  let dedupWindowMin = 15;
  if (o.dedupWindowMin !== undefined) {
    if (!isFiniteNumber(o.dedupWindowMin) || o.dedupWindowMin < 0) {
      throw new ConfigError(`dedupWindowMin: must be a finite number >= 0 (got ${JSON.stringify(o.dedupWindowMin)})`);
    }
    dedupWindowMin = o.dedupWindowMin;
  }

  const llmRaw = (o.llm ?? {}) as Record<string, unknown>;
  let llmProvider: string | null = null;
  if (llmRaw.provider != null) {
    if (typeof llmRaw.provider !== "string" || !VALID_LLM_PROVIDERS.has(llmRaw.provider)) {
      throw new ConfigError(
        `llm.provider: must be one of ${[...VALID_LLM_PROVIDERS].join(", ")} or null (got ${JSON.stringify(llmRaw.provider)})`,
      );
    }
    llmProvider = llmRaw.provider;
  }

  let personality: string | null = null;
  if (o.personality != null) {
    if (typeof o.personality !== "string") {
      throw new ConfigError(`personality: must be a string or null`);
    }
    if (o.personality.length > MAX_PERSONALITY_LEN) {
      throw new ConfigError(`personality: too long (${o.personality.length} chars; max ${MAX_PERSONALITY_LEN})`);
    }
    personality = o.personality;
  }

  return {
    tickIntervalSec,
    destinations,
    quietHours,
    llm: {
      enabled: typeof llmRaw.enabled === "boolean" ? llmRaw.enabled : true,
      provider: llmProvider,
      model: typeof llmRaw.model === "string" ? llmRaw.model : null,
    },
    personality,
    dedupWindowMin,
  };
}
