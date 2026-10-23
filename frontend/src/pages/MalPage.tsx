import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtDate, fmtDuration } from "../hooks";
import { useActionError } from "../hooks/useActionError";
import { pollInterval, useServerEventsStatus } from "../hooks/useServerEvents";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/nebula/StatusBadge";
import { useConfirmDialog } from "../components/nebula/ConfirmDialog";
import { QueryErrorNotice } from "../components/nebula/QueryErrorNotice";
import { WorkStatusPanel } from "../components/nebula/WorkStatusPanel";
import { Button } from "@/components/ui/button";
import type { MalJobRunRow } from "../types";
import { PATHS } from "../routes/paths";
import { PageHead, SectionHead } from "@/components/ns/Page";
import { tableCellClass, tableHeadCellClass, tableHeadRowClass, tableRowClass } from "@/lib/ns";
import { dayOrClock, relTime, sinceShort } from "@/lib/time";
import { cn } from "@/lib/utils";

const JOB_TYPES = ["all", "ingest", "ingest_backlog", "matcher", "tag_sync", "coverage_tag_sync"] as const;
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
  usePageTitle("Anime");
  const queryClient = useQueryClient();
  const { setError } = useActionError();
  const { requestConfirm, confirmDialog } = useConfirmDialog();
  const { connected: sseConnected } = useServerEventsStatus();

  const malConfig = useQuery({ queryKey: queryKeys.malConfig, queryFn: api.malConfig });
  const overview = useQuery({
    queryKey: queryKeys.malOverview,
    queryFn: () => api.malOverview(200),
    refetchInterval: pollInterval(sseConnected, 30_000, 60_000),
    placeholderData: keepPreviousData,
  });
  const [jobTypeFilter, setJobTypeFilter] = useState<JobTypeFilter>("all");
  const jobRuns = useQuery({
    queryKey: queryKeys.malJobRuns(jobTypeFilter),
    queryFn: () => api.malJobRuns(jobTypeFilter, 50),
    refetchInterval: pollInterval(sseConnected, 30_000, 60_000),
    placeholderData: keepPreviousData,
  });

  // The stage meta lines need the newest run of every job type, whatever the
  // history table below is filtered to; "all" shares its cache entry.
  const lastRuns = useQuery({
    queryKey: queryKeys.malJobRuns("all"),
    queryFn: () => api.malJobRuns("all", 50),
    refetchInterval: pollInterval(sseConnected, 30_000, 60_000),
  });

  const [malPipelineResult, setMalPipelineResult] = useState<{ label: string; details: Record<string, unknown> } | null>(
    null,
  );
  const [malBacklogCycles, setMalBacklogCycles] = useState(10);
  const [malCycleDelaySeconds, setMalCycleDelaySeconds] = useState(2);
  // Raw text draft, not a parsed number: coercing on every keystroke (the
  // previous `Number(value || 200)` behavior) snaps an emptied field
  // straight back to "200", making it impossible to type a different value.
  // Parsed (and clamped) into `malBatchSize` below only when a pipeline is
  // actually triggered.
  const [malBatchSizeDraft, setMalBatchSizeDraft] = useState("200");
  const [malImportAll, setMalImportAll] = useState(false);

  // Populate the batch-size draft from the server default exactly once: a
  // naive `[malConfig.data?.mal_max_ids_per_run]` effect would resync (and
  // clobber) whatever the operator just typed on every unrelated refetch
  // (poll, SSE invalidation, a save on the Integrations page).
  const malBatchSizePopulatedRef = useRef(false);
  useEffect(() => {
    if (malBatchSizePopulatedRef.current) return;
    const n = malConfig.data?.mal_max_ids_per_run;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) {
      malBatchSizePopulatedRef.current = true;
      setMalBatchSizeDraft(String(Math.max(1, Math.min(500, n))));
    }
  }, [malConfig.data?.mal_max_ids_per_run]);

  const malBatchSize = Math.max(1, Math.min(500, Number.parseInt(malBatchSizeDraft, 10) || 200));

  // Pipeline triggers can block for up to ~30 minutes server-side; a shared
  // busy flag (guarded by a ref so a second click landing before the state
  // update re-renders can't slip through) disables every trigger button
  // while any one of them is in flight, instead of letting an impatient
  // double-click fire the same (or a different) pipeline twice.
  const malPipelineBusyRef = useRef(false);
  const [malPipelineBusy, setMalPipelineBusy] = useState(false);

  const refreshMalQueries = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.status });
    await queryClient.invalidateQueries({ queryKey: queryKeys.malOverview });
    await queryClient.invalidateQueries({ queryKey: queryKeys.malJobRuns() });
  };

  const runMalPipeline = async (
    fn: () => Promise<{ status: string; details?: unknown }>,
    label: string,
  ): Promise<void> => {
    if (malPipelineBusyRef.current) return;
    malPipelineBusyRef.current = true;
    setMalPipelineBusy(true);
    try {
      const r = await fn();
      const details = r.details && typeof r.details === "object" ? (r.details as Record<string, unknown>) : {};
      setMalPipelineResult({ label, details });
      await refreshMalQueries();
    } catch (err) {
      setError(err, label);
    } finally {
      malPipelineBusyRef.current = false;
      setMalPipelineBusy(false);
    }
  };

  const runAllMalPipelines = async (): Promise<void> => {
    if (malPipelineBusyRef.current) return;
    malPipelineBusyRef.current = true;
    setMalPipelineBusy(true);
    try {
      const ingestBacklog = await api.triggerMalIngestBacklog({
        max_cycles: Math.max(1, Math.min(200, malBacklogCycles)),
        cycle_delay_seconds: Math.max(0, Math.min(30, malCycleDelaySeconds)),
        max_ids_per_run: malBatchSize,
      });
      const matcher = await api.triggerMalMatchRefresh();
      const tagSync = await api.triggerMalTagSync();
      const coverageTagSync = malConfig.data?.coverage_tagging_enabled
        ? await api.triggerCoverageTagSync()
        : null;
      setMalPipelineResult({
        label: "MAL run all",
        details: {
          ingest_backlog: ingestBacklog.details ?? {},
          match_refresh: matcher.details ?? {},
          tag_sync: tagSync.details ?? {},
          ...(coverageTagSync ? { coverage_tag_sync: coverageTagSync.details ?? {} } : {}),
        },
      });
      await refreshMalQueries();
    } catch (err) {
      setError(err, "MAL run all");
    } finally {
      malPipelineBusyRef.current = false;
      setMalPipelineBusy(false);
    }
  };

  const flatResultEntries = malPipelineResult
    ? Object.entries(malPipelineResult.details).filter(([, value]) => typeof value !== "object" || value === null)
    : [];
  const nestedResultEntries = malPipelineResult
    ? Object.entries(malPipelineResult.details).filter(([, value]) => typeof value === "object" && value !== null)
    : [];

  const ov = overview.data;
  const linkedPct = ov && ov.dubbed_total > 0 ? Math.round((ov.linked / ov.dubbed_total) * 100) : 0;
  const allRuns = lastRuns.data ?? [];
  const lastOf = (...types: string[]): MalJobRunRow | undefined => allRuns.find((run) => types.includes(run.job_type));
  const stageMeta = (run: MalJobRunRow | undefined): string => {
    if (!run) return "not run yet";
    const duration = runDurationSeconds(run);
    return `last ${relTime(run.started_at)} · ${run.status === "running" ? "running" : duration != null ? fmtDuration(duration) : run.status}`;
  };
  const lastTag = lastOf("tag_sync", "coverage_tag_sync");
  const fieldClass = "min-h-11 w-24 rounded-sm border border-border bg-muted px-2.5 text-sm text-foreground disabled:opacity-50";
  const fieldLabelClass = "grid gap-1 text-[11px] text-subtle-foreground";

  return (
    <div className="pb-16">
      <PageHead
        title="Anime"
        lead="MyAnimeList matching and English-dub coverage, tagged back to Sonarr and Radarr."
        aside={
          ov ? (
            <div className="w-[min(460px,100%)] min-w-[280px]">
              <p className="text-lg">
                <span className="cond text-[40px] leading-none font-[640] tabular-nums">{ov.linked.toLocaleString()}</span>{" "}
                <span className="text-muted-foreground">of {ov.dubbed_total.toLocaleString()} dubbed titles are in your library</span>
              </p>
              <div
                className="mt-3.5 flex h-2.5 bg-border"
                role="img"
                aria-label={`${linkedPct} percent linked, ${100 - linkedPct} percent not in your library`}
              >
                <span className="h-full origin-left animate-grow-x bg-signal" style={{ width: `${linkedPct}%`, animationDelay: "300ms" }} />
              </div>
              {ov.partial_total ? (
                <p className="mt-2 text-[13px] text-subtle-foreground">{ov.partial_total.toLocaleString()} with partial dubs</p>
              ) : null}
            </div>
          ) : null
        }
      />

      {!malConfig.data?.client_id_configured && !malConfig.data?.env_fallback_configured ? (
        <p className="mb-6 border-y border-warn/40 py-3 text-sm text-warn">
          No MAL client ID configured — ingest runs will fail. Set one under{" "}
          <Link to={PATHS.integrations} className="border-b border-current">
            Integrations → MyAnimeList
          </Link>
          .
        </p>
      ) : null}

      <section aria-label="MyAnimeList pipeline" className="grid grid-cols-1 border-y border-border lg:grid-cols-3">
        {(
          [
            {
              step: "1 · Fetch from MyAnimeList",
              value: ov?.fetched_success.toLocaleString() ?? "—",
              sub: (
                <>
                  fetched ·{" "}
                  <span className={ov?.pending_fetch ? "text-warn" : undefined}>{ov?.pending_fetch.toLocaleString() ?? "—"} pending</span>
                </>
              ),
              meta: stageMeta(lastOf("ingest", "ingest_backlog")),
              actions: (
                <>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    disabled={malPipelineBusy}
                    onClick={() => void runMalPipeline(() => api.triggerMalIngest({ max_ids_per_run: malBatchSize }), "MAL ingest")}
                  >
                    Run MAL ingest
                  </Button>
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    disabled={malPipelineBusy}
                    onClick={() =>
                      void runMalPipeline(
                        () =>
                          api.triggerMalIngestBacklog({
                            import_all: malImportAll,
                            max_cycles: Math.max(1, Math.min(200, malBacklogCycles)),
                            cycle_delay_seconds: Math.max(0, Math.min(30, malCycleDelaySeconds)),
                            max_ids_per_run: malBatchSize,
                            // Unbounded imports run as a tracked background job.
                            wait: !malImportAll,
                          }),
                        malImportAll ? "MAL ingest backlog (queued)" : "MAL ingest backlog",
                      )
                    }
                  >
                    Process pending backlog
                  </Button>
                </>
              ),
            },
            {
              step: "2 · Match to your library",
              value: ov?.linked.toLocaleString() ?? "—",
              sub: (
                <>
                  matched · <span className={ov?.unlinked ? "text-warn" : undefined}>{ov?.unlinked.toLocaleString() ?? "—"} unmatched</span> ·{" "}
                  {ov?.manual_link_count ?? 0} by hand
                </>
              ),
              meta: stageMeta(lastOf("matcher")),
              actions: (
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={malPipelineBusy}
                  onClick={() => void runMalPipeline(() => api.triggerMalMatchRefresh(), "MAL match refresh")}
                >
                  Run match refresh
                </Button>
              ),
            },
            {
              step: "3 · Tag in Sonarr and Radarr",
              value: lastTag ? sinceShort(lastTag.started_at) : "never",
              sub: lastTag ? (
                <>
                  since the last tag sync · <StatusBadge status={lastTag.status} className="text-[13px]" />
                </>
              ) : (
                "no tag sync recorded yet"
              ),
              meta: lastTag
                ? `${lastTag.job_type.replace(/_/g, " ")} · ${lastTag.error_message ?? detailsSummary(lastTag.details)}`
                : "tags english-dub on matched items",
              actions: (
                <>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    disabled={malPipelineBusy}
                    onClick={() => void runMalPipeline(() => api.triggerMalTagSync(), "MAL tag sync")}
                  >
                    Run tag sync
                  </Button>
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    disabled={malPipelineBusy}
                    title="Reconciles fully-english / partial-english tags from your episode files. First run PUTs every anime series/movie that needs a tag."
                    onClick={() => void runMalPipeline(() => api.triggerCoverageTagSync(), "Coverage tag sync")}
                  >
                    Run coverage tag sync
                  </Button>
                </>
              ),
            },
          ] as const
        ).map((stage, idx) => (
          <div
            key={stage.step}
            className="relative min-w-0 animate-rise border-border py-7 max-lg:border-t max-lg:first:border-t-0 lg:border-l lg:px-8 lg:first:border-l-0 lg:first:pl-0"
            style={{ animationDelay: `${idx * 120}ms` }}
          >
            {idx < 2 ? (
              <span aria-hidden className="absolute top-11 -right-3 z-[1] hidden size-6 items-center justify-center bg-background lg:flex">
                <ArrowRight className="size-3.5 text-subtle-foreground" strokeWidth={2} />
              </span>
            ) : null}
            <p className="text-[13px] text-muted-foreground">{stage.step}</p>
            <div className="cond mt-2.5 text-[64px] leading-[0.9] font-[640] tabular-nums">{stage.value}</div>
            <p className="mt-2 text-sm text-muted-foreground">{stage.sub}</p>
            <div className="relative mt-5 h-0.5 overflow-hidden bg-border" aria-hidden>
              {malPipelineBusy ? (
                <span className="absolute inset-y-0 w-[30%] animate-flow bg-[linear-gradient(90deg,transparent,var(--signal),transparent)]" />
              ) : null}
            </div>
            <p className="mt-3 truncate font-mono text-[11px] text-subtle-foreground" title={stage.meta}>
              {stage.meta}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">{stage.actions}</div>
          </div>
        ))}
      </section>

      <section aria-labelledby="mal-batch" className="pt-10">
        <SectionHead id="mal-batch" title="Batch controls" aside="Applies to the ingest buttons above" />
        <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
          Each run fetches at most one batch of IDs (default from server: {malConfig.data?.mal_max_ids_per_run ?? "…"} per batch). MAL and
          Jikan requests are throttled per server settings ({malConfig.data ? `${malConfig.data.mal_min_request_interval_seconds}s` : "…"} /{" "}
          {malConfig.data ? `${malConfig.data.mal_jikan_min_request_interval_seconds}s` : "…"} Jikan). Large ingests can take a long time.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-4">
          <label className={fieldLabelClass}>
            IDs per batch
            <input
              type="number"
              min={1}
              max={500}
              className={fieldClass}
              value={malBatchSizeDraft}
              onChange={(event) => setMalBatchSizeDraft(event.target.value)}
              title="MAL_MAX_IDS_PER_RUN override for this action (1–500)"
            />
          </label>
          <label className={fieldLabelClass}>
            Backlog cycles
            <input
              type="number"
              min={1}
              max={200}
              className={fieldClass}
              value={malBacklogCycles}
              onChange={(event) => setMalBacklogCycles(Number(event.target.value || 10))}
              disabled={malImportAll}
            />
          </label>
          <label className={fieldLabelClass}>
            Delay between cycles (s)
            <input
              type="number"
              min={0}
              max={30}
              step={0.5}
              className={fieldClass}
              value={malCycleDelaySeconds}
              onChange={(event) => setMalCycleDelaySeconds(Number(event.target.value || 0))}
            />
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              className="size-[18px] accent-signal"
              checked={malImportAll}
              onChange={(event) => setMalImportAll(event.target.checked)}
            />
            Import all pending (auto cycles)
          </label>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              disabled={malPipelineBusy}
              onClick={() =>
                requestConfirm({
                  title: "Import all pending MAL fetches?",
                  description:
                    "This queues a background job that runs batch after batch until the queue is empty (or the cap is reached). Progress appears in Active work; you can close the tab.",
                  confirmLabel: "Import all",
                  onConfirm: () =>
                    void runMalPipeline(
                      () =>
                        api.triggerMalIngestBacklog({
                          import_all: true,
                          max_ids_per_run: malBatchSize,
                          cycle_delay_seconds: Math.max(1, Math.min(30, malCycleDelaySeconds)),
                          wait: false,
                        }),
                      "MAL import all pending (queued)",
                    ),
                })
              }
            >
              Import all pending
            </Button>
            <Button variant="outline" className="min-h-11" disabled={malPipelineBusy} onClick={() => void runAllMalPipelines()}>
              Run all MAL pipelines
            </Button>
          </div>
        </div>
        <details className="mt-5 border-t border-border">
          <summary className="flex min-h-11 cursor-pointer items-center text-[13px] text-muted-foreground hover:text-foreground">
            How matching works
          </summary>
          <p className="max-w-3xl pb-3 text-[13px] leading-relaxed text-muted-foreground">
            Links use TVDB/TMDB/IMDB when Jikan exposes them. If you have few externals, enable{" "}
            <strong className="text-foreground">allow title+year</strong> under Integrations → MyAnimeList, then run match refresh — the
            matcher uses main title, alternate titles (including Jikan variants), and year (±1 year) against your Sonarr/Radarr warehouse
            titles. Requires a MAL client ID in Integrations or <code className="font-mono text-xs">MAL_CLIENT_ID</code>.
          </p>
        </details>
        {malPipelineBusy ? (
          <p className="mt-4 text-[13px] text-signal">
            A MAL pipeline is running — large batches can take up to 30 minutes. Track progress in MAL pipeline status below instead of
            waiting here.
          </p>
        ) : null}
        {malPipelineResult ? (
          <div className="well mt-5 space-y-2 px-4 py-3.5">
            <p className="text-sm">{malPipelineResult.label}</p>
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
                <pre className="mt-2 max-h-52 overflow-auto font-mono text-[11px] text-foreground/90">
                  {JSON.stringify(Object.fromEntries(nestedResultEntries), null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </section>

      <WorkStatusPanel
        className="pt-12"
        title="MAL pipeline status"
        description="Ingest, matcher, and tag-sync runs from this page or the schedule. Large batches can take up to 30 minutes."
      />

      <div className="grid min-w-0 grid-cols-1 gap-x-14 gap-y-12 pt-14 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section aria-labelledby="mal-unmatched" className="min-w-0">
          <SectionHead
            id="mal-unmatched"
            title="Dubbed, but not matched"
            aside={`${(ov?.unmatched ?? []).length} titles${(ov?.unmatched ?? []).length >= 200 ? " (first 200)" : ""}`}
          />
          {overview.isError ? (
            <QueryErrorNotice label="MAL overview" retry={() => void overview.refetch()} error={overview.error} />
          ) : null}
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className={tableHeadRowClass}>
                  <th className={tableHeadCellClass}>Title on MyAnimeList</th>
                  <th className={tableHeadCellClass}>MAL ID</th>
                  <th className={tableHeadCellClass}>Type</th>
                  <th className={cn(tableHeadCellClass, "text-right")}>Eps</th>
                  <th className={tableHeadCellClass}>Fetch</th>
                </tr>
              </thead>
              <tbody>
                {(ov?.unmatched ?? []).map((row) => (
                  <tr key={row.mal_id} className={tableRowClass}>
                    <td className={cn(tableCellClass, "max-w-[260px] truncate")} title={row.main_title ?? undefined}>
                      {row.main_title ?? "—"}
                      {row.has_manual_link ? <span className="ml-2 text-xs text-subtle-foreground">manual link</span> : null}
                    </td>
                    <td className={cn(tableCellClass, "font-mono text-xs")}>
                      <a
                        href={`https://myanimelist.net/anime/${row.mal_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="border-b border-input text-muted-foreground hover:border-foreground hover:text-foreground"
                      >
                        {row.mal_id}
                      </a>
                    </td>
                    <td className={cn(tableCellClass, "text-muted-foreground")}>{row.media_type ?? "—"}</td>
                    <td className={cn(tableCellClass, "text-right tabular-nums")}>{row.num_episodes ?? "—"}</td>
                    <td className={cn(tableCellClass, "text-muted-foreground")}>{row.mal_fetch_status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!overview.isLoading && (ov?.unmatched ?? []).length === 0 ? (
              <p className="py-5 text-sm text-muted-foreground">Every dubbed MAL entry is linked to your library. Nothing to do here.</p>
            ) : null}
          </div>
          <p className="mt-3 text-[13px] text-subtle-foreground">Add the show or movie to Sonarr/Radarr, then run match refresh.</p>
        </section>

        <section aria-labelledby="mal-jobs" className="min-w-0">
          <SectionHead
            id="mal-jobs"
            title="Job history"
            aside={
              <label className="flex items-center gap-2 text-xs text-subtle-foreground">
                Type
                <select
                  className="min-h-10 rounded-sm border border-border bg-muted px-2.5 text-[13px] text-foreground"
                  value={jobTypeFilter}
                  onChange={(event) => setJobTypeFilter(event.target.value as JobTypeFilter)}
                  aria-label="Filter job runs by type"
                >
                  {JOB_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t === "all" ? "All jobs" : t.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </label>
            }
          />
          {jobRuns.isError ? <QueryErrorNotice label="MAL job runs" retry={() => void jobRuns.refetch()} error={jobRuns.error} /> : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className={tableHeadRowClass}>
                  <th className={tableHeadCellClass}>Started</th>
                  <th className={tableHeadCellClass}>Job</th>
                  <th className={tableHeadCellClass}>Result</th>
                  <th className={cn(tableHeadCellClass, "text-right")}>Took</th>
                </tr>
              </thead>
              <tbody>
                {(jobRuns.data ?? []).map((run) => {
                  const duration = runDurationSeconds(run);
                  return (
                    <tr key={run.id} className={tableRowClass}>
                      <td className={cn(tableCellClass, "font-mono text-xs whitespace-nowrap text-subtle-foreground")} title={fmtDate(run.started_at)}>
                        {dayOrClock(run.started_at)}
                      </td>
                      <td className={cn(tableCellClass, "whitespace-nowrap")}>{run.job_type.replace(/_/g, " ")}</td>
                      <td
                        className={cn(tableCellClass, "max-w-[260px] truncate text-xs text-muted-foreground")}
                        title={run.error_message ?? JSON.stringify(run.details)}
                      >
                        <StatusBadge status={run.status} className="mr-2 text-xs" />
                        {run.error_message ? <span className="text-critical">{run.error_message}</span> : detailsSummary(run.details)}
                      </td>
                      <td className={cn(tableCellClass, "text-right whitespace-nowrap tabular-nums")}>
                        {duration != null ? fmtDuration(duration) : run.status === "running" ? "…" : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!jobRuns.isLoading && (jobRuns.data ?? []).length === 0 ? (
              <p className="py-5 text-sm text-muted-foreground">No MAL job runs recorded yet.</p>
            ) : null}
          </div>
        </section>
      </div>

      <div className="mt-14 space-y-1.5 border-t border-border pt-5 text-xs text-subtle-foreground">
        <p>
          MAL data reset and stuck-state controls live under{" "}
          <Link to={`${PATHS.sync}?tab=manual`} className="border-b border-input text-muted-foreground hover:text-foreground">
            Sync &amp; Queue → Run by hand
          </Link>
          . Feature toggles and the client ID live under{" "}
          <Link to={PATHS.integrations} className="border-b border-input text-muted-foreground hover:text-foreground">
            Integrations → MyAnimeList
          </Link>
          .
        </p>
        <p>
          Dub-list data:{" "}
          <a href="https://github.com/MAL-Dubs/MAL-Dubs" target="_blank" rel="noreferrer" className="border-b border-input text-muted-foreground hover:text-foreground">
            MAL-Dubs
          </a>{" "}
          ·{" "}
          <a href="https://mydublist.com" target="_blank" rel="noreferrer" className="border-b border-input text-muted-foreground hover:text-foreground">
            MyDubList
          </a>{" "}
          by Joelis57 (
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer"
            className="border-b border-input text-muted-foreground hover:text-foreground"
          >
            CC BY 4.0
          </a>
          ).
        </p>
      </div>
      {confirmDialog}
    </div>
  );
}
