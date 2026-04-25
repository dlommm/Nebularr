import type { HealthDimensions, HealthState } from "@/types";
import { cn } from "@/lib/utils";

const DIM_LABELS: Record<keyof HealthDimensions, string> = {
  webhooks: "Queues",
  sync: "Sync",
  integrations: "Arr",
  mal: "MAL",
};

function pillClass(s: HealthState | undefined): string {
  const v = s ?? "ok";
  if (v === "ok") return "border-emerald-500/50 bg-emerald-500/10 text-emerald-200";
  if (v === "warning") return "border-amber-500/50 bg-amber-500/10 text-amber-200";
  return "border-rose-500/50 bg-rose-500/10 text-rose-200";
}

type HealthPillsRowProps = {
  dimensions?: HealthDimensions;
  /** Per-dimension reason codes; shown as native tooltip */
  reasonMap?: Partial<Record<keyof HealthDimensions, string[]>>;
  className?: string;
  size?: "sm" | "md";
};

export function HealthPillsRow({ dimensions, reasonMap, className, size = "sm" }: HealthPillsRowProps): JSX.Element | null {
  if (!dimensions) return null;
  const keys = (Object.keys(DIM_LABELS) as (keyof HealthDimensions)[]).filter((k) => dimensions[k] != null);
  if (!keys.length) return null;
  const text = size === "sm" ? "text-[10px] sm:text-[11px]" : "text-xs";
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} role="group" aria-label="Health by subsystem">
      {keys.map((k) => {
        const st = dimensions[k]!;
        const titleParts = [DIM_LABELS[k], st];
        const r = reasonMap?.[k];
        if (r?.length) titleParts.push(r.join(", "));
        return (
          <span
            key={k}
            title={titleParts.join(" — ")}
            className={cn(
              "inline-flex items-center rounded-full border px-1.5 py-0.5 font-medium",
              text,
              pillClass(st),
            )}
          >
            {DIM_LABELS[k]}: {st}
          </span>
        );
      })}
    </div>
  );
}
