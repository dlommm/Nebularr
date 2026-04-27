import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate, fmtDuration } from "../hooks";
import { useActionError } from "../hooks/useActionError";
import { StatusPill } from "../components/ui";
import { GlassCard, CardContent, CardHeader, CardTitle } from "../components/nebula/GlassCard";
import { ProgressBar } from "../components/nebula/ProgressBar";
import { WorkStatusPanel } from "../components/nebula/WorkStatusPanel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, Inbox, ListOrdered, Wrench, Zap } from "lucide-react";
const TAB_VALUES = ["overview", "runs", "webhooks", "manual"] as const;
type TabValue = (typeof TAB_VALUES)[number];

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
  const { setError, runAction } = useActionError();
  const malConfig = useQuery({ queryKey: ["mal-config"], queryFn: api.malConfig });
  const [malPipelineResult, setMalPipelineResult] = useState<string | null>(null);
  const [malBacklogCycles, setMalBacklogCycles] = useState(10);
  const [malCycleDelaySeconds, setMalCycleDelaySeconds] = useState(2);
  const [malBatchSize, setMalBatchSize] = useState(200);
  const [malImportAll, setMalImportAll] = useState(false);
  const [stuckClearAllLocks, setStuckClearAllLocks] = useState(false);
  const [stuckClearMalLock, setStuckClearMalLock] = useState(true);
  const [stuckClearMalJobs, setStuckClearMalJobs] = useState(true);
  const [stuckClearWhLocks, setStuckClearWhLocks] = useState(false);
  const [stuckFailWhSync, setStuckFailWhSync] = useState(false);

  const runs = useQuery({ queryKey: ["runs"], queryFn: api.recentRuns, refetchInterval: 15_000 });
  const webhookQueue = useQuery({ queryKey: ["webhook-queue"], queryFn: api.webhookQueue, refetchInterval: 15_000 });
  const webhookJobs = useQuery({
    queryKey: ["webhook-jobs"],
    queryFn: () => api.webhookJobs(),
    refetchInterval: 15_000,
  });
  const syncProgress = useQuery({ queryKey: ["sync-progress"], queryFn: api.syncProgress, refetchInterval: 2_000 });
  const workStatus = useQuery({ queryKey: ["work-status"], queryFn: api.workStatus, refetchInterval: 2_000 });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 15_000 });
  const stuckState = useQuery({
    queryKey: ["stuck-state"],
    queryFn: api.stuckState,
    refetchInterval: tab === "manual" ? 15_000 : false,
    enabled: tab === "manual",
  });

  useEffect(() => {
    const n = malConfig.data?.mal_max_ids_per_run;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) {
      setMalBatchSize(Math.max(1, Math.min(500, n)));
    }
  }, [malConfig.data?.mal_max_ids_per_run]);

  const runFullSync = (source: "sonarr" | "radarr", actionLabel: string) => {
    const name = source === "sonarr" ? "Sonarr" : "Radarr";
    if (!window.confirm(`Run ${name} full sync? This re-fetches the full ${name} library and may take a long time.`)) return;
    void runAction(() => api.runSync(source, "full"), actionLabel);
  };

  const runMalPipeline = async (
    fn: () => Promise<{ status: string; details?: unknown }>,
    label: string,
  ): Promise<void> => {
    try {
      const r = await fn();
      setMalPipelineResult(`${label}\n${JSON.stringify(r.details ?? {}, null, 2)}`);
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    } catch (err) {
      setError(err, label);
    }
  };

  const runAllMalPipelines = async (): Promise<void> => {
    try {
      const ingestBacklog = await api.triggerMalIngestBacklog({
        max_cycles: Math.max(1, Math.min(200, malBacklogCycles)),
        cycle_delay_seconds: Math.max(0, Math.min(30, malCycleDelaySeconds)),
        max_ids_per_run: Math.max(1, Math.min(500, malBatchSize)),
      });
      const matcher = await api.triggerMalMatchRefresh();
      const tagSync = await api.triggerMalTagSync();
      setMalPipelineResult(
        `MAL run all\n${JSON.stringify(
          {
            ingest_backlog: ingestBacklog.details ?? {},
            match_refresh: matcher.details ?? {},
            tag_sync: tagSync.details ?? {},
          },
          null,
          2,
        )}`,
      );
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    } catch (err) {
      setError(err, "MAL run all");
    }
  };

  const progressPct = useMemo(() => {
    const p = syncProgress.data?.progress_pct;
    if (p != null && Number.isFinite(p)) return Math.max(0, Math.min(100, p));
    return syncProgress.data?.running ? 8 : 0;
  }, [syncProgress.data]);

  return (
    <div className="space-y-6">
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <GlassCard glow="cyan" className="min-w-0 border-cyan-500/20" size="sm">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Zap className="size-4 text-cyan-300/80" strokeWidth={1.75} aria-hidden />
              Active syncs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-heading text-2xl font-semibold tabular-nums">{status.data?.active_sync_count ?? "—"}</p>
            <p className="text-xs text-muted-foreground">from /api/status</p>
          </CardContent>
        </GlassCard>
        <GlassCard glow="violet" className="min-w-0 border-violet-500/20" size="sm">
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Inbox className="size-4 text-violet-300/80" strokeWidth={1.75} aria-hidden />
              Webhook queue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-heading text-2xl font-semibold tabular-nums">{status.data?.webhook_queue_open ?? "—"}</p>
            <p className="text-xs text-muted-foreground">queued + retrying</p>
          </CardContent>
        </GlassCard>
        <GlassCard className="min-w-0 border-white/10" size="sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Sonarr lag</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-heading text-2xl font-semibold tabular-nums">
              {status.data ? `${Math.round((status.data.sync_lag_seconds.sonarr ?? 0) * 10) / 10}s` : "—"}
            </p>
          </CardContent>
        </GlassCard>
        <GlassCard className="min-w-0 border-white/10" size="sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">Radarr lag</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-heading text-2xl font-semibold tabular-nums">
              {status.data ? `${Math.round((status.data.sync_lag_seconds.radarr ?? 0) * 10) / 10}s` : "—"}
            </p>
          </CardContent>
        </GlassCard>
        <GlassCard glow="violet" className="min-w-0 border-violet-500/20" size="sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">MAL processing</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-heading text-2xl font-semibold tabular-nums">
              {status.data?.mal_sync?.fetched_success_count ?? 0}/{status.data?.mal_sync?.dubbed_total ?? 0}
            </p>
            <p className="text-xs text-muted-foreground">completed / total dubbed</p>
            <p className="mt-1 text-xs text-muted-foreground">pending: {status.data?.mal_sync?.pending_fetch_count ?? 0}</p>
          </CardContent>
        </GlassCard>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="grid h-auto w-full min-w-0 min-h-9 max-w-full grid-cols-2 gap-0.5 bg-white/[0.04] p-1 sm:max-w-2xl sm:grid-cols-4">
          <TabsTrigger value="overview" className="min-w-0 gap-1.5 data-[state=active]:bg-white/10">
            <Activity className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Overview</span>
          </TabsTrigger>
          <TabsTrigger value="runs" className="min-w-0 gap-1.5 data-[state=active]:bg-white/10">
            <ListOrdered className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Runs</span>
          </TabsTrigger>
          <TabsTrigger value="webhooks" className="min-w-0 gap-1.5 data-[state=active]:bg-white/10">
            <Inbox className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Webhooks</span>
          </TabsTrigger>
          <TabsTrigger value="manual" className="min-w-0 gap-1.5 data-[state=active]:bg-white/10">
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
                  <p className="text-sm text-muted-foreground">No active sync job reported by /api/ui/sync-progress.</p>
                )}
                <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-xs text-muted-foreground">
                  MAL fetched: <strong>{status.data?.mal_sync?.fetched_success_count ?? 0}</strong> /{" "}
                  <strong>{status.data?.mal_sync?.dubbed_total ?? 0}</strong> · pending{" "}
                  <strong>{status.data?.mal_sync?.pending_fetch_count ?? 0}</strong>
                </div>
                <div className="space-y-2 pt-1">
                  <p className="text-[11px] font-medium text-muted-foreground">Incremental</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "runSync sonarr/incremental")}>
                      Sonarr incremental
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => runAction(() => api.runSync("radarr", "incremental"), "runSync radarr/incremental")}>
                      Radarr incremental
                    </Button>
                  </div>
                  <p className="text-[11px] font-medium text-muted-foreground">Full</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => runFullSync("sonarr", "runSync sonarr/full")}>
                      Sonarr full
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => runFullSync("radarr", "runSync radarr/full")}>
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
                    <li key={row.status} className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2">
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
              <div className="overflow-x-auto rounded-b-xl">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs text-muted-foreground">
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
                      <tr key={`${run.source}-${run.started_at}-${idx}`} className="border-b border-white/5 hover:bg-white/[0.04]">
                        <td className="p-3">{run.source}</td>
                        <td className="p-3 font-mono text-xs">{run.mode}</td>
                        <td className="p-3">
                          <StatusPill status={run.status} />
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">{fmtDate(run.started_at)}</td>
                        <td className="p-3 text-xs text-muted-foreground">{fmtDate(run.finished_at)}</td>
                        <td className="p-3 font-mono tabular-nums">{run.rows_written ?? "—"}</td>
                        <td className="p-3 text-xs text-rose-200/80">{run.error_message ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </GlassCard>
        </TabsContent>

        <TabsContent value="webhooks" className="mt-4">
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
            <GlassCard className="min-w-0 lg:col-span-1" size="sm">
              <CardHeader>
                <CardTitle className="text-base">Queue summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {(webhookQueue.data ?? []).map((row) => (
                    <div className="flex items-center justify-between text-sm" key={row.status}>
                      <span>{row.status}</span>
                      <strong className="tabular-nums">{row.count}</strong>
                    </div>
                  ))}
                </div>
              </CardContent>
            </GlassCard>
            <GlassCard className="min-w-0 lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Webhook jobs</CardTitle>
              </CardHeader>
              <CardContent className="p-0 sm:px-0">
                <div className="overflow-x-auto rounded-b-xl">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-left text-xs text-muted-foreground">
                        <th className="p-3 font-medium">ID</th>
                        <th className="p-3 font-medium">Source</th>
                        <th className="p-3 font-medium">Type</th>
                        <th className="p-3 font-medium">Status</th>
                        <th className="p-3 font-medium">Attempts</th>
                        <th className="p-3 font-medium">Received</th>
                        <th className="p-3 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(webhookJobs.data ?? []).map((row) => (
                        <tr key={row.id} className="border-b border-white/5 hover:bg-white/[0.04]">
                          <td className="p-3 font-mono text-xs">{row.id}</td>
                          <td className="p-3">{row.source}</td>
                          <td className="p-3 text-xs text-muted-foreground">{row.event_type ?? "—"}</td>
                          <td className="p-3">
                            <StatusPill status={row.status} />
                          </td>
                          <td className="p-3 font-mono tabular-nums">{row.attempts}</td>
                          <td className="p-3 text-xs text-muted-foreground">{fmtDate(row.received_at)}</td>
                          <td className="p-3 text-xs text-rose-200/80">{row.error_message ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                    <Button onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "runSync sonarr/incremental")}>
                      Sonarr incremental
                    </Button>
                    <Button variant="secondary" onClick={() => runAction(() => api.runSync("radarr", "incremental"), "runSync radarr/incremental")}>
                      Radarr incremental
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Full (entire library from Arr — slow)</p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => runFullSync("sonarr", "runSync sonarr/full")}>
                      Sonarr full
                    </Button>
                    <Button variant="outline" onClick={() => runFullSync("radarr", "runSync radarr/full")}>
                      Radarr full
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {workStatus.data?.active
                    ? `${workStatus.data.items.length} job(s) active (warehouse, MAL, and/or setup). See the status panel below.`
                    : syncProgress.data?.running
                      ? `Running: ${syncProgress.data.source}/${syncProgress.data.mode} (${syncProgress.data.trigger ?? "unknown"}) — ${fmtDuration(syncProgress.data.elapsed_seconds)}`
                      : "Idle — no sync or MAL pipeline in progress."}
                </p>
              </CardContent>
            </GlassCard>
            <GlassCard className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">System</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => runAction(() => api.replayDeadLetter("sonarr"), "replay sonarr dead-letter")}>
                    Replay Sonarr dead letter
                  </Button>
                  <Button variant="secondary" onClick={() => runAction(() => api.replayDeadLetter("radarr"), "replay radarr dead-letter")}>
                    Replay Radarr dead letter
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  className="w-fit"
                  onClick={() => {
                    if (window.confirm("Type RESET in the prompt to continue")) {
                      const typed = window.prompt("Type RESET");
                      if (typed?.trim().toUpperCase() === "RESET") {
                        runAction(() => api.resetData(), "reset data");
                      }
                    }
                  }}
                >
                  Reset data
                </Button>
                <Button
                  variant="outline"
                  className="w-fit border-amber-500/50 text-amber-100 hover:bg-amber-500/10"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Reset MAL data only? This clears dub list history, MAL anime rows, warehouse links, external IDs, manual MAL links, ingest checkpoints, tag apply state, and MAL job history. Sonarr/Radarr warehouse and app settings (including your MAL client ID) are not changed.",
                      )
                    ) {
                      const typed = window.prompt("Type RESET_MAL to confirm");
                      if (typed?.trim().toUpperCase() === "RESET_MAL") {
                        void runAction(async () => {
                          await api.resetMalData();
                          await queryClient.invalidateQueries({ queryKey: ["status"] });
                        }, "reset MAL data");
                      }
                    }
                  }}
                >
                  Reset MAL Data
                </Button>
                <div className="space-y-2 border-t border-white/10 pt-3">
                  <p className="text-xs text-muted-foreground">
                    Long tasks (MAL ingest, Sonarr/Radarr syncs, and similar) run <strong className="text-foreground/90">inside the app
                    process</strong>. A crash or kill can leave coordination rows in Postgres (locks) or
                    &quot;running&quot; job rows. Use the controls below to clear that <strong className="text-foreground/90">DB
                    state</strong> so new work can start. Failing live warehouse runs is off by default—only use it if you are
                    sure nothing is really running.
                  </p>
                  {stuckState.isError ? (
                    <p className="text-xs text-rose-200/80">Could not load stuck state.</p>
                  ) : null}
                  <ul className="list-inside list-disc text-xs text-muted-foreground">
                    <li>
                      Job lock rows: {stuckState.data?.job_locks?.length ?? (stuckState.isLoading ? "…" : 0)}
                    </li>
                    <li>Running MAL job rows: {stuckState.data?.mal_job_runs_running?.length ?? (stuckState.isLoading ? "…" : 0)}</li>
                    <li>
                      Running warehouse <code className="rounded bg-white/5 px-0.5">sync_run</code> rows:{" "}
                      {stuckState.data?.warehouse_sync_runs_running?.length ?? (stuckState.isLoading ? "…" : 0)}
                    </li>
                    <li>
                      Running Sonarr/Radarr <code className="rounded bg-white/5 px-0.5">job_run_summary</code> rows:{" "}
                      {stuckState.data?.job_run_summary_running?.length ?? (stuckState.isLoading ? "…" : 0)}
                    </li>
                  </ul>
                  {stuckState.data && stuckState.data.job_locks.length > 0 ? (
                    <ul className="max-h-24 overflow-y-auto rounded border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[10px] text-muted-foreground">
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
                        Remove <strong className="text-foreground/90">all</strong> rows in <code className="rounded bg-white/5 px-0.5">app.job_lock</code> (ignores
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
                        Remove <code className="rounded bg-white/5 px-0.5">mal:ingest</code> lock
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
                      <Label htmlFor="stuck-wh-fail" className="text-xs text-amber-200/80">
                        Mark &quot;running&quot; warehouse sync runs and Sonarr/Radarr job summary rows as failed (dangerous if a
                        sync is still running)
                      </Label>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    className="w-fit"
                    onClick={() => {
                      if (
                        !window.confirm(
                          "Type CLEAR_STUCK in the next prompt. This may delete rows in app.job_lock, update app.mal_job_run, warehouse.sync_run, and app.job_run_summary.",
                        )
                      ) {
                        return;
                      }
                      const typed = window.prompt("Type CLEAR_STUCK to confirm");
                      if (typed?.trim().toUpperCase() !== "CLEAR_STUCK") return;
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
                        void queryClient.invalidateQueries({ queryKey: ["stuck-state"] });
                        void queryClient.invalidateQueries({ queryKey: ["status"] });
                        void queryClient.invalidateQueries({ queryKey: ["work-status"] });
                        void queryClient.invalidateQueries({ queryKey: ["sync-activity"] });
                        void queryClient.invalidateQueries({ queryKey: ["sync-progress"] });
                        void queryClient.invalidateQueries({ queryKey: ["runs"] });
                        return r;
                      }, "clear stuck state");
                    }}
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
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Large ingests can take a long time. Requires MAL client id in Integrations or{" "}
                <code className="rounded bg-white/5 px-1">MAL_CLIENT_ID</code>. Each run fetches at most one batch of IDs
                (default from server: {malConfig.data?.mal_max_ids_per_run ?? "…"} per batch). MAL and Jikan requests are
                throttled per server settings (
                {malConfig.data ? `${malConfig.data.mal_min_request_interval_seconds}s` : "…"} /{" "}
                {malConfig.data ? `${malConfig.data.mal_jikan_min_request_interval_seconds}s` : "…"} Jikan).
              </p>
              <p className="text-sm text-muted-foreground">
                <strong className="text-foreground/90">Matching:</strong> links use TVDB/TMDB/IMDB when Jikan exposes them.
                If you have few externals, enable <strong className="text-foreground/90">allow title+year</strong> under
                Integrations → MyAnimeList, then run match refresh — the matcher uses main title, alternate titles
                (including Jikan variants), and year (±1 year) against your Sonarr/Radarr warehouse titles.
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <label className="pill">
                  IDs per batch
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={malBatchSize}
                    onChange={(event) => setMalBatchSize(Math.max(1, Math.min(500, Number(event.target.value || 200))))}
                    style={{ width: 72, marginLeft: 8 }}
                    title="MAL_MAX_IDS_PER_RUN override for this action (1–500)"
                  />
                </label>
                <label className="pill">
                  backlog cycles
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={malBacklogCycles}
                    onChange={(event) => setMalBacklogCycles(Number(event.target.value || 10))}
                    style={{ width: 80, marginLeft: 8 }}
                    disabled={malImportAll}
                  />
                </label>
                <label className="pill">
                  delay between cycles (sec)
                  <input
                    type="number"
                    min={0}
                    max={30}
                    step={0.5}
                    value={malCycleDelaySeconds}
                    onChange={(event) => setMalCycleDelaySeconds(Number(event.target.value || 0))}
                    style={{ width: 80, marginLeft: 8 }}
                  />
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-white/10 px-2 py-1 text-xs">
                  <input
                    type="checkbox"
                    checked={malImportAll}
                    onChange={(event) => setMalImportAll(event.target.checked)}
                  />
                  import all pending (auto cycles)
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() =>
                    void runMalPipeline(
                      () => api.triggerMalIngest({ max_ids_per_run: Math.max(1, Math.min(500, malBatchSize)) }),
                      "MAL ingest",
                    )
                  }
                >
                  Run MAL ingest
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void runMalPipeline(
                      () =>
                        api.triggerMalIngestBacklog({
                          import_all: malImportAll,
                          max_cycles: Math.max(1, Math.min(200, malBacklogCycles)),
                          cycle_delay_seconds: Math.max(0, Math.min(30, malCycleDelaySeconds)),
                          max_ids_per_run: Math.max(1, Math.min(500, malBatchSize)),
                        }),
                      "MAL ingest backlog",
                    )
                  }
                >
                  Process pending backlog
                </Button>
                <Button
                  variant="default"
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Import all pending MAL fetches? This runs many batches until the queue is empty (or cap). Keep the tab open; it can take a long time.",
                      )
                    ) {
                      return;
                    }
                    void runMalPipeline(
                      () =>
                        api.triggerMalIngestBacklog({
                          import_all: true,
                          max_ids_per_run: Math.max(1, Math.min(500, malBatchSize)),
                          cycle_delay_seconds: Math.max(1, Math.min(30, malCycleDelaySeconds)),
                        }),
                      "MAL import all pending",
                    );
                  }}
                >
                  Import all pending
                </Button>
                <Button variant="secondary" onClick={() => void runMalPipeline(() => api.triggerMalMatchRefresh(), "MAL match refresh")}>
                  Run match refresh
                </Button>
                <Button variant="secondary" onClick={() => void runMalPipeline(() => api.triggerMalTagSync(), "MAL tag sync")}>
                  Run tag sync
                </Button>
                <Button variant="outline" onClick={() => void runAllMalPipelines()}>
                  Run all MAL pipelines
                </Button>
              </div>
              {malPipelineResult ? (
                <pre className="max-h-52 overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-cyan-100/90">{malPipelineResult}</pre>
              ) : null}
            </CardContent>
          </GlassCard>
        </TabsContent>
      </Tabs>

      <WorkStatusPanel
        title="Live status &amp; ETA"
        description="All in-flight work: Sonarr/Radarr warehouse syncs (any trigger), MAL ingest/matcher/tag, and setup-wizard library import. Progress uses historical run times when available; MAL ingest shows batch position while running."
        dense
      />
    </div>
  );
}
