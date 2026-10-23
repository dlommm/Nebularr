/** Plain-English time for status sentences and row metadata. */

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}

/** "just now", "4 min ago", "9 h ago", "yesterday", "3 days ago". */
export function relTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const mins = minutesBetween(then, now);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** Duration since, without "ago": "9 h", "36 min". */
export function sinceShort(iso: string | null | undefined, now: Date = new Date()): string {
  return relTime(iso, now).replace(/ ago$/, "");
}

/** 24-hour clock, local time: "14:52". */
export function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "14:52" today, "yesterday", "Mon", or "Oct 2". */
export function dayOrClock(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;
  if (d.getTime() >= startOfToday) return clock(iso);
  if (d.getTime() >= startOfToday - dayMs) return "yesterday";
  if (d.getTime() >= startOfToday - 6 * dayMs) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
