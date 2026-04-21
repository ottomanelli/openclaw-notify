import type {
  ChannelName,
  Destination,
  DeliveryResult,
  RuntimeBridge,
  TelegramSendOpts,
  SlackSendOpts,
  SignalSendOpts,
} from "./types.js";

// Per-channel hard ceilings on message length. The LLM is configured for
// max_tokens=500 so it rarely approaches these, but a malformed or verbose
// output shouldn't reach a channel that will reject it outright. Truncate
// with ellipsis as a last-resort guard. Values track published per-channel
// limits with a small safety margin.
const CHANNEL_MAX_MESSAGE_LEN: Record<ChannelName, number> = {
  telegram: 4000,    // published: 4096
  slack:    39000,   // published: 40000
  discord:  1990,    // published: 2000
  signal:   1900,    // published varies; conservative ~2000
  imessage: 4000,    // effectively unbounded; keep it reasonable
};

function capMessage(channel: ChannelName, message: string): string {
  const max = CHANNEL_MAX_MESSAGE_LEN[channel];
  if (message.length <= max) return message;
  return message.slice(0, max - 1) + "…";
}

async function sendOne(
  runtime: RuntimeBridge,
  dest: Destination,
  message: string,
): Promise<{ messageId: string }> {
  const capped = capMessage(dest.channel, message);
  switch (dest.channel) {
    case "telegram": {
      const ns = runtime.channel.telegram;
      if (!ns?.sendMessageTelegram) throw new Error("telegram channel not registered");
      const opts: TelegramSendOpts = { textMode: "markdown" };
      if (dest.threadId != null) opts.messageThreadId = Number(dest.threadId);
      return ns.sendMessageTelegram(dest.chatId, capped, opts);
    }
    case "slack": {
      const ns = runtime.channel.slack;
      if (!ns?.sendMessageSlack) throw new Error("slack channel not registered");
      const opts: SlackSendOpts = {};
      if (typeof dest.threadId === "string") opts.threadTs = dest.threadId;
      return ns.sendMessageSlack(dest.chatId, capped, opts);
    }
    case "discord": {
      const ns = runtime.channel.discord;
      if (!ns?.sendMessageDiscord) throw new Error("discord channel not registered");
      return ns.sendMessageDiscord(dest.chatId, capped);
    }
    case "signal": {
      const ns = runtime.channel.signal;
      if (!ns?.sendMessageSignal) throw new Error("signal channel not registered");
      const opts: SignalSendOpts = { textMode: "markdown" };
      return ns.sendMessageSignal(dest.chatId, capped, opts);
    }
    case "imessage": {
      const ns = runtime.channel.imessage;
      if (!ns?.sendMessageIMessage) throw new Error("imessage channel not registered");
      return ns.sendMessageIMessage(dest.chatId, capped);
    }
  }
}

export async function deliver(
  runtime: RuntimeBridge,
  dest: Destination,
  message: string,
): Promise<DeliveryResult> {
  try {
    const { messageId } = await sendOne(runtime, dest, message);
    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
