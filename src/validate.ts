import type { NotifyConfig, ChannelName, RuntimeBridge } from "./types.js";
import type { TickLogger } from "./tick.js";

export const SEND_FN_BY_CHANNEL: Record<ChannelName, string> = {
  telegram: "sendMessageTelegram",
  discord:  "sendMessageDiscord",
  slack:    "sendMessageSlack",
  signal:   "sendMessageSignal",
  imessage: "sendMessageIMessage",
};

export function validateDestinations(
  cfg: NotifyConfig,
  runtime: RuntimeBridge,
  logger: TickLogger,
): Set<string> {
  const active = new Set<string>();
  for (const [name, dest] of Object.entries(cfg.destinations)) {
    const fnName = SEND_FN_BY_CHANNEL[dest.channel];
    const ns = (runtime.channel as Record<string, unknown>)[dest.channel] as Record<string, unknown> | undefined;
    if (ns && typeof ns[fnName] === "function") {
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
