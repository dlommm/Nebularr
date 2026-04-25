import type { ReactNode } from "react";
import { GlassCard, CardContent, CardHeader, CardTitle } from "./GlassCard";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: LucideIcon;
  className?: string;
}): JSX.Element {
  return (
    <GlassCard glow="cyan" className={cn("min-h-[112px] min-w-0 border-cyan-500/15", className)} size="sm">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-1">
        <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</CardTitle>
        {Icon ? <Icon className="size-4 text-cyan-300/80" strokeWidth={1.75} aria-hidden /> : null}
      </CardHeader>
      <CardContent className="pt-0">
        <div className="font-heading text-2xl font-semibold tabular-nums text-foreground">{value}</div>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </GlassCard>
  );
}
