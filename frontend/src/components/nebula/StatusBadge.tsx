import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const known = new Set(["running", "success", "failed", "ok", "warning", "critical", "idle", "pending", "queued", "retrying", "dead_letter"]);

function tone(status: string): string {
  const s = status.toLowerCase();
  if (s === "running" || s === "pending" || s === "queued" || s === "retrying") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  }
  if (s === "success" || s === "ok" || s === "idle") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  }
  if (s === "failed" || s === "critical" || s === "dead_letter") {
    return "border-rose-500/45 bg-rose-500/10 text-rose-200";
  }
  if (s === "warning") {
    return "border-amber-400/45 bg-amber-400/10 text-amber-100";
  }
  return "border-white/15 bg-white/5 text-muted-foreground";
}

export function StatusBadge({ status, className }: { status: string; className?: string }): JSX.Element {
  const s = String(status);
  const lower = s.toLowerCase();
  return (
    <Badge variant="outline" className={cn("font-mono text-[0.65rem] uppercase tracking-wide", known.has(lower) ? tone(s) : tone(lower), className)}>
      {s}
    </Badge>
  );
}
