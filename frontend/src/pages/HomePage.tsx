import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { fmtSize } from "../hooks";
import { pollInterval, useServerEventsStatus } from "../hooks/useServerEvents";
import { queryKeys } from "../lib/queryKeys";
import { PATHS } from "../routes/paths";
import { ShellNotices } from "../layout/ShellNotices";
import { OnboardingChecklist } from "../components/nebula/OnboardingChecklist";
import { WorkStatusPanel } from "../components/nebula/WorkStatusPanel";
import { Fanart, Poster } from "@/components/ns/Artwork";
import { Figure, Figures, SectionHead, StatusDot } from "@/components/ns/Page";
import { actionLinkClass, fmtBigBytes } from "@/lib/ns";
import { SyncLanes } from "@/components/ns/SyncLanes";
import { dayOrClock, relTime } from "@/lib/time";
import type { RecentImport, RunTimeline, StatusResponse } from "@/types";
import { cn } from "@/lib/utils";

function importKind(row: RecentImport): "series" | "movie" {
  return row.kind === "movie" ? "movie" : "series";
}

function episodeCode(row: RecentImport): string | null {
  if (row.season_number == null || row.episode_number == null) return null;
  return `S${String(row.season_number).padStart(2, "0")}E${String(row.episode_number).padStart(2, "0")}`;
}

function importedAt(row: RecentImport): string {
  return row.date_added ?? row.seen_at;
}

function humanReason(code: string): string {
  return code.replace(/[_:]+/g, " ").replace(/\s+/g, " ").trim();
}

/** One plain-English sentence for the state of the system. */
function statusSentence(status: StatusResponse | undefined, timeline: RunTimeline | undefined): { lead: string; rest: string } {
  if (!status) return { lead: "Checking in with your servers…", rest: "" };
  const arrLanes = (timeline?.lanes ?? []).filter((lane) => lane.kind === "sonarr" || lane.kind === "radarr");
  const now = timeline ? new Date(timeline.now) : new Date();
  const lastOf = (kind: string): string | null => {
    const times = arrLanes
      .filter((lane) => lane.kind === kind)
      .map((lane) => (lane.events.length ? lane.events[lane.events.length - 1].at : lane.last_at))
      .filter((t): t is string => Boolean(t))
      .sort();
    return times.length ? times[times.length - 1] : null;
  };
  const failing = arrLanes.find((lane) => {
    const tail = lane.events.slice(-2);
    return tail.length === 2 && tail.every((e) => e.status === "failed");
  });
  const silent = arrLanes.find((lane) => {
    const last = lane.events.length ? lane.events[lane.events.length - 1].at : lane.last_at;
    return !last || now.getTime() - new Date(last).getTime() > 3 * 3_600_000;
  });
  const waiting = status.webhook_queue_open ?? 0;
  const dead = status.webhook_queue_dead_letter ?? 0;

  if (status.health_state === "critical" || failing) {
    if (failing) return { lead: `${failing.label} is failing.`, rest: "Its last syncs were refused — check the connection in Setup." };
    return { lead: "Something needs attention.", rest: status.health_reasons.map(humanReason).join(", ") + "." };
  }
  if (status.health_state === "warning" || silent || dead > 0) {
    if (silent) {
      const last = silent.events.length ? silent.events[silent.events.length - 1].at : silent.last_at;
      return {
        lead: `${silent.label} has been quiet${last ? ` since ${relTime(last, now)}` : ""}.`,
        rest: "Its schedule may be off, or the server unreachable.",
      };
    }
    if (dead > 0) return { lead: `${dead} webhook${dead === 1 ? "" : "s"} failed for good.`, rest: "Replay them from Sync & Queue." };
    return { lead: "Mostly in step.", rest: status.health_reasons.map(humanReason).join(", ") + "." };
  }
  const sonarr = lastOf("sonarr");
  const radarr = lastOf("radarr");
  const parts = [
    sonarr ? `Sonarr last synced ${relTime(sonarr, now)}` : null,
    radarr ? `Radarr ${relTime(radarr, now)}` : null,
  ].filter(Boolean);
  return {
    lead: "Everything is in step.",
    rest: `${parts.length ? `${parts.join(", ")}. ` : ""}${waiting} webhook${waiting === 1 ? "" : "s"} waiting, none failed.`,
  };
}

