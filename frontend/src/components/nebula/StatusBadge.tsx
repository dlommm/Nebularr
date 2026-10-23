import { cn } from "@/lib/utils";

/** Status as a coloured dot plus words — colour only ever means status. */
function tone(status: string): string {
  const s = status.toLowerCase();
  if (s === "running" || s === "pending" || s === "queued" || s === "processing") return "text-signal";
  if (s === "retrying" || s === "warning" || s === "partial" || s === "skipped") return "text-warn";
  if (s === "success" || s === "ok" || s === "idle" || s === "done" || s === "completed") return "text-ok";
  if (s === "failed" || s === "critical" || s === "dead_letter" || s === "error") return "text-critical";
  return "text-muted-foreground";
}

export function StatusBadge({ status, className }: { status: string; className?: string }): JSX.Element {
  const s = String(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[13px] whitespace-nowrap before:size-2 before:shrink-0 before:rounded-full before:bg-current",
        tone(s),
        className,
      )}
    >
      {s.replace(/_/g, " ")}
    </span>
  );
}
