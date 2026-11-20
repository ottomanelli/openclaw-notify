export type ChannelName = "telegram" | "discord" | "slack" | "signal" | "imessage";

// A web address that receives each delivered message as JSON (see deliver.ts), so a
// notification can reach something that is not a chat: a phone app's push relay, a
// display, another service.
export type WebhookTarget = {
  url: string;
  headers: Record<string, string>;
};

// Where a named destination delivers. A chat, a list of webhooks, or both. With a chat,
// the chat is what decides success and the webhooks are best-effort; with webhooks
// only, they decide. `channel` also picks the message style when there is no chat.
export type Destination = {
  channel: ChannelName;
  chatId: string | null;
  threadId: string | number | null;
  webhooks?: WebhookTarget[];
};

export type QuietHoursConfig = {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
  tz: string;    // IANA tz
};

export type LlmConfig = {
  enabled: boolean;
  provider: string | null;
  model: string | null;
};

export type NotifyConfig = {
  tickIntervalSec: number;
  destinations: Record<string, Destination>;
  quietHours: QuietHoursConfig | null;
  llm: LlmConfig;
  personality: string | null;
  dedupWindowMin: number;
};

export type QueueRow = {
  id: number;
  source: string;
  category: string | null;
  destination: string;
  raw_data: string; // JSON string
  should_format: 0 | 1;
  dedup_key: string | null;
  created_at: number; // unix ms
  reserved_at: number | null; // set while tick is mid-flight for this row
  sent_at: number | null;
  delivery_attempts: number;
  failed_at: number | null;
};

export type ParsedRawData = {
  text: string;
  priority?: string;
  due_date?: string;
  [key: string]: unknown;
};

export type DeliveryResult =
  | { ok: true; messageId?: string; webhookErrors?: string[] }
  | { ok: false; error: string };

// What a webhook is told about the message besides its text.
export type DeliveryMeta = {
  destination?: string;
  sources?: string[];
  categories?: string[];
  count?: number;
};

// Channel-specific opts shapes. These document the exact keys deliver.ts
// passes to each channel plugin; if a channel plugin renames keys, markdown
// and threading silently stop working. Keeping the shapes here means the
// type checker catches drift at the deliver.ts call site.
export type TelegramSendOpts = {
  textMode?: "markdown" | "plain";
  messageThreadId?: number;
};
export type SlackSendOpts = {
  threadTs?: string;
};
export type SignalSendOpts = {
  textMode?: "markdown" | "plain";
};

type SendResult = { messageId: string; chatId?: string };

// Current OpenClaw: every channel is sent through one "outbound adapter", loaded by
// channel id. Only the fields this plugin passes are typed here.
export type OutboundSendContext = {
  /** The host's OpenClaw config (api.config). */
  cfg: unknown;
  to: string;
  text: string;
  accountId?: string | null;
  threadId?: string | number | null;
};
export type OutboundAdapter = {
  sendText?: (ctx: OutboundSendContext) => Promise<{ messageId?: string; channel?: string }>;
};

export type RuntimeBridge = {
  modelAuth: {
    resolveApiKeyForProvider: (params: { provider: string }) => Promise<{ apiKey?: string }>;
  };
  channel: {
    /** Current OpenClaw. When present it is used for every channel. */
    outbound?: { loadAdapter: (id: string) => Promise<OutboundAdapter | undefined> };
    // Older OpenClaw: one send function per channel. Kept as a fallback.
    telegram?: { sendMessageTelegram: (to: string, text: string, opts?: TelegramSendOpts) => Promise<SendResult> };
    discord?:  { sendMessageDiscord:  (to: string, text: string) => Promise<SendResult> };
    slack?:    { sendMessageSlack:    (to: string, text: string, opts?: SlackSendOpts) => Promise<SendResult> };
    signal?:   { sendMessageSignal:   (to: string, text: string, opts?: SignalSendOpts) => Promise<SendResult> };
    imessage?: { sendMessageIMessage: (to: string, text: string) => Promise<SendResult> };
  };
};
