import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { IntegrityAuditResult } from "../types";
import { PATHS } from "../routes/paths";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate, fmtDuration } from "../hooks";
import { useActionError } from "../hooks/useActionError";
import { pollInterval, useServerEventsStatus } from "../hooks/useServerEvents";
import { useSyncActions } from "../hooks/useSyncActions";
import { queryKeys } from "../lib/queryKeys";
import { clampPageOffset } from "./syncQueueShared";
import { StatusPill } from "../components/ui";
import { GlassCard, CardContent, CardHeader, CardTitle } from "../components/nebula/GlassCard";
import { useConfirmDialog } from "../components/nebula/ConfirmDialog";
import { ProgressBar } from "../components/nebula/ProgressBar";
import { QueryErrorNotice } from "../components/nebula/QueryErrorNotice";
import { WorkStatusPanel } from "../components/nebula/WorkStatusPanel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Activity, Inbox, ListOrdered, Wrench, Zap } from "lucide-react";
const TAB_VALUES = ["overview", "runs", "webhooks", "manual"] as const;
type TabValue = (typeof TAB_VALUES)[number];

const WEBHOOK_JOB_STATUSES = ["all", "queued", "retrying", "done", "dead_letter"] as const;
type WebhookJobStatus = (typeof WEBHOOK_JOB_STATUSES)[number];
const WEBHOOK_JOBS_PAGE_SIZE = 50;

function tabFromParam(raw: string | null): TabValue {
  if (raw && (TAB_VALUES as readonly string[]).includes(raw)) return raw as TabValue;
  return "overview";
}

