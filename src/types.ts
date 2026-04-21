export type ChannelName = "telegram" | "discord" | "slack" | "signal" | "imessage";

export type Destination = {
  channel: ChannelName;
  chatId: string;
  threadId: string | number | null;
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
  | { ok: true; messageId?: string }
  | { ok: false; error: string };

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

export type RuntimeBridge = {
  modelAuth: {
    resolveApiKeyForProvider: (params: { provider: string }) => Promise<{ apiKey?: string }>;
  };
  channel: {
    telegram?: { sendMessageTelegram: (to: string, text: string, opts?: TelegramSendOpts) => Promise<SendResult> };
    discord?:  { sendMessageDiscord:  (to: string, text: string) => Promise<SendResult> };
    slack?:    { sendMessageSlack:    (to: string, text: string, opts?: SlackSendOpts) => Promise<SendResult> };
    signal?:   { sendMessageSignal:   (to: string, text: string, opts?: SignalSendOpts) => Promise<SendResult> };
    imessage?: { sendMessageIMessage: (to: string, text: string) => Promise<SendResult> };
  };
};
