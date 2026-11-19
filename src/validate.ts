import type { NotifyConfig, ChannelName, RuntimeBridge } from "./types.js";
import type { TickLogger } from "./tick.js";

export const SEND_FN_BY_CHANNEL: Record<ChannelName, string> = {
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
 * per-channel send function is checked directly.
 */
export function channelLooksUsable(runtime: RuntimeBridge, channel: ChannelName): boolean {
  if (typeof runtime.channel.outbound?.loadAdapter === "function") return true;
  const ns = (runtime.channel as Record<string, unknown>)[channel] as Record<string, unknown> | undefined;
  return Boolean(ns && typeof ns[SEND_FN_BY_CHANNEL[channel]] === "function");
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
