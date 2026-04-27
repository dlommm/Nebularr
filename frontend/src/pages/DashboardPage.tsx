import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Film, GitBranch, HeartPulse, Inbox, LayoutList, ListVideo, Server } from "lucide-react";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate, fmtDuration } from "../hooks";
import { MAL_JOB_TYPE_ORDER } from "../constants/domain";
import { StatusPill } from "../components/ui";
import { useActionError } from "../hooks/useActionError";
import { GlassCard, CardContent, CardHeader, CardTitle, CardDescription } from "../components/nebula/GlassCard";
import { HealthPillsRow } from "../components/nebula/HealthPillsRow";
import { MetricCard } from "../components/nebula/MetricCard";
import { EmptyState } from "../components/nebula/EmptyState";
import { WorkStatusPanel } from "../components/nebula/WorkStatusPanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PATHS } from "../routes/paths";

export function DashboardPage(): JSX.Element {
  usePageTitle("Dashboard");
  const navigate = useNavigate();
  const { runAction } = useActionError();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: 15_000,
  });
  const syncActivity = useQuery({
    queryKey: ["sync-activity"],
    queryFn: api.syncActivity,
    refetchInterval: 5_000,
  });
  const malSync = status.data?.mal_sync;
  const healthOk = status.data?.health_state === "ok";

  return (
    <div className="space-y-8">
      <div className="relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 via-[#0e1630] to-violet-600/20 p-6 nebula-glow sm:p-8">
        <div className="absolute -right-20 -top-20 size-64 rounded-full bg-violet-500/20 blur-3xl" aria-hidden />
        <div className="absolute -bottom-16 -left-10 size-56 rounded-full bg-cyan-500/15 blur-3xl" aria-hidden />
        <div className="relative z-[1] flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-[0.2em] text-cyan-200/80 uppercase">Overview</p>
            <h2 className="mt-1 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">Mission control</h2>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Live sync telemetry, health, and queue pressure. Data refreshes every few seconds.
            </p>
          </div>
          <div className="flex w-full min-w-0 flex-shrink-0 flex-col items-stretch gap-2 sm:w-auto sm:items-end">
            <div className="flex flex-wrap items-stretch justify-start gap-2 sm:justify-end">
              <Button className="min-w-0" size="sm" onClick={() => runAction(() => api.runSync("sonarr", "incremental"), "dashboard sonarr")}>
                Sonarr incremental
              </Button>
              <Button className="min-w-0" size="sm" variant="secondary" onClick={() => runAction(() => api.runSync("radarr", "incremental"), "dashboard radarr")}>
                Radarr incremental
              </Button>
              <Button type="button" className="min-w-0" size="sm" variant="outline" onClick={() => navigate(PATHS.sync)}>
                Open sync &amp; queue
              </Button>
            </div>
            <div className="flex flex-wrap items-stretch justify-start gap-2 sm:justify-end">
              <Button
                className="min-w-0"
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (window.confirm("Run Sonarr full sync? This re-fetches the full library and may run for a long time.")) {
                    void runAction(() => api.runSync("sonarr", "full"), "dashboard sonarr full");
                  }
                }}
              >
                Sonarr full
              </Button>
              <Button
                className="min-w-0"
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (window.confirm("Run Radarr full sync? This re-fetches the full library and may run for a long time.")) {
                    void runAction(() => api.runSync("radarr", "full"), "dashboard radarr full");
                  }
                }}
              >
                Radarr full
              </Button>
            </div>
          </div>
        </div>
      </div>

      <WorkStatusPanel title="Sync &amp; pipeline status" />

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-6">
        <MetricCard label="Total sync runs" value={status.data?.jobs_total ?? "—"} icon={GitBranch} />
        <MetricCard
          label="Webhook backlog"
          value={status.data?.webhook_queue_open ?? "—"}
          hint={`DL: ${status.data?.webhook_queue_dead_letter ?? 0}`}
          icon={Inbox}
        />
        <MetricCard label="Active syncs" value={status.data?.active_sync_count ?? "—"} icon={Server} />
        <MetricCard
          label="Activity rows"
          value={syncActivity.isLoading ? "…" : (syncActivity.data?.length ?? 0)}
          hint="from sync-activity"
          icon={ListVideo}
        />
        <MetricCard
          label="Sonarr lag"
          value={status.data ? `${Math.round((status.data.sync_lag_seconds.sonarr ?? 0) * 10) / 10}s` : "—"}
          icon={LayoutList}
        />
        <MetricCard
          label="Radarr lag"
          value={status.data ? `${Math.round((status.data.sync_lag_seconds.radarr ?? 0) * 10) / 10}s` : "—"}
          icon={Film}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <GlassCard className="border-white/10">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HeartPulse className="size-4 text-emerald-300/80" strokeWidth={1.75} aria-hidden />
              Health
            </CardTitle>
            <CardDescription>Control-plane + subsystem breakdown (queues, lag, Sonarr/Radarr, MAL)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {status.isLoading ? (
              <Skeleton className="h-10 w-full bg-white/10" />
            ) : status.data ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      "border",
                      healthOk
                        ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                        : status.data.health_state === "critical"
                          ? "border-rose-500/50 bg-rose-500/10 text-rose-200"
                          : "border-amber-500/50 bg-amber-500/10 text-amber-200",
                    )}
                  >
                    {status.data.health_state}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Sonarr {status.data.arr_versions.sonarr} · Radarr {status.data.arr_versions.radarr}
                  </span>
                </div>
                {status.data.health_dimensions ? (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Subsystems</p>
                    <HealthPillsRow
                      dimensions={status.data.health_dimensions}
                      reasonMap={status.data.health_dimension_reasons}
                      size="md"
                    />
                  </div>
                ) : null}
                {status.data.health_state !== "ok" ? (
                  <p className="text-sm text-amber-100/90">{status.data.health_reasons?.join(", ") || "No reason codes"}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">All checks nominal for the current thresholds.</p>
                )}
                <p className="text-xs text-muted-foreground/90 leading-relaxed">
                  <code className="rounded bg-white/5 px-1">Queues</code> = webhook queue backlog + dead-letter.{" "}
                  <code className="rounded bg-white/5 px-1">Sync</code> = history lag. <code className="rounded bg-white/5 px-1">Arr</code> = known app
                  versions. <code className="rounded bg-white/5 px-1">MAL</code> = client + last job results when MAL is enabled.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Status unavailable.</p>
            )}
          </CardContent>
        </GlassCard>

        {malSync ? (
          <GlassCard className="border-violet-500/20" id="mal">
            <CardHeader>
              <CardTitle className="text-base">MyAnimeList sync</CardTitle>
              <CardDescription>
                Ingest, matcher, and tag sync.{" "}
                <Badge variant="secondary" className="ml-1 align-middle text-[0.65rem]">
                  {malSync.client_configured ? "client id set" : "client id missing"}
                </Badge>
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0 sm:px-0">
              <div className="px-4 pb-3 text-xs text-muted-foreground">
                fetched {malSync.fetched_success_count ?? 0} / {malSync.dubbed_total ?? 0} dubbed MAL entries · pending{" "}
                {malSync.pending_fetch_count ?? 0}
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-transparent">
                      <TableHead>Job</TableHead>
                      <TableHead>Scheduler</TableHead>
                      <TableHead>Last finished</TableHead>
                      <TableHead>Active run</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {MAL_JOB_TYPE_ORDER.map((jobType) => {
                      const enabled =
                        jobType === "ingest"
                          ? malSync.schedulers.ingest_enabled
                          : jobType === "matcher"
                            ? malSync.schedulers.matcher_enabled
                            : malSync.schedulers.tagging_enabled;
                      const last = malSync.last_finished[jobType];
                      const running = malSync.running.find((r) => r.job_type === jobType);
                      const label = jobType === "tag_sync" ? "tag sync" : jobType;
                      return (
                        <TableRow key={jobType} className="border-white/5">
                          <TableCell className="font-medium">{label}</TableCell>
                          <TableCell>{enabled ? <Badge variant="outline">on</Badge> : <span className="text-muted-foreground">off</span>}</TableCell>
                          <TableCell>
                            {last ? (
                              <div className="space-y-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <StatusPill status={last.status} />
                                  <span className="text-xs text-muted-foreground">{fmtDate(last.finished_at)}</span>
                                </div>
                                {last.error_message ? (
                                  <p className="text-xs text-rose-200/80">{String(last.error_message)}</p>
                                ) : null}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {running ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <StatusPill status="running" />
                                <span className="text-xs text-muted-foreground">since {fmtDate(running.started_at)}</span>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </GlassCard>
        ) : null}
      </div>

      <GlassCard>
        <CardHeader>
          <CardTitle className="text-base">Live sync activity</CardTitle>
          <CardDescription>Active and recent work from /api/ui/sync-activity (5s refresh)</CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-0">
          {syncActivity.isLoading ? (
            <div className="space-y-2 px-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full bg-white/10" />
              ))}
            </div>
          ) : (syncActivity.data?.length ?? 0) === 0 ? (
            <EmptyState title="No active syncs" description="When jobs run, they will appear here with stage and elapsed time." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10 hover:bg-transparent">
                    <TableHead>Source</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Instance</TableHead>
                    <TableHead>Elapsed</TableHead>
                    <TableHead>Rows</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(syncActivity.data ?? []).map((row) => (
                    <TableRow key={row.run_id} className="border-white/5">
                      <TableCell className="font-mono text-xs">{row.source}</TableCell>
                      <TableCell className="font-mono text-xs">{row.mode}</TableCell>
                      <TableCell>
                        <StatusPill status={row.status} />
                      </TableCell>
                      <TableCell className="text-xs">{row.trigger}</TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">
                        {row.stage_note ? `${row.stage} (${row.stage_note})` : row.stage}
                      </TableCell>
                      <TableCell className="text-xs">{row.instance_name}</TableCell>
                      <TableCell className="font-mono text-xs tabular-nums">{fmtDuration(row.elapsed_seconds)}</TableCell>
                      <TableCell className="font-mono text-xs tabular-nums">{row.records_processed}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </GlassCard>
    </div>
  );
}
