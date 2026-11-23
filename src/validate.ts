import type { NotifyConfig, ChannelName, KnownChannel, RuntimeBridge } from "./types.js";
import type { TickLogger } from "./tick.js";

export const SEND_FN_BY_CHANNEL: Record<KnownChannel, string> = {
  telegram: "sendMessageTelegram",
  discord:  "sendMessageDiscord",
  slack:    "sendMessageSlack",
  signal:   "sendMessageSignal",
  imessage: "sendMessageIMessage",
};

/**
 * Whether a channel can be sent to. On current OpenClaw the adapter is loaded when a
 * message is sent, so all that can be said here is that the loader exists; a channel
 * that turns out to be missing fails at send time and is retried. On older OpenClaw the
 * per-channel send function is checked directly (only the five channels it had one for).
 */
export function channelLooksUsable(runtime: RuntimeBridge, channel: ChannelName): boolean {
  if (typeof runtime.channel.outbound?.loadAdapter === "function") return true;
  const fnName = (SEND_FN_BY_CHANNEL as Record<string, string | undefined>)[channel];
  if (!fnName) return false;
  const ns = (runtime.channel as Record<string, unknown>)[channel] as Record<string, unknown> | undefined;
  return Boolean(ns && typeof ns[fnName] === "function");
}

/**
 * Whether a destination can be delivered from THIS process, asked for real: a chat
 * needs its channel's adapter to load here. Inside the Gateway every installed channel
 * loads. In a plain CLI process (a script running `openclaw notify send` while the
 * Gateway is down) none does, and only destinations made of webhooks can be delivered.
 */
export async function destinationUsableHere(
  runtime: RuntimeBridge,
  dest: { channel: ChannelName; chatId: string | null },
): Promise<boolean> {
  if (dest.chatId == null) return true;
  const loadAdapter = runtime.channel.outbound?.loadAdapter;
  if (typeof loadAdapter === "function") {
    return Boolean((await loadAdapter(dest.channel).catch(() => undefined))?.sendText);
  }
  return channelLooksUsable(runtime, dest.channel);
}

export function validateDestinations(
  cfg: NotifyConfig,
  runtime: RuntimeBridge,
  logger: TickLogger,
): Set<string> {
  const active = new Set<string>();
  for (const [name, dest] of Object.entries(cfg.destinations)) {
    if (channelLooksUsable(runtime, dest.channel)) {
      active.add(name);
    } else {
      logger.warn(`notify: destination "${name}" uses channel "${dest.channel}" which is not registered; rows for it will not be flushed`);
    }
  }
  if (!active.has("default")) {
    throw new Error("notify: destinations.default is unusable (channel not registered); fix your config or install the channel plugin");
  }
  return active;
}