export function HomePage(): JSX.Element {
  usePageTitle("Overview");
  const { connected } = useServerEventsStatus();
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: api.status,
    refetchInterval: pollInterval(connected, 15_000, 60_000),
  });
  const healthz = useQuery({ queryKey: queryKeys.healthz, queryFn: api.healthz, staleTime: 300_000 });
  const imports = useQuery({
    queryKey: queryKeys.recentImports,
    queryFn: () => api.recentImports(24),
    refetchInterval: pollInterval(connected, 60_000, 120_000),
  });
  const timeline = useQuery({
    queryKey: queryKeys.runTimeline,
    queryFn: () => api.runTimeline(24),
    refetchInterval: pollInterval(connected, 30_000, 90_000),
  });
  const totals = useQuery({ queryKey: queryKeys.libraryTotals, queryFn: api.libraryTotals, staleTime: 60_000 });
  const automations = useQuery({ queryKey: queryKeys.automations, queryFn: api.automations, staleTime: 60_000 });
  const artwork = useQuery({ queryKey: queryKeys.artworkConfig, queryFn: api.artworkConfig, staleTime: 300_000 });
  const artOff = artwork.data?.enabled === false;

  const items = imports.data?.items ?? [];
  const latest = items[0];
  const shelf = items
    .filter((row, idx, all) => all.findIndex((r) => r.kind === row.kind && r.instance_name === row.instance_name && r.item_id === row.item_id) === idx)
    .slice(0, 8);
  const sentence = statusSentence(status.data, timeline.data);
  const rehearsing = (automations.data?.automations ?? []).filter((rule) => rule.enabled && rule.dry_run);
  const t = totals.data;
  const onDiskPct = t && t.episodes ? Math.round((t.episodes_on_disk / t.episodes) * 100) : null;

  return (
    <div className="pb-16">
      <section aria-labelledby="latest" className="relative isolate flex min-h-[600px] items-end overflow-hidden sm:min-h-[640px]">
        {latest ? (
          <Fanart
            kind={importKind(latest)}
            instanceName={latest.instance_name}
            itemId={latest.item_id}
            title={latest.title}
            disabled={artOff}
            eager
            className="-z-10"
          />
        ) : (
          <div aria-hidden className="absolute inset-0 -z-10 bg-well" />
        )}
        <div aria-hidden className="absolute inset-0 -z-10 scrim-bottom" />
        <div className="mx-auto w-full max-w-[1360px] px-4 pt-28 pb-10 sm:px-10">
          {latest ? (
            <>
              <p className="animate-rise text-sm text-foreground/80">
                Just arrived · {relTime(importedAt(latest))}
                {latest.kind === "episode" ? " · Sonarr" : " · Radarr"}
              </p>
              <h1
                id="latest"
                className="cond mt-3 animate-rise text-[clamp(64px,10vw,156px)] leading-[0.84] font-[760] [animation-delay:80ms]"
              >
                {latest.title}
              </h1>
              <div className="mt-5 flex animate-rise flex-wrap items-end justify-between gap-x-8 gap-y-2 [animation-delay:180ms]">
                <p className="flex flex-wrap gap-x-6 gap-y-1 text-lg">
                  {episodeCode(latest) ? (
                    <span>
                      {episodeCode(latest)}
                      {latest.episode_title ? <span className="text-foreground/75"> “{latest.episode_title}”</span> : null}
                    </span>
                  ) : latest.year ? (
                    <span>{latest.year}</span>
                  ) : null}
                  {latest.quality ? <span className="text-signal">{latest.quality}</span> : null}
                  {latest.video_codec ? <span className="text-foreground/75">{latest.video_codec}</span> : null}
                  {latest.size_bytes ? <span className="text-foreground/75">{fmtSize(latest.size_bytes)}</span> : null}
                </p>
                {latest.path ? (
                  <span className="max-w-full truncate font-mono text-[11px] text-foreground/55" title={latest.path}>
                    {latest.path}
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <h1 id="latest" className="cond animate-rise text-[clamp(72px,13vw,200px)] leading-[0.82] font-[780]">
                Nebularr
              </h1>
              <p className="mt-4 max-w-xl animate-rise text-lg text-muted-foreground [animation-delay:120ms]">
                {imports.isLoading
                  ? "Loading your library…"
                  : "Nothing imported yet. Connect Sonarr and Radarr and run a first sync to fill this page with your library."}
              </p>
            </>
          )}
        </div>
      </section>

      <div className="mx-auto w-full max-w-[1360px] px-4 sm:px-10">
        <div className="pt-4">
          <ShellNotices />
        </div>

        <section aria-labelledby="status-h" className="pt-6">
          <h2 id="status-h" className="sr-only">
            System status
          </h2>
          <p className="max-w-[60rem] text-[clamp(22px,2.4vw,32px)] leading-snug">
            <StatusDot state={status.data?.health_state} className="mr-3.5" />
            {sentence.lead} <span className="text-muted-foreground">{sentence.rest}</span>
          </p>
        </section>

        {shelf.length ? (
          <section aria-labelledby="shelf" className="pt-14">
            <SectionHead
              id="shelf"
              title="Arrived lately"
              aside={
                <Link to={PATHS.library} className={actionLinkClass}>
                  Open the library
                </Link>
              }
            />
            <ul className="grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-4 lg:grid-cols-8">
              {shelf.map((row, i) => (
                <li key={`${row.kind}-${row.instance_name}-${row.item_id}`} className="min-w-0">
                  <Link
                    to={PATHS.library}
                    className="group block transition-transform duration-300 hover:-translate-y-1.5"
                    aria-label={`${row.title}${episodeCode(row) ? ` ${episodeCode(row)}` : ""}, ${row.quality ?? ""}`}
                  >
                    <Poster
                      kind={importKind(row)}
                      instanceName={row.instance_name}
                      itemId={row.item_id}
                      title={row.title}
                      year={row.year}
                      disabled={artOff}
                      className="animate-rise shadow-[0_10px_24px_-16px_rgba(0,0,0,0.8)] transition-shadow group-hover:shadow-[0_24px_40px_-18px_rgba(0,0,0,0.95)]"
                    />
                    <span className="mt-2.5 block truncate text-[13px]" style={{ animationDelay: `${i * 60}ms` }}>
                      {episodeCode(row) ?? row.quality ?? row.title}
                    </span>
                    <span className="block text-xs text-subtle-foreground">{dayOrClock(importedAt(row))}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="lanes-h" className="pt-16">
          <SectionHead id="lanes-h" title="The last 24 hours" aside="short tick = incremental · tall = full · ring = failed" />
          <div className="well px-4 pt-2 pb-1 sm:px-7">
            {timeline.data ? (
              <SyncLanes timeline={timeline.data} size="sm" />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {timeline.isError ? "Could not load the run timeline." : "Loading the last 24 hours…"}
              </p>
            )}
          </div>
        </section>

        <section aria-label="Library totals" className="pt-14">
          <Figures>
            <Figure value={t ? t.shows.toLocaleString() : "—"} label="shows" />
            <Figure value={t ? t.episodes.toLocaleString() : "—"} label="episodes" style={{ animationDelay: "60ms" }} />
            <Figure value={onDiskPct != null ? `${onDiskPct}%` : "—"} label="episodes on disk" style={{ animationDelay: "120ms" }} />
            <Figure value={t ? t.movies.toLocaleString() : "—"} label="movies" style={{ animationDelay: "180ms" }} />
            <Figure
              value={t ? t.episodes_missing.toLocaleString() : "—"}
              label="episodes missing"
              tone={t && t.episodes_missing > 0 ? "warn" : undefined}
              style={{ animationDelay: "240ms" }}
            />
            <Figure value={t ? fmtBigBytes(t.stored_bytes) : "—"} label="stored" style={{ animationDelay: "300ms" }} />
          </Figures>
        </section>

        <div className="grid gap-12 pt-16 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <section aria-labelledby="waiting" className="panel self-start px-6 pt-5 pb-2 sm:px-7">
            <h2 id="waiting" className="cond mb-2 text-[30px] leading-none font-bold">
              Waiting on you
            </h2>
            {rehearsing.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between gap-5 border-t border-border py-4">
                <div className="min-w-0">
                  <p className="text-base">“{rule.name}” is rehearsing</p>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    {rule.last_run_matched != null
                      ? `Its last dry run matched ${rule.last_run_matched.toLocaleString()}. Nothing has been changed.`
                      : "It hasn’t run yet. Dry runs never change anything."}
                  </p>
                </div>
                <Link to={PATHS.automations} className={actionLinkClass}>
                  Review
                </Link>
              </div>
            ))}
            {(status.data?.webhook_queue_dead_letter ?? 0) > 0 ? (
              <div className="flex items-center justify-between gap-5 border-t border-border py-4">
                <div className="min-w-0">
                  <p className="text-base text-critical">{status.data?.webhook_queue_dead_letter} webhooks gave up</p>
                  <p className="mt-1 text-[13px] text-muted-foreground">They ran out of retries and were set aside.</p>
                </div>
                <Link to={`${PATHS.sync}?tab=webhooks`} className={actionLinkClass}>
                  Replay
                </Link>
              </div>
            ) : null}
            {t && t.episodes_missing > 0 ? (
              <div className="flex items-center justify-between gap-5 border-t border-border py-4">
                <div className="min-w-0">
                  <p className="text-base">{t.episodes_missing.toLocaleString()} monitored episodes are missing</p>
                  <p className="mt-1 text-[13px] text-muted-foreground">They have aired, and Sonarr is watching for them.</p>
                </div>
                <Link to={PATHS.library} className={actionLinkClass}>
                  Open library
                </Link>
              </div>
            ) : null}
            {!rehearsing.length && !(status.data?.webhook_queue_dead_letter ?? 0) && !(t && t.episodes_missing > 0) ? (
              <p className="border-t border-border py-4 text-[15px] text-muted-foreground">Nothing needs you right now.</p>
            ) : null}
          </section>
          <div className="min-w-0 space-y-10">
            <OnboardingChecklist />
            <WorkStatusPanel title="Running now" dense />
          </div>
        </div>

        <footer className="flex flex-wrap gap-x-7 gap-y-2 pt-16 font-mono text-[11px] text-subtle-foreground">
          <span>
            Nebularr {healthz.data?.version ?? "…"}
            {healthz.data?.git_sha ? ` · ${healthz.data.git_sha.slice(0, 7)}` : ""}
          </span>
          {status.data?.arr_versions.sonarr ? <span>Sonarr {status.data.arr_versions.sonarr}</span> : null}
          {status.data?.arr_versions.radarr ? <span>Radarr {status.data.arr_versions.radarr}</span> : null}
          <span className={cn(artwork.data?.mode === "live" && "text-warn")}>
            artwork {artOff ? "off" : artwork.data?.mode === "live" ? "live (not cached)" : "cached"}
          </span>
        </footer>
      </div>
    </div>
  );
}
