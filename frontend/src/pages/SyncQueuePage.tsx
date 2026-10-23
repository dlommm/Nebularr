import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { IntegrityAuditResult, RunRow } from "../types";
import { PATHS } from "../routes/paths";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate, fmtDuration } from "../hooks";
import { useActionError } from "../hooks/useActionError";
import { pollInterval, useServerEventsStatus } from "../hooks/useServerEvents";
import { useSyncActions } from "../hooks/useSyncActions";
import { queryKeys } from "../lib/queryKeys";
import { clampPageOffset } from "./syncQueueShared";
import { StatusBadge } from "../components/nebula/StatusBadge";
import { useConfirmDialog } from "../components/nebula/ConfirmDialog";
import { QueryErrorNotice } from "../components/nebula/QueryErrorNotice";
import { WorkStatusPanel } from "../components/nebula/WorkStatusPanel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { actionLinkClass, tableCellClass, tableHeadCellClass, tableHeadRowClass, tableRowClass } from "@/lib/ns";
import { clock, dayOrClock, relTime } from "@/lib/time";
import { ActionRow, Figure, Figures, PageHead, SectionHead } from "@/components/ns/Page";
import { SyncLanes } from "@/components/ns/SyncLanes";

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
  const timeline = useQuery({
    queryKey: queryKeys.runTimeline,
    queryFn: () => api.runTimeline(24),
    refetchInterval: pollInterval(sseConnected, 30_000, 90_000),
  });
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

  const queueCount = (state: string): number => webhookQueue.data?.find((row) => row.status === state)?.count ?? 0;
  const deadLetters = queueCount("dead_letter");
  const runRows = runs.data ?? [];
  const lastRun = runRows.find((run) => run.status !== "running");
  const progress = syncProgress.data;
  const stuckCount = (rows: unknown[] | undefined): string => (rows ? String(rows.length) : stuckState.isLoading ? "…" : "0");

  const renderRunTable = (rows: RunRow[], withErrors: boolean): JSX.Element => (
    <div className={cn("overflow-x-auto", runs.isPlaceholderData && "opacity-60 transition-opacity")}>
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className={tableHeadRowClass}>
            <th className={tableHeadCellClass}>Started</th>
            <th className={tableHeadCellClass}>Source</th>
            <th className={tableHeadCellClass}>Mode</th>
            <th className={tableHeadCellClass}>Instance</th>
            <th className={tableHeadCellClass}>Outcome</th>
            <th className={cn(tableHeadCellClass, "text-right")}>Duration</th>
            <th className={cn(tableHeadCellClass, "text-right")}>Rows</th>
            {withErrors ? <th className={tableHeadCellClass}>Error</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((run, idx) => (
            <tr key={`${run.source}-${run.started_at}-${idx}`} className={tableRowClass}>
              <td className={cn(tableCellClass, "font-mono text-xs whitespace-nowrap text-subtle-foreground")} title={fmtDate(run.started_at)}>
                {dayOrClock(run.started_at)}
              </td>
              <td className={tableCellClass}>{sourceLabel(run.source)}</td>
              <td className={cn(tableCellClass, "text-muted-foreground")}>{run.mode}</td>
              <td className={cn(tableCellClass, "text-muted-foreground")}>{run.instance_name}</td>
              <td className={tableCellClass}>
                <StatusBadge status={run.status} />
              </td>
              <td className={cn(tableCellClass, "text-right whitespace-nowrap tabular-nums")}>{runDuration(run)}</td>
              <td className={cn(tableCellClass, "text-right tabular-nums text-muted-foreground")}>
                {run.rows_written?.toLocaleString() ?? "—"}
              </td>
              {withErrors ? (
                <td className={cn(tableCellClass, "max-w-[280px] truncate text-xs text-critical")} title={run.error_message ?? undefined}>
                  {run.error_message ?? ""}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const runsBody = (rows: RunRow[], withErrors: boolean): JSX.Element =>
    runs.isError ? (
      <QueryErrorNotice label="run history" retry={() => void runs.refetch()} error={runs.error} />
    ) : runs.isLoading ? (
      <div className="space-y-2 pt-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    ) : rows.length === 0 ? (
      <p className="border-t border-border py-6 text-sm text-muted-foreground">No sync runs yet.</p>
    ) : (
      renderRunTable(rows, withErrors)
    );

  const queueFigures = (
    <Figures>
      <Figure value={queueCount("queued")} label="queued" />
      <Figure value={queueCount("retrying")} label="retrying" tone={queueCount("retrying") > 0 ? "warn" : undefined} />
      <Figure value={deadLetters} label="dead letters" tone={deadLetters > 0 ? "critical" : "ok"} />
      <Figure value={queueCount("done").toLocaleString()} label="applied" />
    </Figures>
  );

  return (
    <div className="pb-16">
      <PageHead title="Sync & Queue" lead="Every warehouse run, every webhook from Sonarr and Radarr, and the controls to run them by hand." />

      <Tabs value={tab} onValueChange={setTab} className="w-full gap-0">
        <TabsList aria-label="Sync views" className="w-full">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="runs">Run history</TabsTrigger>
          <TabsTrigger value="webhooks">Webhook queue</TabsTrigger>
          <TabsTrigger value="manual">Run by hand</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <section aria-labelledby="sync-now" className="pt-8">
            <h2 id="sync-now" className="sr-only">
              Running now
            </h2>
            <div className="panel grid grid-cols-1 items-center gap-6 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-7 sm:py-6">
              {progress?.running ? (
                <div className="min-w-0">
                  <p className="text-[13px] text-subtle-foreground">Holding the sync lock</p>
                  <p className="mt-1.5 text-[22px] leading-snug">
                    {sourceLabel(progress.source)} {progress.mode}{" "}
                    <span className="text-muted-foreground">
                      · {progress.trigger ?? "unknown trigger"} · {progress.stage}
                      {progress.stage_note ? ` (${progress.stage_note})` : ""}
                    </span>
                  </p>
                  <div
                    role="progressbar"
                    aria-label="Estimated completion"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progressPct)}
                    className="relative mt-3.5 h-[3px] overflow-hidden rounded-full bg-border"
                  >
                    <span className="absolute inset-y-0 left-0 overflow-hidden bg-signal transition-[width] duration-700" style={{ width: `${progressPct}%` }}>
                      <span className="absolute inset-0 animate-shimmer bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.5),transparent)] bg-[length:160px_100%]" />
                    </span>
                  </div>
                  <p className="mt-2.5 font-mono text-xs text-subtle-foreground">
                    started {clock(progress.started_at)} · {fmtDuration(progress.elapsed_seconds ?? 0)} ·{" "}
                    {(progress.records_processed ?? 0).toLocaleString()} rows
                    {progress.eta_seconds != null ? ` · about ${fmtDuration(progress.eta_seconds)} left` : ""}
                    {progress.estimated_total_seconds ? ` · typical run ${fmtDuration(progress.estimated_total_seconds)}` : ""}
                  </p>
                </div>
              ) : (
                <div className="min-w-0">
                  <p className="text-[13px] text-subtle-foreground">Nothing is holding the sync lock</p>
                  <p className="mt-1.5 text-[22px] leading-snug">
                    Idle
                    {lastRun ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · last run {sourceLabel(lastRun.source)} {lastRun.mode}, {relTime(lastRun.finished_at ?? lastRun.started_at)}
                      </span>
                    ) : null}
                  </p>
                  {workStatus.data?.active ? (
                    <p className="mt-2.5 text-[13px] text-muted-foreground">
                      {workStatus.data.items?.length ?? 0} other job(s) running — see Live status below.
                    </p>
                  ) : null}
                </div>
              )}
              <Button variant="outline" className="min-h-11 w-fit" onClick={() => setTab("runs")}>
                View runs
              </Button>
            </div>
            {status.data ? (
              <p className="mt-3 font-mono text-xs text-subtle-foreground">
                {status.data.active_sync_count} active · lag Sonarr {lagSeconds(status.data.sync_lag_seconds.sonarr)} · Radarr{" "}
                {lagSeconds(status.data.sync_lag_seconds.radarr)} · MAL fetched {status.data.mal_sync?.fetched_success_count ?? 0} of{" "}
                {status.data.mal_sync?.dubbed_total ?? 0}, {status.data.mal_sync?.pending_fetch_count ?? 0} pending
              </p>
            ) : null}
          </section>

          {timeline.data ? (
            <section aria-labelledby="sync-lanes" className="pt-12">
              <SectionHead id="sync-lanes" title="The last 24 hours" aside="short tick = incremental · tall = full · ring = failed" />
              <SyncLanes timeline={timeline.data} />
            </section>
          ) : null}

          <section aria-labelledby="sync-queue" className="pt-12">
            <SectionHead id="sync-queue" title="Webhook queue" aside="Events from Sonarr and Radarr waiting to be applied" />
            {queueFigures}
          </section>

          <section aria-labelledby="sync-recent" className="pt-12">
            <SectionHead
              id="sync-recent"
              title="Recent runs"
              aside={
                <button type="button" className="border-b border-input py-2 text-sm text-foreground hover:border-foreground" onClick={() => setTab("runs")}>
                  Full history
                </button>
              }
            />
            {runsBody(runRows.slice(0, 8), false)}
          </section>

          <WorkStatusPanel
            className="pt-12"
            title="Live status"
            description="Warehouse syncs, MAL jobs and setup import. Progress uses historical run times when available."
          />
        </TabsContent>

        <TabsContent value="runs" className="pt-8">
          <SectionHead title="Run history" aside={`${runRows.length} most recent runs`} />
          {runsBody(runRows, true)}
        </TabsContent>

        <TabsContent value="webhooks">
          <section aria-labelledby="wh-summary" className="pt-8">
            <h2 id="wh-summary" className="sr-only">
              Queue summary
            </h2>
            {queueFigures}
          </section>

          <section aria-labelledby="wh-jobs" className="pt-12">
            <SectionHead
              id="wh-jobs"
              title="Webhook jobs"
              aside={
                <div className="flex flex-wrap items-center gap-3">
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
                  <label className="flex items-center gap-2 text-xs text-subtle-foreground">
                    Status
                    <select
                      aria-label="Filter webhook jobs by status"
                      className="min-h-10 rounded-sm border border-border bg-muted px-2.5 text-[13px] text-foreground"
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
              }
            />
            {webhookJobs.isError ? (
              <QueryErrorNotice label="webhook jobs" retry={() => void webhookJobs.refetch()} error={webhookJobs.error} />
            ) : (
              <div className={cn("overflow-x-auto", webhookJobs.isPlaceholderData && "opacity-60 transition-opacity")}>
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className={tableHeadRowClass}>
                      <th className={tableHeadCellClass}>ID</th>
                      <th className={tableHeadCellClass}>Received</th>
                      <th className={tableHeadCellClass}>Source</th>
                      <th className={tableHeadCellClass}>Event</th>
                      <th className={tableHeadCellClass}>State</th>
                      <th className={cn(tableHeadCellClass, "text-right")}>Attempts</th>
                      <th className={tableHeadCellClass}>Error</th>
                      {/* Named by aria-label rather than an sr-only span: an absolutely
                          positioned child here escapes the scroll wrapper on phones. */}
                      <th className={tableHeadCellClass} aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {webhookJobRows.map((row) => (
                      <tr key={row.id} className={tableRowClass}>
                        <td className={cn(tableCellClass, "font-mono text-xs text-subtle-foreground")}>{row.id}</td>
                        <td className={cn(tableCellClass, "font-mono text-xs whitespace-nowrap text-subtle-foreground")} title={fmtDate(row.received_at)}>
                          {dayOrClock(row.received_at)}
                        </td>
                        <td className={tableCellClass}>{sourceLabel(row.source)}</td>
                        <td className={cn(tableCellClass, "text-muted-foreground")}>{row.event_type ?? "—"}</td>
                        <td className={tableCellClass}>
                          <StatusBadge status={row.status} />
                        </td>
                        <td className={cn(tableCellClass, "text-right tabular-nums")}>{row.attempts}</td>
                        <td className={cn(tableCellClass, "max-w-[240px] truncate text-xs text-critical")} title={row.error_message ?? undefined}>
                          {row.error_message ?? ""}
                        </td>
                        <td className="py-1 text-right">
                          {row.status === "dead_letter" || row.status === "retrying" ? (
                            <button type="button" className={actionLinkClass} onClick={() => requeueWebhookJob(row.id)}>
                              Requeue
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!webhookJobs.isLoading && webhookJobRows.length === 0 ? (
                  <p className="py-6 text-sm text-muted-foreground">
                    {webhookJobsStatus === "all" ? "No webhook jobs yet." : "No webhook jobs with this status."}
                  </p>
                ) : null}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-4 text-[13px] text-muted-foreground">
              <span>
                {webhookJobsTotal === 0
                  ? "0 jobs"
                  : `${webhookJobsOffset + 1}–${webhookJobsOffset + webhookJobRows.length} of ${webhookJobsTotal}`}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={webhookJobsOffset <= 0}
                onClick={() => setWebhookJobsOffset(Math.max(0, webhookJobsOffset - WEBHOOK_JOBS_PAGE_SIZE))}
              >
                Prev
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={webhookJobsOffset + webhookJobRows.length >= webhookJobsTotal}
                onClick={() => setWebhookJobsOffset(webhookJobsOffset + WEBHOOK_JOBS_PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="manual">
          <section aria-labelledby="manual-run" className="pt-8">
            <h2 id="manual-run" className="sr-only">
              Run by hand
            </h2>
            <div className="grid grid-cols-1 gap-10 lg:grid-cols-3">
              <div>
                <h3 className="mb-2.5 text-[15px] font-medium">On-demand sync</h3>
                <ActionRow hint="history & deltas" onClick={() => runIncrementalSync("sonarr")}>
                  Sonarr — incremental
                </ActionRow>
                <ActionRow hint="whole library, slow" onClick={() => runFullSync("sonarr")}>
                  Sonarr — full
                </ActionRow>
                <ActionRow hint="history & deltas" onClick={() => runIncrementalSync("radarr")}>
                  Radarr — incremental
                </ActionRow>
                <ActionRow hint="whole library, slow" onClick={() => runFullSync("radarr")}>
                  Radarr — full
                </ActionRow>
              </div>
              <div>
                <h3 className="mb-2.5 text-[15px] font-medium">Maintenance</h3>
                <ActionRow hint="read-only" onClick={() => runIntegrityAudit(setIntegrityResults)}>
                  Integrity audit
                </ActionRow>
                <ActionRow hint={deadLetters > 0 ? `${deadLetters} waiting in all` : "none waiting"} onClick={() => replayDeadLetter("sonarr")}>
                  Replay Sonarr dead letters
                </ActionRow>
                <ActionRow hint={deadLetters > 0 ? `${deadLetters} waiting in all` : "none waiting"} onClick={() => replayDeadLetter("radarr")}>
                  Replay Radarr dead letters
                </ActionRow>
              </div>
              <div>
                <h3 className="mb-2.5 text-[15px] font-medium text-critical">Can’t be undone</h3>
                <ActionRow
                  danger
                  hint="asks to confirm"
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
                  Reset MyAnimeList data
                </ActionRow>
                <ActionRow
                  danger
                  hint="asks to confirm"
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
                  Reset all warehouse data
                </ActionRow>
              </div>
            </div>
            <p className="mt-6 text-[13px] text-muted-foreground">
              {workStatus.data?.active
                ? `${workStatus.data.items?.length ?? 0} job(s) active (warehouse, MAL, and/or setup).`
                : progress?.running
                  ? `Running: ${progress.source}/${progress.mode} (${progress.trigger ?? "unknown"}) — ${fmtDuration(progress.elapsed_seconds)}`
                  : "Idle — no sync or MAL pipeline in progress."}{" "}
              MyAnimeList ingest, matching and tagging run from the{" "}
              <Link to={PATHS.mal} className="border-b border-input text-foreground hover:border-foreground">
                Anime page
              </Link>
              .
            </p>
          </section>

          {integrityResults ? (
            <section aria-labelledby="manual-audit" className="pt-12">
              <SectionHead id="manual-audit" title="Integrity audit" aside="Arr minus warehouse · history lives in Reports → Sync health" />
              <ul>
                {integrityResults.map((result) => (
                  <li
                    key={`${result.source}-${result.instance_name}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-border py-3.5 text-sm last:border-b"
                  >
                    <span>
                      {sourceLabel(result.source)} <span className="text-subtle-foreground">{result.instance_name}</span>
                    </span>
                    {result.status === "failed" ? (
                      <span className="text-critical">{result.error}</span>
                    ) : result.drift_detected ? (
                      <span className="text-warn">
                        drift — items {signed(result.drift?.item_count)}, files {signed(result.drift?.file_count)}. Run a full sync to repair.
                      </span>
                    ) : (
                      <span className="text-ok">
                        in sync · {result.arr_counts?.item_count ?? 0} items, {result.arr_counts?.file_count ?? 0} files
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="grid grid-cols-1 gap-x-14 gap-y-12 pt-12 lg:grid-cols-2">
            <section aria-labelledby="manual-policy" className="min-w-0">
              <SectionHead id="manual-policy" title="Queue policy" />
              <p className="text-[13px] text-muted-foreground">
                How the webhook queue is drained. Blank fields keep the current value; defaults are 80 / 5 / 30 / 900.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-4">
                {(
                  [
                    ["batch_size", "Batch size"],
                    ["max_attempts", "Max attempts"],
                    ["backoff_base_seconds", "Backoff base (s)"],
                    ["backoff_cap_seconds", "Backoff cap (s)"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
                    {label}
                    <input
                      type="number"
                      aria-label={label}
                      className="min-h-11 rounded-sm border border-border bg-muted px-3 text-sm text-foreground"
                      placeholder={String(queueConfig.data?.[key] ?? "")}
                      value={queueDraft[key]}
                      onChange={(event) => setQueueDraft((prev) => ({ ...prev, [key]: event.target.value }))}
                    />
                  </label>
                ))}
              </div>
              <Button
                className="mt-5 min-h-11"
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
            </section>

            <section aria-labelledby="manual-stuck" className="min-w-0">
              <SectionHead id="manual-stuck" title="Stuck state" />
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Long tasks run inside the app process. A crash or kill can leave lock rows or &quot;running&quot; job rows in Postgres;
                clear them here so new work can start. Failing live warehouse runs is off by default — only use it if you are sure
                nothing is really running.
              </p>
              {stuckState.isError ? <p className="mt-3 text-[13px] text-critical">Could not load stuck state.</p> : null}
              <dl className="mt-4 grid grid-cols-2 gap-px border-y border-border bg-border sm:grid-cols-4 [&>div]:bg-background [&>div]:py-3 [&>div]:pr-3">
                <div>
                  <dt className="text-[11px] text-subtle-foreground">Job locks</dt>
                  <dd className="cond mt-1 text-[32px] leading-none font-[640]">{stuckCount(stuckState.data?.job_locks)}</dd>
                </div>
                <div className="sm:pl-3">
                  <dt className="text-[11px] text-subtle-foreground">MAL jobs running</dt>
                  <dd className="cond mt-1 text-[32px] leading-none font-[640]">{stuckCount(stuckState.data?.mal_job_runs_running)}</dd>
                </div>
                <div className="sm:pl-3">
                  <dt className="text-[11px] text-subtle-foreground">sync_run running</dt>
                  <dd className="cond mt-1 text-[32px] leading-none font-[640]">{stuckCount(stuckState.data?.warehouse_sync_runs_running)}</dd>
                </div>
                <div className="sm:pl-3">
                  <dt className="text-[11px] text-subtle-foreground">job summaries running</dt>
                  <dd className="cond mt-1 text-[32px] leading-none font-[640]">{stuckCount(stuckState.data?.job_run_summary_running)}</dd>
                </div>
              </dl>
              {stuckState.data?.job_locks?.length ? (
                <ul className="well mt-3 max-h-24 overflow-y-auto px-3 py-2 font-mono text-[11px] text-muted-foreground">
                  {stuckState.data.job_locks.map((l) => (
                    <li key={l.lock_name} className="truncate">
                      {l.lock_name}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-4 space-y-1">
                {(
                  [
                    ["stuck-all-locks", stuckClearAllLocks, setStuckClearAllLocks, false, <>Remove <strong className="text-foreground">all</strong> rows in <code className="font-mono text-xs">app.job_lock</code> (ignores the two lock options below)</>],
                    ["stuck-mal-lock", stuckClearMalLock, setStuckClearMalLock, stuckClearAllLocks, <>Remove the <code className="font-mono text-xs">mal:ingest</code> lock</>],
                    ["stuck-mal-jobs", stuckClearMalJobs, setStuckClearMalJobs, false, <>Mark running MAL job rows as failed</>],
                    ["stuck-wh-locks", stuckClearWhLocks, setStuckClearWhLocks, stuckClearAllLocks, <>Clear Sonarr/Radarr sync lock rows only (warehouse data unchanged)</>],
                  ] as const
                ).map(([id, checked, setChecked, disabled, label]) => (
                  <div key={id} className="flex min-h-11 items-center gap-3">
                    <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(c) => setChecked(c === true)} />
                    <Label htmlFor={id} className="text-[13px] font-normal text-muted-foreground">
                      {label}
                    </Label>
                  </div>
                ))}
                <div className="flex min-h-11 items-center gap-3">
                  <Checkbox id="stuck-wh-fail" checked={stuckFailWhSync} onCheckedChange={(c) => setStuckFailWhSync(c === true)} />
                  <Label htmlFor="stuck-wh-fail" className="text-[13px] font-normal text-warn">
                    Mark &quot;running&quot; warehouse sync runs and job summaries as failed (dangerous if a sync is still running)
                  </Label>
                </div>
              </div>
              <Button
                variant="outline"
                className="mt-4 min-h-11"
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
                Clear stuck state
              </Button>
            </section>
          </div>
        </TabsContent>
      </Tabs>

      {confirmDialog}
      {syncActionsConfirmDialog}
    </div>
  );
}

function sourceLabel(source: string | undefined): string {
  if (!source) return "—";
  if (source === "mal") return "MyAnimeList";
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function runDuration(run: RunRow): string {
  if (!run.finished_at) return run.status === "running" ? "running" : "—";
  const seconds = (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? fmtDuration(seconds) : "—";
}

function signed(n: number | null | undefined): string {
  const v = n ?? 0;
  return v > 0 ? `+${v}` : String(v);
}

function lagSeconds(seconds: number | undefined): string {
  return `${Math.round((seconds ?? 0) * 10) / 10} s`;
}
