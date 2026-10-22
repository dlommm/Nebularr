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
    <GlassCard className={cn("min-h-[104px] min-w-0 rounded-none border-0 border-t border-border bg-transparent py-4", className)} size="sm">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 px-0 pb-1">
        <CardTitle className="text-[13px] font-normal text-muted-foreground">{label}</CardTitle>
        {Icon ? <Icon className="size-4 text-muted-foreground/70" strokeWidth={1.75} aria-hidden /> : null}
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <div className="cond text-[44px] leading-[0.9] font-[640] tabular-nums text-foreground">{value}</div>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </GlassCard>
  );
}
