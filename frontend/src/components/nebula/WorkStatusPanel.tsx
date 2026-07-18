import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { errText, fmtDuration } from "@/hooks";
import { pollInterval, useServerEventsStatus } from "@/hooks/useServerEvents";
import { queryKeys } from "@/lib/queryKeys";
import type { WorkMalItem, WorkStatusItem, WorkWarehouseItem } from "@/types";
import { ProgressBar } from "./ProgressBar";
import { GlassCard, CardContent, CardDescription, CardHeader, CardTitle } from "./GlassCard";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function pctForItem(item: WorkStatusItem): number {
  if (item.kind === "setup") {
    return item.elapsed_seconds != null && item.elapsed_seconds > 3 ? 12 : 6;
  }
  const p = "progress_pct" in item ? item.progress_pct : null;
  if (p != null && Number.isFinite(p)) return Math.max(0, Math.min(100, p));
  const el = "elapsed_seconds" in item ? item.elapsed_seconds : 0;
  return el > 2 ? 8 : 4;
}

function malProgressLine(m: WorkMalItem): string | null {
  const d = m.details;
  if (!d) return null;
  const ing = d.ingest_progress;
  if (ing && typeof ing === "object" && ing !== null) {
    const o = ing as Record<string, unknown>;
    const bi = o.batch_index;
    const bt = o.batch_total;
    if (typeof bi === "number" && typeof bt === "number") {
      const cur = o.current_mal_id;
      const curId = typeof cur === "number" ? ` · MAL #${cur}` : "";
      return `Batch ${bi} of ${bt}${curId}`;
    }
  }
  return null;
}

function warehouseTitle(w: WorkWarehouseItem): string {
  return `${w.source} · ${w.mode} · ${w.instance_name} · ${w.trigger}`;
}

function warehouseSubtitle(w: WorkWarehouseItem): string {
  const stage = w.stage_note ? `${w.stage} (${w.stage_note})` : w.stage;
  return stage;
}

const POLL_MS_ACTIVE = 2_000;
const POLL_MS_RELAXED = 30_000;

export function WorkStatusPanel({
  className,
  title = "Active work",
  description,
  dense = false,
}: {
  className?: string;
  title?: string;
  description?: string;
  dense?: boolean;
}): JSX.Element {
  const { connected: sseConnected } = useServerEventsStatus();
  const refetchInterval = pollInterval(sseConnected, POLL_MS_ACTIVE, POLL_MS_RELAXED);
  const q = useQuery({
    queryKey: queryKeys.workStatus,
    queryFn: api.workStatus,
    refetchInterval,
  });

  const items = q.data?.items ?? [];
  // Reflect the interval this panel is actually polling at, not a
  // hardcoded number that drifts from reality when SSE is connected.
  const pollingCopy = sseConnected
    ? `Live updates via server events (${refetchInterval / 1000}s fallback poll).`
    : `Polls every ${refetchInterval / 1000}s.`;
  const effectiveDescription =
    description ?? `Warehouse syncs, MAL pipelines, and setup-wizard imports. ${pollingCopy} ETA uses recent run history when available.`;

  return (
    <GlassCard className={className}>
      <CardHeader className={dense ? "pb-2" : undefined}>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{effectiveDescription}</CardDescription>
      </CardHeader>
      <CardContent className={cn("space-y-4", dense ? "pt-0" : undefined)}>
        {q.isLoading && !q.data ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : null}
        {q.isError ? (
          <p className="text-sm text-critical">Could not load work status: {errText(q.error)}</p>
        ) : null}
        {!q.isLoading && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Idle — no warehouse sync, MAL job, or setup import running.</p>
        ) : null}
        {items.map((item, idx) => {
          const key =
            item.kind === "warehouse"
              ? `wh-${item.run_id}`
              : item.kind === "mal"
                ? `mal-${item.run_id}`
                : `setup-${idx}`;
          const pct = pctForItem(item);
          if (item.kind === "warehouse") {
            return (
              <div
                key={key}
                className="space-y-2 rounded-xl border border-border bg-muted/40 px-3 py-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium text-foreground/95">{warehouseTitle(item)}</span>
                  <span className="text-xs text-muted-foreground">run #{item.run_id}</span>
                </div>
                <p className="text-xs text-muted-foreground">{warehouseSubtitle(item)}</p>
                <ProgressBar value={pct} label="Estimated completion (from past runs)" />
                <p className="text-xs text-muted-foreground">
                  Elapsed {fmtDuration(item.elapsed_seconds)} · rows {item.records_processed}
                  {item.eta_seconds != null ? ` · ETA ${fmtDuration(item.eta_seconds)}` : ""}
                  {item.history_sample_size > 0 ? ` · history n=${item.history_sample_size}` : " · no ETA yet (no finished runs sample)"}
                </p>
              </div>
            );
          }
          if (item.kind === "mal") {
            const extra = malProgressLine(item);
            return (
              <div
                key={key}
                className="space-y-2 rounded-xl border border-border bg-muted/40 px-3 py-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium text-foreground/95">MAL {item.job_type}</span>
                  <span className="text-xs text-muted-foreground">run #{item.run_id}</span>
                </div>
                {extra ? <p className="text-xs text-muted-foreground">{extra}</p> : null}
                <ProgressBar value={pct} label="Estimated completion (from past jobs)" />
                <p className="text-xs text-muted-foreground">
                  Elapsed {fmtDuration(item.elapsed_seconds)}
                  {item.eta_seconds != null ? ` · ETA ${fmtDuration(item.eta_seconds)}` : ""}
                  {item.history_sample_size > 0 ? ` · history n=${item.history_sample_size}` : " · no ETA yet (first runs)"}
                </p>
              </div>
            );
          }
          return (
            <div
              key={key}
              className="space-y-2 rounded-xl border border-warn/25 bg-warn/5 px-3 py-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-foreground/95">{item.stage}</span>
                <span className="text-xs text-muted-foreground">setup</span>
              </div>
              <p className="text-xs text-muted-foreground">{item.stage_note}</p>
              <ProgressBar value={pct} label="In progress" />
              {item.elapsed_seconds != null ? (
                <p className="text-xs text-muted-foreground">Elapsed {fmtDuration(item.elapsed_seconds)}</p>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </GlassCard>
  );
}
