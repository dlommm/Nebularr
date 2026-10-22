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
