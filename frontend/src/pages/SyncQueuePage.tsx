import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate, fmtDuration } from "../hooks";
import { useActionError } from "../hooks/useActionError";
import { StatusPill } from "../components/ui";
import { GlassCard, CardContent, CardHeader, CardTitle } from "../components/nebula/GlassCard";
import { ProgressBar } from "../components/nebula/ProgressBar";
import { Button } from "@/components/ui/button";
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
  const [malPipelineResult, setMalPipelineResult] = useState<string | null>(null);

  const runs = useQuery({ queryKey: ["runs"], queryFn: api.recentRuns, refetchInterval: 15_000 });
  const webhookQueue = useQuery({ queryKey: ["webhook-queue"], queryFn: api.webhookQueue, refetchInterval: 15_000 });
  const webhookJobs = useQuery({
    queryKey: ["webhook-jobs"],
    queryFn: () => api.webhookJobs(),
    refetchInterval: 15_000,
  });
  const syncProgress = useQuery({ queryKey: ["sync-progress"], queryFn: api.syncProgress, refetchInterval: 2_000 });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 15_000 });

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
                        {syncProgress.data.source}/{syncProgress.data.mode}
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
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "runSync sonarr/incremental")}>
                    Sonarr incremental
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => runAction(() => api.runSync("radarr", "incremental"), "runSync radarr/incremental")}>
                    Radarr incremental
                  </Button>
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
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "runSync sonarr/incremental")}>Sonarr incremental</Button>
                  <Button variant="secondary" onClick={() => runAction(() => api.runSync("radarr", "incremental"), "runSync radarr/incremental")}>
                    Radarr incremental
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {syncProgress.data?.running
                    ? `Running: ${syncProgress.data.source}/${syncProgress.data.mode} — ${fmtDuration(syncProgress.data.elapsed_seconds)}`
                    : "Idle — no manual sync in progress."}
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
              </CardContent>
            </GlassCard>
          </div>
          <GlassCard>
            <CardHeader>
              <CardTitle className="text-base">MyAnimeList pipelines</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Large ingests can take several minutes. Requires MAL client id in Integrations or <code className="rounded bg-white/5 px-1">MAL_CLIENT_ID</code>.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void runMalPipeline(() => api.triggerMalIngest(), "MAL ingest")}>
                  Run MAL ingest
                </Button>
                <Button variant="secondary" onClick={() => void runMalPipeline(() => api.triggerMalMatchRefresh(), "MAL match refresh")}>
                  Run match refresh
                </Button>
                <Button variant="secondary" onClick={() => void runMalPipeline(() => api.triggerMalTagSync(), "MAL tag sync")}>
                  Run tag sync
                </Button>
              </div>
              {malPipelineResult ? (
                <pre className="max-h-52 overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-cyan-100/90">{malPipelineResult}</pre>
              ) : null}
            </CardContent>
          </GlassCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
