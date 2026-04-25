import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  description,
  icon: Icon,
  className,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 bg-white/[0.02] py-12 text-center", className)}>
      {Icon ? <Icon className="size-8 text-cyan-400/50" strokeWidth={1.25} aria-hidden /> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-sm text-xs text-muted-foreground">{description}</p> : null}
      {children}
    </div>
  );
}
