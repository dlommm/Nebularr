import type { HealthDimensions, HealthState } from "@/types";
import { DIM_LABELS } from "@/constants/health";
import { cn } from "@/lib/utils";

function pillClass(s: HealthState | undefined): string {
  const v = s ?? "ok";
  if (v === "ok") return "text-ok";
  if (v === "warning") return "text-warn";
  return "text-critical";
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
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", className)} role="group" aria-label="Health by subsystem">
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
              "inline-flex items-center gap-1.5 before:size-1.5 before:rounded-full before:bg-current",
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