export function SyncQueuePage(): JSX.Element {
  usePageTitle("Sync & Queue");
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabFromParam(searchParams.get("tab"));
  const setTab = (value: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value === "overview") next.delete("tab");
    else next.set("tab", value);
    setSearchParams(next, { replace: true });
  };

  const queryClient = useQueryClient();
  const { runAction } = useActionError();
  const { requestConfirm, confirmDialog } = useConfirmDialog();
  const { runIncrementalSync, runFullSync, runIntegrityAudit, confirmDialog: syncActionsConfirmDialog } = useSyncActions();
  const [stuckClearAllLocks, setStuckClearAllLocks] = useState(false);
  const [stuckClearMalLock, setStuckClearMalLock] = useState(true);
  const [stuckClearMalJobs, setStuckClearMalJobs] = useState(true);
  const [stuckClearWhLocks, setStuckClearWhLocks] = useState(false);
  const [stuckFailWhSync, setStuckFailWhSync] = useState(false);

  // While the SSE stream is connected, events drive cache invalidation and
  // polling relaxes to a slow safety net; on disconnect the old cadence returns.
  const { connected: sseConnected } = useServerEventsStatus();
  const runs = useQuery({
    queryKey: queryKeys.runs,
    queryFn: api.recentRuns,
    refetchInterval: pollInterval(sseConnected, 15_000, 60_000),
    placeholderData: keepPreviousData,
  });
  const webhookQueue = useQuery({
    queryKey: queryKeys.webhookQueue,
    queryFn: api.webhookQueue,
    refetchInterval: pollInterval(sseConnected, 15_000, 60_000),
  });
  const [webhookJobsStatus, setWebhookJobsStatus] = useState<WebhookJobStatus>("all");
  const [webhookJobsOffset, setWebhookJobsOffset] = useState(0);
  const webhookJobs = useQuery({
    queryKey: queryKeys.webhookJobs(webhookJobsStatus, webhookJobsOffset),
    queryFn: () => api.webhookJobs(webhookJobsStatus, WEBHOOK_JOBS_PAGE_SIZE, webhookJobsOffset),
    refetchInterval: pollInterval(sseConnected, 15_000, 60_000),
    placeholderData: keepPreviousData,
  });
  const webhookJobRows = webhookJobs.data?.items ?? [];
  const webhookJobsTotal = webhookJobs.data?.total ?? 0;
  // A bulk requeue/replay (or any other action) can shrink `total` out from
  // under the page the user is currently viewing — snap back to the last
  // page that still has rows instead of showing an empty page forever.
  useEffect(() => {
    if (!webhookJobs.data) return;
    const clamped = clampPageOffset(webhookJobsOffset, webhookJobs.data.total, WEBHOOK_JOBS_PAGE_SIZE);
    if (clamped !== webhookJobsOffset) setWebhookJobsOffset(clamped);
  }, [webhookJobs.data, webhookJobsOffset]);
  const queueConfig = useQuery({
    queryKey: queryKeys.queueConfig,
    queryFn: api.queueConfig,
    enabled: tab === "manual",
    staleTime: 60_000,
  });
  const [queueDraft, setQueueDraft] = useState({
    batch_size: "",
    max_attempts: "",
    backoff_base_seconds: "",
    backoff_cap_seconds: "",
  });
  const syncProgress = useQuery({
    queryKey: queryKeys.syncProgress,
    queryFn: api.syncProgress,
    // Fast polling only matters while something is actually running; once
    // idle (and SSE is down, so we can't rely on a push update either),
    // relax to a slower safety-net cadence instead of hammering every 2s.
    refetchInterval: (query) => (sseConnected ? 30_000 : query.state.data?.running === false ? 10_000 : 2_000),
  });
  const workStatus = useQuery({
    queryKey: queryKeys.workStatus,
    queryFn: api.workStatus,
    refetchInterval: () => (sseConnected ? 30_000 : syncProgress.data?.running === false ? 10_000 : 2_000),
  });
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: api.status,
    refetchInterval: pollInterval(sseConnected, 15_000, 60_000),
  });
  const stuckState = useQuery({
    queryKey: queryKeys.stuckState,
    queryFn: api.stuckState,
    refetchInterval: tab === "manual" ? 15_000 : false,
    enabled: tab === "manual",
  });

  const requeueWebhookJob = (jobId: number): void => {
    void runAction(async () => {
      const result = await api.requeueWebhook(jobId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.webhookJobs() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.webhookQueue });
      await queryClient.invalidateQueries({ queryKey: queryKeys.status });
      return result;
    }, `requeue webhook job ${jobId}`, { successMessage: `Webhook job ${jobId} requeued` });
  };

  const [integrityResults, setIntegrityResults] = useState<IntegrityAuditResult[] | null>(null);

  const replayDeadLetter = (source: "sonarr" | "radarr"): void => {
    void runAction(async () => {
      const result = await api.replayDeadLetter(source);
      await queryClient.invalidateQueries({ queryKey: queryKeys.webhookJobs() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.webhookQueue });
      await queryClient.invalidateQueries({ queryKey: queryKeys.status });
      return result;
    }, `replay ${source} dead-letter`, { successMessage: `Replaying ${source} dead-letter jobs` });
  };

  const progressPct = useMemo(() => {
    const p = syncProgress.data?.progress_pct;
    if (p != null && Number.isFinite(p)) return Math.max(0, Math.min(100, p));
    return syncProgress.data?.running ? 8 : 0;
  }, [syncProgress.data]);

  return (
    <div className="space-y-6">
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <GlassCard className="min-w-0" size="sm">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Zap className="size-4 text-muted-foreground/70" strokeWidth={1.75} aria-hidden />
              Active syncs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{status.data?.active_sync_count ?? "—"}</p>
            <p className="text-xs text-muted-foreground">running right now</p>
          </CardContent>
        </GlassCard>
        <GlassCard className="min-w-0" size="sm">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Inbox className="size-4 text-muted-foreground/70" strokeWidth={1.75} aria-hidden />
              Webhook queue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{status.data?.webhook_queue_open ?? "—"}</p>
            <p className="text-xs text-muted-foreground">queued + retrying</p>
          </CardContent>
        </GlassCard>
        <GlassCard className="min-w-0" size="sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Sonarr lag</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {status.data ? `${Math.round((status.data.sync_lag_seconds.sonarr ?? 0) * 10) / 10}s` : "—"}
            </p>
          </CardContent>
        </GlassCard>
        <GlassCard className="min-w-0" size="sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Radarr lag</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {status.data ? `${Math.round((status.data.sync_lag_seconds.radarr ?? 0) * 10) / 10}s` : "—"}
            </p>
          </CardContent>
        </GlassCard>
        <GlassCard className="min-w-0" size="sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">MAL processing</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {status.data?.mal_sync?.fetched_success_count ?? 0}/{status.data?.mal_sync?.dubbed_total ?? 0}
            </p>
            <p className="text-xs text-muted-foreground">completed / total dubbed</p>
            <p className="mt-1 text-xs text-muted-foreground">pending: {status.data?.mal_sync?.pending_fetch_count ?? 0}</p>
          </CardContent>
        </GlassCard>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="grid h-auto w-full min-w-0 min-h-9 max-w-full grid-cols-2 gap-0.5 sm:max-w-2xl sm:grid-cols-4">
          <TabsTrigger value="overview" className="min-w-0 gap-1.5">
            <Activity className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Overview</span>
          </TabsTrigger>
          <TabsTrigger value="runs" className="min-w-0 gap-1.5">
            <ListOrdered className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Runs</span>
          </TabsTrigger>
          <TabsTrigger value="webhooks" className="min-w-0 gap-1.5">
            <Inbox className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Webhooks</span>
          </TabsTrigger>
          <TabsTrigger value="manual" className="min-w-0 gap-1.5">
            <Wrench className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Manual</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
            <GlassCard className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">Sync progress</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {syncProgress.data?.running ? (
                  <>
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                      <span>
                        {syncProgress.data.source}/{syncProgress.data.mode} · {syncProgress.data.trigger ?? "—"}
                      </span>
                      <span className="text-muted-foreground">
                        {syncProgress.data.stage}
                        {syncProgress.data.stage_note ? ` (${syncProgress.data.stage_note})` : ""}
                      </span>
                    </div>
                    <ProgressBar value={progressPct} label="Estimated completion" />
                    <p className="text-xs text-muted-foreground">
                      Elapsed {fmtDuration(syncProgress.data.elapsed_seconds ?? 0)} · rows {syncProgress.data.records_processed ?? 0}
                      {syncProgress.data.eta_seconds != null ? ` · ETA ${fmtDuration(syncProgress.data.eta_seconds)}` : ""}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No sync is currently running.</p>
                )}
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  MAL fetched: <strong>{status.data?.mal_sync?.fetched_success_count ?? 0}</strong> /{" "}
                  <strong>{status.data?.mal_sync?.dubbed_total ?? 0}</strong> · pending{" "}
                  <strong>{status.data?.mal_sync?.pending_fetch_count ?? 0}</strong>
                </div>
                <div className="space-y-2 pt-1">
                  <p className="text-[11px] font-medium text-muted-foreground">Incremental</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => runIncrementalSync("sonarr")}>
                      Sonarr incremental
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => runIncrementalSync("radarr")}>
                      Radarr incremental
                    </Button>
                  </div>
                  <p className="text-[11px] font-medium text-muted-foreground">Full</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => runFullSync("sonarr")}>
                      Sonarr full
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => runFullSync("radarr")}>
                      Radarr full
                    </Button>
                  </div>
                </div>
              </CardContent>
            </GlassCard>
            <GlassCard className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">Queue snapshot</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {(webhookQueue.data ?? []).map((row) => (
                    <li key={row.status} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                      <span className="text-muted-foreground">{row.status}</span>
                      <span className="font-mono tabular-nums font-medium">{row.count}</span>
                    </li>
                  ))}
                </ul>
                {!webhookQueue.data?.length ? <p className="text-sm text-muted-foreground">No queue rows yet.</p> : null}
              </CardContent>
            </GlassCard>
          </div>
        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          <GlassCard className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base">Run history</CardTitle>
            </CardHeader>
            <CardContent className="p-0 sm:px-0">
              {runs.isError ? (
                <div className="p-4">
                  <QueryErrorNotice label="run history" retry={() => void runs.refetch()} error={runs.error} />
                </div>
              ) : runs.isLoading ? (
                <div className="space-y-2 p-4">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (runs.data ?? []).length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">No sync runs yet.</p>
              ) : (
                <div className={cn("overflow-x-auto rounded-b-xl", runs.isPlaceholderData && "opacity-60 transition-opacity")}>
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                        <th className="p-3 font-medium">Source</th>
                        <th className="p-3 font-medium">Mode</th>
                        <th className="p-3 font-medium">Status</th>
                        <th className="p-3 font-medium">Started</th>
                        <th className="p-3 font-medium">Finished</th>
                        <th className="p-3 font-medium">Rows</th>
                        <th className="p-3 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(runs.data ?? []).map((run, idx) => (
                        <tr key={`${run.source}-${run.started_at}-${idx}`} className="border-b border-border/60 last:border-0 hover:bg-muted/50">
                          <td className="p-3">{run.source}</td>
                          <td className="p-3 font-mono text-xs">{run.mode}</td>
                          <td className="p-3">
                            <StatusPill status={run.status} />
                          </td>
                          <td className="p-3 text-xs text-muted-foreground">{fmtDate(run.started_at)}</td>
                          <td className="p-3 text-xs text-muted-foreground">{fmtDate(run.finished_at)}</td>
                          <td className="p-3 font-mono tabular-nums">{run.rows_written ?? "—"}</td>
                          <td className="p-3 text-xs text-critical">{run.error_message ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </GlassCard>
        </TabsContent>

        <TabsContent value="webhooks" className="mt-4">
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
            <GlassCard className="min-w-0 lg:col-span-1" size="sm">
              <CardHeader>
                <CardTitle className="text-base">Queue summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  {(webhookQueue.data ?? []).map((row) => (
                    <div className="flex items-center justify-between text-sm" key={row.status}>
                      <span>{row.status}</span>
                      <strong className="tabular-nums">{row.count}</strong>
                    </div>
                  ))}
                </div>
                <div className="space-y-2 border-t border-border pt-3">
                  <p className="text-xs text-muted-foreground">
                    Re-queue every dead-letter job for a source in one go.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => replayDeadLetter("sonarr")}>
                      Replay Sonarr dead letter
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => replayDeadLetter("radarr")}>
                      Replay Radarr dead letter
                    </Button>
                  </div>
                </div>
              </CardContent>
            </GlassCard>
            <GlassCard className="min-w-0 lg:col-span-2">
              <CardHeader className="flex-row items-center justify-between gap-2">
                <CardTitle className="text-base">Webhook jobs</CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  {webhookJobsStatus === "retrying" || webhookJobsStatus === "dead_letter" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={webhookJobsTotal === 0}
                      onClick={() =>
                        requestConfirm({
                          title: `Requeue all ${webhookJobsStatus.replace("_", " ")} jobs?`,
                          description: `Re-queues every job currently in the ${webhookJobsStatus.replace("_", " ")} state (${webhookJobsTotal} total) for immediate processing.`,
                          confirmLabel: "Requeue all",
                          onConfirm: () =>
                            void runAction(
                              () => api.requeueWebhooksBulk({ status: webhookJobsStatus as "retrying" | "dead_letter" }),
                              `requeue all ${webhookJobsStatus}`,
                              {
                                successMessage: `Requeued all ${webhookJobsStatus.replace("_", " ")} jobs`,
                                // `RunActionOptions.invalidate` is `string[][]`; the bare-prefix
                                // form of a parameterized queryKeys factory still types as a union
                                // including its numeric-param branch, so these stay literal.
                                invalidate: [["webhook-jobs"], [...queryKeys.webhookQueue]],
                              },
                            ),
                        })
                      }
                    >
                      Requeue all
                    </Button>
                  ) : null}
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Status
                    <select
                      aria-label="Filter webhook jobs by status"
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                      value={webhookJobsStatus}
                      onChange={(event) => {
                        setWebhookJobsStatus(event.target.value as WebhookJobStatus);
                        setWebhookJobsOffset(0);
                      }}
                    >
                      {WEBHOOK_JOB_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s === "all" ? "All" : s.replace("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </CardHeader>
              <CardContent className="p-0 sm:px-0">
                {webhookJobs.isError ? (
                  <div className="p-4">
                    <QueryErrorNotice label="webhook jobs" retry={() => void webhookJobs.refetch()} error={webhookJobs.error} />
                  </div>
                ) : (
                  <div className={cn("overflow-x-auto", webhookJobs.isPlaceholderData && "opacity-60 transition-opacity")}>
                    <table className="w-full min-w-[760px] text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                          <th className="p-3 font-medium">ID</th>
                          <th className="p-3 font-medium">Source</th>
                          <th className="p-3 font-medium">Type</th>
                          <th className="p-3 font-medium">Status</th>
                          <th className="p-3 font-medium">Attempts</th>
                          <th className="p-3 font-medium">Received</th>
                          <th className="p-3 font-medium">Error</th>
                          <th className="p-3 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {webhookJobRows.map((row) => (
                          <tr key={row.id} className="border-b border-border/60 last:border-0 hover:bg-muted/50">
                            <td className="p-3 font-mono text-xs">{row.id}</td>
                            <td className="p-3">{row.source}</td>
                            <td className="p-3 text-xs text-muted-foreground">{row.event_type ?? "—"}</td>
                            <td className="p-3">
                              <StatusPill status={row.status} />
                            </td>
                            <td className="p-3 font-mono tabular-nums">{row.attempts}</td>
                            <td className="p-3 text-xs text-muted-foreground">{fmtDate(row.received_at)}</td>
                            <td className="max-w-[240px] truncate p-3 text-xs text-critical" title={row.error_message ?? undefined}>
                              {row.error_message ?? "—"}
                            </td>
                            <td className="p-3">
                              {row.status === "dead_letter" || row.status === "retrying" ? (
                                <Button size="sm" variant="outline" onClick={() => requeueWebhookJob(row.id)}>
                                  Requeue
                                </Button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!webhookJobs.isLoading && webhookJobRows.length === 0 ? (
                      <p className="px-3 py-4 text-sm text-muted-foreground">
                        {webhookJobsStatus === "all" ? "No webhook jobs yet." : "No webhook jobs with this status."}
                      </p>
                    ) : null}
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                  <span>
                    {webhookJobsTotal === 0
                      ? "0 jobs"
                      : `${webhookJobsOffset + 1}–${webhookJobsOffset + webhookJobRows.length} of ${webhookJobsTotal}`}
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={webhookJobsOffset <= 0}
                    onClick={() => setWebhookJobsOffset(Math.max(0, webhookJobsOffset - WEBHOOK_JOBS_PAGE_SIZE))}
                  >
                    Prev
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={webhookJobsOffset + webhookJobRows.length >= webhookJobsTotal}
                    onClick={() => setWebhookJobsOffset(webhookJobsOffset + WEBHOOK_JOBS_PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </CardContent>
            </GlassCard>
          </div>
        </TabsContent>

        <TabsContent value="manual" className="mt-4 space-y-4">
          <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            <GlassCard className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">On-demand sync</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Incremental (history &amp; deltas)</p>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => runIncrementalSync("sonarr")}>
                      Sonarr incremental
                    </Button>
                    <Button variant="secondary" onClick={() => runIncrementalSync("radarr")}>
                      Radarr incremental
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Full (entire library from Arr — slow)</p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => runFullSync("sonarr")}>
                      Sonarr full
                    </Button>
                    <Button variant="outline" onClick={() => runFullSync("radarr")}>
                      Radarr full
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {workStatus.data?.active
                    ? `${workStatus.data.items?.length ?? 0} job(s) active (warehouse, MAL, and/or setup). See the status panel below.`
                    : syncProgress.data?.running
                      ? `Running: ${syncProgress.data.source}/${syncProgress.data.mode} (${syncProgress.data.trigger ?? "unknown"}) — ${fmtDuration(syncProgress.data.elapsed_seconds)}`
                      : "Idle — no sync or MAL pipeline in progress."}
                </p>
              </CardContent>
            </GlassCard>
            <GlassCard className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">Queue processing policy</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  How the webhook queue is drained. Blank fields keep the current value; defaults are 80 / 5 / 30 / 900.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {(
                    [
                      ["batch_size", "Batch size"],
                      ["max_attempts", "Max attempts"],
                      ["backoff_base_seconds", "Backoff base (s)"],
                      ["backoff_cap_seconds", "Backoff cap (s)"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="flex flex-col gap-1 text-xs text-muted-foreground">
                      {label}
                      <input
                        type="number"
                        aria-label={label}
                        className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                        placeholder={String(queueConfig.data?.[key] ?? "")}
                        value={queueDraft[key]}
                        onChange={(event) => setQueueDraft((prev) => ({ ...prev, [key]: event.target.value }))}
                      />
                    </label>
                  ))}
                </div>
                <Button
                  size="sm"
                  disabled={!Object.values(queueDraft).some((v) => v.trim() !== "")}
                  onClick={() => {
                    const updates: Record<string, number> = {};
                    for (const [key, value] of Object.entries(queueDraft)) {
                      if (value.trim() !== "" && Number.isFinite(Number(value))) updates[key] = Number(value);
                    }
                    void runAction(() => api.saveQueueConfig(updates), "save queue policy", {
                      successMessage: "Queue policy saved",
                      invalidate: [[...queryKeys.queueConfig]],
                    }).then((ok) => {
                      // Only clear the draft on success — a failed save must
                      // leave the user's typed values in place to retry.
                      if (ok) setQueueDraft({ batch_size: "", max_attempts: "", backoff_base_seconds: "", backoff_cap_seconds: "" });
                    });
                  }}
                >
                  Save queue policy
                </Button>
              </CardContent>
            </GlassCard>
            <GlassCard className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">System</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => replayDeadLetter("sonarr")}>
                    Replay Sonarr dead letter
                  </Button>
                  <Button variant="secondary" onClick={() => replayDeadLetter("radarr")}>
                    Replay Radarr dead letter
                  </Button>
                </div>
                <div className="space-y-2 border-t border-border pt-3">
                  <p className="text-xs text-muted-foreground">
                    Compare warehouse counts against the live Sonarr/Radarr APIs. Drift means a sync was missed —
                    run a full sync to repair. History lives in Reporting → Sync Operations.
                  </p>
                  <Button variant="secondary" className="w-fit" onClick={() => runIntegrityAudit(setIntegrityResults)}>
                    Run integrity audit
                  </Button>
                  {integrityResults ? (
                    <ul className="space-y-1 text-xs">
                      {integrityResults.map((result) => (
                        <li key={`${result.source}-${result.instance_name}`} className="rounded border border-border bg-muted/40 px-2 py-1">
                          <span className="font-medium">
                            {result.source}/{result.instance_name}:
                          </span>{" "}
                          {result.status === "failed" ? (
                            <span className="text-critical">{result.error}</span>
                          ) : result.drift_detected ? (
                            <span className="text-warn">
                              drift — items {(result.drift?.item_count ?? 0) >= 0 ? "+" : ""}
                              {result.drift?.item_count ?? 0}, files{" "}
                              {(result.drift?.file_count ?? 0) >= 0 ? "+" : ""}
                              {result.drift?.file_count ?? 0} (Arr minus warehouse)
                            </span>
                          ) : (
                            <span className="text-ok">in sync (items {result.arr_counts?.item_count ?? 0}, files {result.arr_counts?.file_count ?? 0})</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <Button
                  variant="destructive"
                  className="w-fit"
                  onClick={() =>
                    requestConfirm({
                      title: "Reset all data?",
                      description:
                        "Wipes library data, sync history & watermarks, integrity audit history, storage snapshots, the webhook queue, and MAL data. Kept: your integrations, login/API token, webhook secret, alert settings, schedules, retention/queue policy, and the public metrics setting. Run a full sync afterwards. This cannot be undone.",
                      confirmLabel: "Reset data",
                      destructive: true,
                      typedPhrase: "RESET",
                      onConfirm: () =>
                        void runAction(() => api.resetData(), "reset data", {
                          successMessage: "All data reset",
                          // `RunActionOptions.invalidate` is `string[][]`; the bare-prefix form of
                          // a parameterized queryKeys factory still types as a union including its
                          // numeric-param branch, so those three stay literal.
                          invalidate: [
                            ["shows"],
                            ["all-episodes"],
                            ["movies"],
                            [...queryKeys.malOverview],
                            [...queryKeys.malJobRuns()],
                            [...queryKeys.webhookQueue],
                            ["webhook-jobs"],
                            [...queryKeys.recentRuns],
                            [...queryKeys.syncProgress],
                          ],
                        }),
                    })
                  }
                >
                  Reset data
                </Button>
                <Button
                  variant="outline"
                  className="w-fit border-warn/40 text-warn hover:bg-warn/10"
                  onClick={() =>
                    requestConfirm({
                      title: "Reset MAL data only?",
                      description:
                        "Clears dub list history, MAL anime rows, warehouse links, external IDs, manual MAL links, ingest checkpoints, tag apply state, and MAL job history. Sonarr/Radarr warehouse and app settings (including your MAL client ID) are not changed.",
                      confirmLabel: "Reset MAL data",
                      destructive: true,
                      typedPhrase: "RESET_MAL",
                      onConfirm: () =>
                        void runAction(() => api.resetMalData(), "reset MAL data", {
                          successMessage: "MAL data reset",
                          invalidate: [[...queryKeys.malOverview], [...queryKeys.malJobRuns()], [...queryKeys.malConfig]],
                        }),
                    })
                  }
                >
                  Reset MAL Data
                </Button>
                <div className="space-y-2 border-t border-border pt-3">
                  <p className="text-xs text-muted-foreground">
                    Long tasks (MAL ingest, Sonarr/Radarr syncs, and similar) run <strong className="text-foreground/90">inside the app
                    process</strong>. A crash or kill can leave coordination rows in Postgres (locks) or
                    &quot;running&quot; job rows. Use the controls below to clear that <strong className="text-foreground/90">DB
                    state</strong> so new work can start. Failing live warehouse runs is off by default—only use it if you are
                    sure nothing is really running.
                  </p>
                  {stuckState.isError ? (
                    <p className="text-xs text-critical">Could not load stuck state.</p>
                  ) : null}
                  <ul className="list-inside list-disc text-xs text-muted-foreground">
                    <li>
                      Job lock rows: {stuckState.data?.job_locks?.length ?? (stuckState.isLoading ? "…" : 0)}
                    </li>
                    <li>Running MAL job rows: {stuckState.data?.mal_job_runs_running?.length ?? (stuckState.isLoading ? "…" : 0)}</li>
                    <li>
                      Running warehouse <code className="rounded bg-muted px-0.5">sync_run</code> rows:{" "}
                      {stuckState.data?.warehouse_sync_runs_running?.length ?? (stuckState.isLoading ? "…" : 0)}
                    </li>
                    <li>
                      Running Sonarr/Radarr <code className="rounded bg-muted px-0.5">job_run_summary</code> rows:{" "}
                      {stuckState.data?.job_run_summary_running?.length ?? (stuckState.isLoading ? "…" : 0)}
                    </li>
                  </ul>
                  {stuckState.data?.job_locks?.length ? (
                    <ul className="max-h-24 overflow-y-auto rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                      {stuckState.data.job_locks.map((l) => (
                        <li key={l.lock_name} className="truncate">
                          {l.lock_name}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="stuck-all-locks"
                        checked={stuckClearAllLocks}
                        onCheckedChange={(c) => {
                          setStuckClearAllLocks(c === true);
                        }}
                      />
                      <Label htmlFor="stuck-all-locks" className="text-xs text-muted-foreground">
                        Remove <strong className="text-foreground/90">all</strong> rows in <code className="rounded bg-muted px-0.5">app.job_lock</code> (ignores
                        granular lock options below)
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="stuck-mal-lock"
                        disabled={stuckClearAllLocks}
                        checked={stuckClearMalLock}
                        onCheckedChange={(c) => setStuckClearMalLock(c === true)}
                      />
                      <Label htmlFor="stuck-mal-lock" className="text-xs text-muted-foreground">
                        Remove <code className="rounded bg-muted px-0.5">mal:ingest</code> lock
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="stuck-mal-jobs"
                        checked={stuckClearMalJobs}
                        onCheckedChange={(c) => setStuckClearMalJobs(c === true)}
                      />
                      <Label htmlFor="stuck-mal-jobs" className="text-xs text-muted-foreground">
                        Mark running MAL job rows as failed
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="stuck-wh-locks"
                        disabled={stuckClearAllLocks}
                        checked={stuckClearWhLocks}
                        onCheckedChange={(c) => setStuckClearWhLocks(c === true)}
                      />
                      <Label htmlFor="stuck-wh-locks" className="text-xs text-muted-foreground">
                        Clear Sonarr/Radarr sync job lock rows only (does not change warehouse data)
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="stuck-wh-fail"
                        checked={stuckFailWhSync}
                        onCheckedChange={(c) => setStuckFailWhSync(c === true)}
                      />
                      <Label htmlFor="stuck-wh-fail" className="text-xs text-warn">
                        Mark &quot;running&quot; warehouse sync runs and Sonarr/Radarr job summary rows as failed (dangerous if a
                        sync is still running)
                      </Label>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    className="w-fit"
                    onClick={() =>
                      requestConfirm({
                        title: "Clear stuck state?",
                        description:
                          "Applies the options selected above: this may delete job lock rows and mark running MAL or warehouse job rows as failed. Only use this when you are sure no work is actually running.",
                        confirmLabel: "Clear stuck state",
                        destructive: true,
                        typedPhrase: "CLEAR_STUCK",
                        onConfirm: () => {
                          void runAction(async () => {
                        const r = await api.clearStuck(
                          stuckClearAllLocks
                            ? {
                                clear_all_job_locks: true,
                                fail_stuck_mal_job_runs: stuckClearMalJobs,
                                fail_stuck_warehouse_sync_runs: stuckFailWhSync,
                              }
                            : {
                                clear_mal_ingest_lock: stuckClearMalLock,
                                fail_stuck_mal_job_runs: stuckClearMalJobs,
                                clear_warehouse_sync_locks: stuckClearWhLocks,
                                fail_stuck_warehouse_sync_runs: stuckFailWhSync,
                              },
                        );
                        void queryClient.invalidateQueries({ queryKey: queryKeys.stuckState });
                        void queryClient.invalidateQueries({ queryKey: queryKeys.status });
                        void queryClient.invalidateQueries({ queryKey: queryKeys.workStatus });
                        void queryClient.invalidateQueries({ queryKey: queryKeys.syncActivity });
                        void queryClient.invalidateQueries({ queryKey: queryKeys.syncProgress });
                        void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
                        return r;
                          }, "clear stuck state");
                        },
                      })
                    }
                  >
                    Clear stuck state (DB)
                  </Button>
                </div>
              </CardContent>
            </GlassCard>
          </div>
          <GlassCard>
            <CardHeader>
              <CardTitle className="text-base">MyAnimeList pipelines</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Ingest, matching, tag sync, job history, and unmatched dubbed anime now live on the{" "}
                <Link to={PATHS.mal} className="text-primary hover:underline">
                  MyAnimeList page
                </Link>
                .
              </p>
            </CardContent>
          </GlassCard>
        </TabsContent>
      </Tabs>

      <WorkStatusPanel
        title="Live status &amp; ETA"
        description="All in-flight work: Sonarr/Radarr warehouse syncs (any trigger), MAL ingest/matcher/tag, and setup-wizard library import. Progress uses historical run times when available; MAL ingest shows batch position while running."
        dense
      />
      {confirmDialog}
      {syncActionsConfirmDialog}
    </div>
  );
}
