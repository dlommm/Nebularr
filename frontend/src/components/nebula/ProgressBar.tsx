import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export function ProgressBar({
  value,
  label,
  className,
  showPct = true,
}: {
  value: number;
  label?: string;
  className?: string;
  showPct?: boolean;
}): JSX.Element {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className={cn("w-full space-y-2", className)}>
      {label || showPct ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          {label ? <span>{label}</span> : <span />}
          {showPct ? <span className="font-mono tabular-nums text-foreground/90">{pct.toFixed(0)}%</span> : null}
        </div>
      ) : null}
      <Progress
        value={pct}
        className="h-2 w-full min-w-0 flex-col gap-0 [&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:bg-white/10 [&_[data-slot=progress-indicator]]:bg-gradient-to-r [&_[data-slot=progress-indicator]]:from-cyan-400 [&_[data-slot=progress-indicator]]:to-violet-500"
      />
    </div>
  );
}
