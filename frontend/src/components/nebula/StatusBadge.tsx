import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const known = new Set(["running", "success", "failed", "ok", "warning", "critical", "idle", "pending", "queued", "retrying", "dead_letter"]);

function tone(status: string): string {
  const s = status.toLowerCase();
  if (s === "running" || s === "pending" || s === "queued" || s === "retrying" || s === "warning") {
    return "border-warn/35 bg-warn/10 text-warn";
  }
  if (s === "success" || s === "ok" || s === "idle") {
    return "border-ok/35 bg-ok/10 text-ok";
  }
  if (s === "failed" || s === "critical" || s === "dead_letter") {
    return "border-critical/40 bg-critical/10 text-critical";
  }
  return "border-border bg-muted text-muted-foreground";
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
