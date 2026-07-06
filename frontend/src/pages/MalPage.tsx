import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle2, Clapperboard, Link2, ListChecks, Loader, Tags } from "lucide-react";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate, fmtDuration } from "../hooks";
import { useActionError } from "../hooks/useActionError";
import { useServerEventsStatus } from "../hooks/useServerEvents";
import { StatusPill } from "../components/ui";
import { GlassCard, CardContent, CardHeader, CardTitle } from "../components/nebula/GlassCard";
import { useConfirmDialog } from "../components/nebula/ConfirmDialog";
import { MetricCard } from "../components/nebula/MetricCard";
import { QueryErrorNotice } from "../components/nebula/QueryErrorNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MalJobRunRow } from "../types";
import { PATHS } from "../routes/paths";

const JOB_TYPES = ["all", "ingest", "matcher", "tag_sync"] as const;
type JobTypeFilter = (typeof JOB_TYPES)[number];

function runDurationSeconds(run: MalJobRunRow): number | null {
  if (!run.finished_at) return null;
  const started = new Date(run.started_at).getTime();
  const finished = new Date(run.finished_at).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
  return (finished - started) / 1000;
}

function detailsSummary(details: Record<string, unknown>): string {
  const entries = Object.entries(details).filter(([, value]) => typeof value !== "object" || value === null);
  if (entries.length === 0) return "—";
  return entries
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}

