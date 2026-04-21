import type { QuietHoursConfig } from "./types.js";

function minutesOfDayInTz(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // "24:00" from Intl sometimes indicates midnight — normalize.
  return (hh % 24) * 60 + mm;
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

export function nowInQuietHours(
  cfg: QuietHoursConfig | null,
  now: Date = new Date(),
): boolean {
  if (!cfg) return false;
  const cur = minutesOfDayInTz(now, cfg.tz);
  const start = parseHHMM(cfg.start);
  const end = parseHHMM(cfg.end);

  if (start === end) return false;

  // Same-day window: start < end → quiet if start <= cur < end
  if (start < end) {
    return cur >= start && cur < end;
  }
  // Midnight-wrap: quiet if cur >= start OR cur < end
  return cur >= start || cur < end;
}
