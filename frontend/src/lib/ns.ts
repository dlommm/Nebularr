import type { HealthState } from "@/types";

export function healthColor(state: HealthState | string | undefined): string {
  if (state === "warning") return "bg-warn";
  if (state === "critical") return "bg-critical";
  if (state === "ok") return "bg-ok";
  return "bg-subtle-foreground";
}

/** Underlined text link/button used for row actions ("Review run →"). */
export const actionLinkClass =
  "inline-flex min-h-11 items-center border-b border-input px-1 text-sm text-foreground transition-colors hover:border-foreground";

/** Library-scale sizes for headline figures: "186.4 TB", "3.2 GB", "640 MB". */
export function fmtBigBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "0 GB";
  const tb = bytes / 1e12;
  if (tb >= 1) return `${tb >= 100 ? tb.toFixed(0) : tb.toFixed(1)} TB`;
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}