export function MalPage(): JSX.Element {
  usePageTitle("MyAnimeList");
  const queryClient = useQueryClient();
  const { setError } = useActionError();
  const { requestConfirm, confirmDialog } = useConfirmDialog();
  const { connected: sseConnected } = useServerEventsStatus();

  const malConfig = useQuery({ queryKey: ["mal-config"], queryFn: api.malConfig });
  const overview = useQuery({
    queryKey: ["mal-overview"],
    queryFn: () => api.malOverview(200),
    refetchInterval: sseConnected ? 60_000 : 30_000,
  });
  const [jobTypeFilter, setJobTypeFilter] = useState<JobTypeFilter>("all");
  const jobRuns = useQuery({
    queryKey: ["mal-job-runs", jobTypeFilter],
    queryFn: () => api.malJobRuns(jobTypeFilter, 50),
    refetchInterval: sseConnected ? 60_000 : 30_000,
  });

  const [malPipelineResult, setMalPipelineResult] = useState<{ label: string; details: Record<string, unknown> } | null>(
    null,
  );
  const [malBacklogCycles, setMalBacklogCycles] = useState(10);
  const [malCycleDelaySeconds, setMalCycleDelaySeconds] = useState(2);
  const [malBatchSize, setMalBatchSize] = useState(200);
  const [malImportAll, setMalImportAll] = useState(false);

  useEffect(() => {
    const n = malConfig.data?.mal_max_ids_per_run;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) {
      setMalBatchSize(Math.max(1, Math.min(500, n)));
    }
  }, [malConfig.data?.mal_max_ids_per_run]);

  const refreshMalQueries = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["status"] });
    await queryClient.invalidateQueries({ queryKey: ["mal-overview"] });
    await queryClient.invalidateQueries({ queryKey: ["mal-job-runs"] });
  };

  const runMalPipeline = async (
    fn: () => Promise<{ status: string; details?: unknown }>,
    label: string,
  ): Promise<void> => {
    try {
      const r = await fn();
      const details = r.details && typeof r.details === "object" ? (r.details as Record<string, unknown>) : {};
      setMalPipelineResult({ label, details });
      await refreshMalQueries();
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
      setMalPipelineResult({
        label: "MAL run all",
        details: {
          ingest_backlog: ingestBacklog.details ?? {},
          match_refresh: matcher.details ?? {},
          tag_sync: tagSync.details ?? {},
        },
      });
      await refreshMalQueries();
    } catch (err) {
      setError(err, "MAL run all");
    }
  };

  const flatResultEntries = malPipelineResult
    ? Object.entries(malPipelineResult.details).filter(([, value]) => typeof value !== "object" || value === null)
    : [];
  const nestedResultEntries = malPipelineResult
    ? Object.entries(malPipelineResult.details).filter(([, value]) => typeof value === "object" && value !== null)
    : [];

  return (
    <div className="space-y-6">
      {!malConfig.data?.client_id_configured && !malConfig.data?.env_fallback_configured ? (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
          No MAL client ID configured — ingest runs will fail. Set one under{" "}
          <Link to={PATHS.integrations} className="text-primary hover:underline">
            Integrations → MyAnimeList
          </Link>
          .
        </p>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 2xl:grid-cols-6">
        <MetricCard label="Dubbed anime" value={overview.data?.dubbed_total ?? "—"} icon={Clapperboard} />
        <MetricCard
          label="Metadata fetched"
          value={overview.data?.fetched_success ?? "—"}
          hint="MAL/Jikan lookups completed"
          icon={CheckCircle2}
        />
        <MetricCard
          label="Pending fetch"
          value={overview.data?.pending_fetch ?? "—"}
          hint="waiting in the ingest queue"
          icon={Loader}
        />
        <MetricCard
          label="Linked to library"
          value={overview.data?.linked ?? "—"}
          hint="matched to Sonarr/Radarr items"
          icon={Link2}
        />
        <MetricCard label="Unmatched" value={overview.data?.unlinked ?? "—"} icon={ListChecks} />
        <MetricCard label="Manual links" value={overview.data?.manual_link_count ?? "—"} icon={Tags} />
      </div>

      <GlassCard>
        <CardHeader>
          <CardTitle className="text-base">Pipelines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Large ingests can take a long time. Requires MAL client id in Integrations or{" "}
            <code className="rounded bg-muted px-1">MAL_CLIENT_ID</code>. Each run fetches at most one batch of IDs
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
            <label className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
              IDs per batch
              <input
                type="number"
                min={1}
                max={500}
                className="w-[72px] rounded border border-input bg-background px-1.5 py-0.5"
                value={malBatchSize}
                onChange={(event) => setMalBatchSize(Math.max(1, Math.min(500, Number(event.target.value || 200))))}
                title="MAL_MAX_IDS_PER_RUN override for this action (1–500)"
              />
            </label>
            <label className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
              backlog cycles
              <input
                type="number"
                min={1}
                max={200}
                className="w-20 rounded border border-input bg-background px-1.5 py-0.5"
                value={malBacklogCycles}
                onChange={(event) => setMalBacklogCycles(Number(event.target.value || 10))}
                disabled={malImportAll}
              />
            </label>
            <label className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
              delay between cycles (sec)
              <input
                type="number"
                min={0}
                max={30}
                step={0.5}
                className="w-20 rounded border border-input bg-background px-1.5 py-0.5"
                value={malCycleDelaySeconds}
                onChange={(event) => setMalCycleDelaySeconds(Number(event.target.value || 0))}
              />
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
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
              onClick={() =>
                requestConfirm({
                  title: "Import all pending MAL fetches?",
                  description:
                    "This runs batch after batch until the queue is empty (or the cap is reached). Keep the tab open; it can take a long time.",
                  confirmLabel: "Import all",
                  onConfirm: () =>
                    void runMalPipeline(
                      () =>
                        api.triggerMalIngestBacklog({
                          import_all: true,
                          max_ids_per_run: Math.max(1, Math.min(500, malBatchSize)),
                          cycle_delay_seconds: Math.max(1, Math.min(30, malCycleDelaySeconds)),
                        }),
                      "MAL import all pending",
                    ),
                })
              }
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
            <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-sm font-medium">{malPipelineResult.label}</p>
              {flatResultEntries.length > 0 ? (
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  {flatResultEntries.map(([key, value]) => (
                    <div className="flex items-baseline justify-between gap-2" key={key}>
                      <dt className="text-muted-foreground">{key}</dt>
                      <dd className="font-mono tabular-nums">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {nestedResultEntries.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">Full details</summary>
                  <pre className="mt-2 max-h-52 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] text-foreground/90">
                    {JSON.stringify(Object.fromEntries(nestedResultEntries), null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </GlassCard>

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
        <GlassCard className="min-w-0">
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">Job history</CardTitle>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Type
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                value={jobTypeFilter}
                onChange={(event) => setJobTypeFilter(event.target.value as JobTypeFilter)}
                aria-label="Filter job runs by type"
              >
                {JOB_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t === "all" ? "All" : t.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
          </CardHeader>
          <CardContent className="p-0 sm:px-0">
            {jobRuns.isError ? (
              <div className="px-4 pb-3">
                <QueryErrorNotice label="MAL job runs" retry={() => void jobRuns.refetch()} error={jobRuns.error} />
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                    <th className="p-3 font-medium">Type</th>
                    <th className="p-3 font-medium">Status</th>
                    <th className="p-3 font-medium">Started</th>
                    <th className="p-3 font-medium">Duration</th>
                    <th className="p-3 font-medium">Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {(jobRuns.data ?? []).map((run) => {
                    const duration = runDurationSeconds(run);
                    return (
                      <tr key={run.id} className="border-b border-border/60 last:border-0 hover:bg-muted/50">
                        <td className="p-3 font-mono text-xs">{run.job_type}</td>
                        <td className="p-3">
                          <StatusPill status={run.status} />
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">{fmtDate(run.started_at)}</td>
                        <td className="p-3 font-mono text-xs tabular-nums">
                          {duration != null ? fmtDuration(duration) : run.status === "running" ? "…" : "—"}
                        </td>
                        <td
                          className="max-w-[260px] truncate p-3 text-xs text-muted-foreground"
                          title={run.error_message ?? JSON.stringify(run.details)}
                        >
                          {run.error_message ? (
                            <span className="text-critical">{run.error_message}</span>
                          ) : (
                            detailsSummary(run.details)
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!jobRuns.isLoading && (jobRuns.data ?? []).length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground">No MAL job runs recorded yet.</p>
              ) : null}
            </div>
          </CardContent>
        </GlassCard>

        <GlassCard className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">Unmatched dubbed anime</CardTitle>
            <p className="text-xs text-muted-foreground">
              Dubbed MAL entries not linked to any Sonarr/Radarr item (first 200). Run match refresh after adding the
              show/movie to your library.
            </p>
          </CardHeader>
          <CardContent className="p-0 sm:px-0">
            {overview.isError ? (
              <div className="px-4 pb-3">
                <QueryErrorNotice label="MAL overview" retry={() => void overview.refetch()} error={overview.error} />
              </div>
            ) : null}
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="p-3 font-medium">MAL ID</th>
                    <th className="p-3 font-medium">Title</th>
                    <th className="p-3 font-medium">Type</th>
                    <th className="p-3 font-medium">Eps</th>
                    <th className="p-3 font-medium">Fetch</th>
                  </tr>
                </thead>
                <tbody>
                  {(overview.data?.unmatched ?? []).map((row) => (
                    <tr key={row.mal_id} className="border-b border-border/60 last:border-0 hover:bg-muted/50">
                      <td className="p-3 font-mono text-xs">
                        <a
                          href={`https://myanimelist.net/anime/${row.mal_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {row.mal_id}
                        </a>
                      </td>
                      <td className="max-w-[220px] truncate p-3" title={row.main_title ?? undefined}>
                        {row.main_title ?? "—"}
                        {row.has_manual_link ? (
                          <Badge variant="outline" className="ml-2 text-[0.6rem]">
                            manual link
                          </Badge>
                        ) : null}
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">{row.media_type ?? "—"}</td>
                      <td className="p-3 font-mono text-xs tabular-nums">{row.num_episodes ?? "—"}</td>
                      <td className="p-3 text-xs text-muted-foreground">{row.mal_fetch_status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!overview.isLoading && (overview.data?.unmatched ?? []).length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground">
                  Every dubbed MAL entry is linked to your library. Nothing to do here.
                </p>
              ) : null}
            </div>
          </CardContent>
        </GlassCard>
      </div>

      <p className="text-xs text-muted-foreground">
        MAL data reset and stuck-state controls live under{" "}
        <Link to={`${PATHS.sync}?tab=manual`} className="text-primary hover:underline">
          Sync &amp; Queue → Manual
        </Link>
        . Feature toggles and the client ID live under{" "}
        <Link to={PATHS.integrations} className="text-primary hover:underline">
          Integrations → MyAnimeList
        </Link>
        .
      </p>
      {confirmDialog}
    </div>
  );
}
