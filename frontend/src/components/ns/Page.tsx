import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { HealthState } from "@/types";
import { healthColor } from "@/lib/ns";

/** Page title: huge condensed type with an optional lead and an aside (figures
    or actions) aligned to its baseline. */
export function PageHead({
  title,
  lead,
  aside,
  className,
}: {
  title: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={cn("flex flex-wrap items-end justify-between gap-x-10 gap-y-4 pt-10 pb-7 sm:pt-12", className)}>
      <div className="min-w-0">
        <h1 className="cond animate-rise text-[clamp(56px,8vw,112px)] leading-[0.84] font-[760]">{title}</h1>
        {lead ? <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted-foreground">{lead}</p> : null}
      </div>
      {aside ? <div className="min-w-0">{aside}</div> : null}
    </section>
  );
}

export function SectionHead({
  title,
  aside,
  id,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  id?: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2", className)}>
      <h2 id={id} className="cond text-[30px] leading-none font-bold">
        {title}
      </h2>
      {aside ? <div className="text-[13px] text-muted-foreground">{aside}</div> : null}
    </div>
  );
}

/** Big figures on hairlines. */
export function Figures({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  // The 1px gap over a border-coloured ground draws the hairlines between
  // cells in every column count without per-breakpoint border rules.
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px border-y border-border bg-border sm:grid-cols-3 lg:grid-flow-col lg:auto-cols-fr lg:grid-cols-none",
        "[&>*]:bg-background [&>*]:py-5 [&>*]:pr-4 [&>*]:pl-5 lg:[&>*:first-child]:pl-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Figure({
  value,
  label,
  tone,
  size = "lg",
  style,
}: {
  value: ReactNode;
  label: ReactNode;
  tone?: "warn" | "critical" | "ok" | "signal";
  size?: "md" | "lg";
  style?: React.CSSProperties;
}): JSX.Element {
  return (
    <div className="min-w-0 animate-rise" style={style}>
      <div
        className={cn(
          "cond leading-[0.9] font-[640] tabular-nums",
          size === "lg" ? "text-[clamp(38px,4.4vw,56px)]" : "text-[40px]",
          tone === "warn" && "text-warn",
          tone === "critical" && "text-critical",
          tone === "ok" && "text-ok",
          tone === "signal" && "text-signal",
        )}
      >
        {value}
      </div>
      <div className="mt-2 text-[13px] text-muted-foreground">{label}</div>
    </div>
  );
}

/** A status dot with a soft pulse ring. */
export function StatusDot({ state, className }: { state: HealthState | string | undefined; className?: string }): JSX.Element {
  const color = healthColor(state);
  return (
    <span aria-hidden className={cn("relative inline-block size-3 shrink-0 rounded-full align-[0.1em]", color, className)}>
      <span className={cn("absolute inset-0 animate-beat rounded-full", color)} />
    </span>
  );
}

/** A row in a hairline list. */
export function Row({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn("border-t border-border py-4 transition-colors hover:bg-muted/60", className)}>{children}</div>;
}

/** Full-width hairline action: label on the left, a short hint on the right. */
export function ActionRow({
  children,
  hint,
  danger,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { hint?: ReactNode; danger?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-[52px] w-full items-center justify-between gap-4 border-t border-border px-4 text-left text-sm transition-[background-color,padding] last:border-b hover:bg-muted hover:pl-5 disabled:pointer-events-none disabled:opacity-50",
        danger ? "text-critical hover:bg-critical/10" : "text-foreground",
        className,
      )}
      {...props}
    >
      <span>{children}</span>
      {hint ? <span className="shrink-0 text-xs text-subtle-foreground">{hint}</span> : null}
    </button>
  );
}
