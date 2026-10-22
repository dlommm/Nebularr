import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { fmtDate, fmtSize, useDebouncedValue, useLocalStorageState } from "../hooks";
import { usePageTitle } from "../hooks/usePageTitle";
import { queryKeys } from "../lib/queryKeys";
import type { EpisodeRow, MovieRow, ShowRow } from "../types";
import { Pagination } from "../components/ui";
import { MediaCompareGrid, MediaDetailSheet } from "../components/nebula/MediaDetailSheet";
import { QueryErrorNotice } from "../components/nebula/QueryErrorNotice";
import { StatusBadge } from "../components/nebula/StatusBadge";
import { Fanart, Poster } from "@/components/ns/Artwork";
import { Figure, PageHead, SectionHead } from "@/components/ns/Page";
import { actionLinkClass } from "@/lib/ns";
import { QualityLegend, SeasonGrid } from "@/components/ns/SeasonGrid";
import { qualityTier } from "@/lib/quality";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { dayOrClock } from "@/lib/time";
import { cn } from "@/lib/utils";
import { SavedViews } from "../components/nebula/SavedViews";
import { clearSeasonOnShowSelect, serializeLibraryState } from "./libraryUrlState";
import type { LibraryFilters, LibraryMode } from "./libraryUrlState";

// Sort keys accepted by each backend endpoint (routers/library.py sort maps).
const SORT_OPTIONS: Record<LibraryMode, { value: string; label: string }[]> = {
  drilldown: [
    { value: "title", label: "Title" },
    { value: "last_seen_at", label: "Last seen" },
    { value: "episode_count", label: "Episode count" },
    { value: "season_count", label: "Season count" },
  ],
  "all-episodes": [
    { value: "series_title", label: "Series title" },
    { value: "air_date", label: "Air date" },
    { value: "size_bytes", label: "File size" },
    { value: "season_number", label: "Season" },
    { value: "episode_number", label: "Episode" },
  ],
  movies: [
    { value: "title", label: "Title" },
    { value: "year", label: "Year" },
    { value: "size_bytes", label: "File size" },
    { value: "last_seen_at", label: "Last seen" },
  ],
};

const EPISODE_SORT_OPTIONS = [
  { value: "season_number", label: "Season & episode" },
  { value: "air_date", label: "Air date" },
  { value: "size_bytes", label: "File size" },
  { value: "episode_title", label: "Episode title" },
];

export function LibraryPage(): JSX.Element {
  usePageTitle("Library");
  const [libraryMode, setLibraryMode] = useLocalStorageState<LibraryMode>("nebularr.library.mode", "drilldown");
  const [libraryFilters, setLibraryFilters] = useLocalStorageState<LibraryFilters>("nebularr.library.filters", {
    search: "",
    instance: "",
    limit: 50,
    offset: 0,
    sortBy: "title",
    sortDir: "asc",
    showSeason: null,
  });
  const [selectedShow, setSelectedShow] = useLocalStorageState<{ id: number; instance: string; title: string } | null>(
    "nebularr.library.selectedShow",
    null,
  );
  const [compareMode, setCompareMode] = useLocalStorageState<boolean>("nebularr.compare.mode", false);
  const [compareRows, setCompareRows] = useState<EpisodeRow[]>([]);
  const [detailDrawer, setDetailDrawer] = useState<Record<string, unknown> | null>(null);
  // The episodes table inside the drilldown pages independently from the shows list.
  const [episodesOffset, setEpisodesOffset] = useState(0);
  const [episodeSortBy, setEpisodeSortBy] = useState("season_number");
  const [searchParams, setSearchParams] = useSearchParams();
  const lastWrittenSearch = useRef<string | null>(null);

  // State → URL so the current view is always linkable (SavedViews/Copy link).
  useEffect(() => {
    const canonical = serializeLibraryState(libraryMode, libraryFilters, selectedShow).toString();
    if (canonical !== searchParams.toString()) {
      lastWrittenSearch.current = canonical;
      setSearchParams(new URLSearchParams(canonical), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryMode, libraryFilters, selectedShow]);

  // External URL change (deep link, saved view, back/forward) → state.
  useEffect(() => {
    const current = searchParams.toString();
    if (current === lastWrittenSearch.current || [...searchParams.keys()].length === 0) return;
    const mode = searchParams.get("mode");
    if (mode === "drilldown" || mode === "all-episodes" || mode === "movies") setLibraryMode(mode);
    else if (mode === null) setLibraryMode("drilldown");
    const show = searchParams.get("show");
    if (show) {
      const [idPart, instance, ...titleParts] = show.split("|");
      const id = Number(idPart);
      if (Number.isFinite(id) && instance) setSelectedShow({ id, instance, title: titleParts.join("|") });
    } else {
      setSelectedShow(null);
    }
    setLibraryFilters({
      search: searchParams.get("q") ?? "",
      instance: searchParams.get("inst") ?? "",
      limit: Number(searchParams.get("limit") ?? 50) || 50,
      offset: Number(searchParams.get("offset") ?? 0) || 0,
      sortBy: searchParams.get("sort") ?? "title",
      sortDir: searchParams.get("dir") === "desc" ? "desc" : "asc",
      showSeason: searchParams.get("season") != null ? Number(searchParams.get("season")) : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    setEpisodesOffset(0);
  }, [
    selectedShow?.id,
    selectedShow?.instance,
    libraryFilters.showSeason,
    libraryFilters.limit,
    episodeSortBy,
    libraryFilters.sortDir,
  ]);

  const debouncedSearch = useDebouncedValue(libraryFilters.search, 300);
  const debouncedInstance = useDebouncedValue(libraryFilters.instance, 300);

  const integrations = useQuery({ queryKey: ["integrations"], queryFn: api.integrations, staleTime: 60_000 });
  const instanceNames = useMemo(() => {
    const names = new Set<string>();
    (integrations.data ?? []).forEach((row) => names.add(row.name));
    if (libraryFilters.instance) names.add(libraryFilters.instance);
    return [...names].sort();
  }, [integrations.data, libraryFilters.instance]);

  const showsParams = {
    search: debouncedSearch,
    limit: libraryFilters.limit,
    offset: libraryFilters.offset,
    sort_by: libraryFilters.sortBy,
    sort_dir: libraryFilters.sortDir,
  };
  const shows = useQuery({
    queryKey: queryKeys.shows(showsParams),
    queryFn: () => api.shows(showsParams),
    enabled: libraryMode === "drilldown",
    placeholderData: keepPreviousData,
  });

  const showSeasons = useQuery({
    queryKey: ["show-seasons", selectedShow?.id, selectedShow?.instance],
    queryFn: () => api.showSeasons(selectedShow!.id, selectedShow!.instance),
    enabled: !!selectedShow && libraryMode === "drilldown",
  });

  const showEpisodesParams = {
    season_number: libraryFilters.showSeason,
    limit: libraryFilters.limit,
    offset: episodesOffset,
    sort_by: episodeSortBy,
    sort_dir: libraryFilters.sortDir,
  };
  const showEpisodes = useQuery({
    queryKey: queryKeys.showEpisodes(selectedShow?.id, selectedShow?.instance, showEpisodesParams),
    queryFn: () => api.showEpisodes(selectedShow!.id, selectedShow!.instance, showEpisodesParams),
    enabled: !!selectedShow && libraryMode === "drilldown",
    placeholderData: keepPreviousData,
  });

  const allEpisodesParams = {
    search: debouncedSearch,
    instance_name: debouncedInstance,
    limit: libraryFilters.limit,
    offset: libraryFilters.offset,
    sort_by: libraryFilters.sortBy,
    sort_dir: libraryFilters.sortDir,
  };
  const allEpisodes = useQuery({
    queryKey: queryKeys.allEpisodes(allEpisodesParams),
    queryFn: () => api.allEpisodes(allEpisodesParams),
    enabled: libraryMode === "all-episodes",
    placeholderData: keepPreviousData,
  });

  const moviesParams = {
    search: debouncedSearch,
    instance_name: debouncedInstance,
    limit: libraryFilters.limit,
    offset: libraryFilters.offset,
    sort_by: libraryFilters.sortBy,
    sort_dir: libraryFilters.sortDir,
  };
  const movies = useQuery({
    queryKey: queryKeys.movies(moviesParams),
    queryFn: () => api.movies(moviesParams),
    enabled: libraryMode === "movies",
    placeholderData: keepPreviousData,
  });

  const gridEpisodesParams = { season_number: null, limit: 2000, offset: 0, sort_by: "season_number", sort_dir: "asc" };
  const gridEpisodes = useQuery({
    queryKey: queryKeys.showEpisodes(selectedShow?.id, selectedShow?.instance, gridEpisodesParams),
    queryFn: () => api.showEpisodes(selectedShow!.id, selectedShow!.instance, gridEpisodesParams),
    enabled: !!selectedShow && libraryMode === "drilldown",
  });
  const totals = useQuery({ queryKey: queryKeys.libraryTotals, queryFn: api.libraryTotals, staleTime: 60_000 });
  const artwork = useQuery({ queryKey: queryKeys.artworkConfig, queryFn: api.artworkConfig, staleTime: 300_000 });
  const recent = useQuery({
    queryKey: queryKeys.recentImports,
    queryFn: () => api.recentImports(24),
    enabled: libraryMode === "movies",
    staleTime: 60_000,
  });
  const artOff = artwork.data?.enabled === false;
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<number | null>(null);
  useEffect(() => setSelectedEpisodeId(null), [selectedShow?.id, selectedShow?.instance]);

  const gridItems = gridEpisodes.data?.items ?? [];
  const selectedEpisode =
    gridItems.find((ep) => ep.episode_id === selectedEpisodeId) ??
    [...gridItems].reverse().find((ep) => ep.has_file) ??
    gridItems[0] ??
    null;
  const gridHave = gridItems.filter((ep) => ep.has_file).length;
  const newestMovie = (recent.data?.items ?? []).find((row) => row.kind === "movie");

  const toggleCompare = (row: EpisodeRow): void =>
    setCompareRows((existing) => {
      const has = existing.find((item) => item.episode_id === row.episode_id);
      if (has) return existing.filter((item) => item.episode_id !== row.episode_id);
      if (existing.length >= 2) return [existing[1], row];
      return [...existing, row];
    });

  const renderEpisodeTable = (rows: EpisodeRow[], showSeries: boolean): JSX.Element => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-rule-strong text-left text-xs text-subtle-foreground">
            {showSeries ? <th className="py-2.5 pr-4 font-medium">Series</th> : null}
            <th className="py-2.5 pr-4 font-medium">Episode</th>
            <th className="py-2.5 pr-4 font-medium">Title</th>
            <th className="py-2.5 pr-4 font-medium">Aired</th>
            <th className="py-2.5 pr-4 font-medium">Quality</th>
            <th className="py-2.5 pr-4 text-right font-medium">Size</th>
            <th className="py-2.5 pr-4 font-medium">Video / audio</th>
            <th className="py-2.5 pr-4 font-medium">Status</th>
            {compareMode ? <th className="py-2.5 font-medium">Compare</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.instance_name}-${row.episode_id}`}
              tabIndex={0}
              onClick={() => setDetailDrawer(row)}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  setDetailDrawer(row);
                }
              }}
              className="cursor-pointer border-b border-border transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            >
              {showSeries ? (
                <td className="py-3 pr-4">
                  {row.series_title} <span className="text-xs text-subtle-foreground">{row.instance_name}</span>
                </td>
              ) : null}
              <td className="py-3 pr-4 font-mono text-xs tabular-nums text-muted-foreground">
                S{String(row.season_number).padStart(2, "0")}E{String(row.episode_number).padStart(2, "0")}
              </td>
              <td className="max-w-[280px] truncate py-3 pr-4">{row.episode_title}</td>
              <td className="py-3 pr-4 text-muted-foreground">{fmtDate(row.air_date)}</td>
              <td className={cn("py-3 pr-4", qualityTier(row.has_file, row.quality) === "q4" && "text-signal")}>
                {row.has_file ? row.quality ?? "—" : <span className="text-warn">missing</span>}
              </td>
              <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">{fmtSize(row.size_bytes)}</td>
              <td className="py-3 pr-4 text-muted-foreground">
                {row.video_codec ?? "—"} / {row.audio_codec ?? "—"}
              </td>
              <td className="py-3 pr-4 text-muted-foreground">{row.has_file ? "on disk" : row.series_status ?? "—"}</td>
              {compareMode ? (
                <td className="py-3">
                  <button
                    type="button"
                    className="min-h-9 border-b border-input px-1 text-[13px] hover:border-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleCompare(row);
                    }}
                  >
                    {compareRows.find((item) => item.episode_id === row.episode_id) ? "Remove" : "Compare"}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const selectClass = "h-10 rounded-md border border-border bg-muted px-3 text-sm text-foreground";
  const t = totals.data;

  return (
    <>
      <div className="pb-16">
        <PageHead
          title="Library"
          aside={
            <div className="flex flex-wrap gap-x-9 gap-y-3">
              {libraryMode === "movies" ? (
                <>
                  <Figure size="md" value={t ? t.movies.toLocaleString() : "—"} label="movies" />
                  <Figure size="md" value={t ? t.movies_on_disk.toLocaleString() : "—"} label="on disk" />
                  <Figure size="md" value={t ? t.movies_missing.toLocaleString() : "—"} label="missing" tone={t && t.movies_missing ? "warn" : undefined} />
                </>
              ) : (
                <>
                  <Figure size="md" value={t ? t.shows.toLocaleString() : "—"} label="shows" />
                  <Figure size="md" value={t ? t.episodes.toLocaleString() : "—"} label="episodes" />
                  <Figure
                    size="md"
                    value={t && t.episodes ? `${Math.round((t.episodes_on_disk / t.episodes) * 100)}%` : "—"}
                    label="on disk"
                  />
                  <Figure size="md" value={t ? t.episodes_missing.toLocaleString() : "—"} label="missing" tone={t && t.episodes_missing ? "warn" : undefined} />
                </>
              )}
            </div>
          }
        />

        {compareMode && compareRows.length === 2 ? (
          <section aria-labelledby="compare-h" className="panel mb-8 px-6 py-5">
            <SectionHead id="compare-h" title="Compare" aside="Differing fields are highlighted." />
            <MediaCompareGrid
              a={compareRows[0] as unknown as Record<string, unknown>}
              b={compareRows[1] as unknown as Record<string, unknown>}
            />
          </section>
        ) : null}

        <Tabs
          value={libraryMode}
          onValueChange={(v) => {
            const mode = v as LibraryMode;
            setLibraryMode(mode);
            if (!SORT_OPTIONS[mode].some((option) => option.value === libraryFilters.sortBy)) {
              setLibraryFilters({ ...libraryFilters, sortBy: SORT_OPTIONS[mode][0].value, offset: 0 });
            }
          }}
          className="w-full gap-0"
        >
          <TabsList className="w-full">
            <TabsTrigger value="drilldown">TV shows</TabsTrigger>
            <TabsTrigger value="all-episodes">All episodes</TabsTrigger>
            <TabsTrigger value="movies">Movies</TabsTrigger>
          </TabsList>

          <div className="flex flex-wrap items-end gap-x-5 gap-y-3 py-5">
            <div className="grid min-w-[220px] flex-[1_1_280px] gap-1.5">
              <Label htmlFor="nebularr-library-search" className="text-xs font-normal text-subtle-foreground">
                Filter
              </Label>
              <Input
                id="nebularr-library-search"
                placeholder="Titles, paths, codecs…  ( / )"
                value={libraryFilters.search}
                onChange={(event) => setLibraryFilters({ ...libraryFilters, search: event.target.value, offset: 0 })}
              />
            </div>
            {libraryMode !== "drilldown" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="nebularr-library-instance" className="text-xs font-normal text-subtle-foreground">
                  Instance
                </Label>
                <select
                  id="nebularr-library-instance"
                  className={selectClass}
                  value={libraryFilters.instance}
                  onChange={(event) => setLibraryFilters({ ...libraryFilters, instance: event.target.value, offset: 0 })}
                >
                  <option value="">All instances</option>
                  {instanceNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="nebularr-library-sort" className="text-xs font-normal text-subtle-foreground">
                Sort by
              </Label>
              <div className="flex gap-2">
                <select
                  id="nebularr-library-sort"
                  className={selectClass}
                  value={libraryFilters.sortBy}
                  onChange={(event) => setLibraryFilters({ ...libraryFilters, sortBy: event.target.value, offset: 0 })}
                  aria-label="Sort by"
                >
                  {SORT_OPTIONS[libraryMode].map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Sort direction"
                  className={selectClass}
                  value={libraryFilters.sortDir}
                  onChange={(event) => setLibraryFilters({ ...libraryFilters, sortDir: event.target.value as "asc" | "desc" })}
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
                <select
                  aria-label="Rows per page"
                  className={selectClass}
                  value={libraryFilters.limit}
                  onChange={(event) => setLibraryFilters({ ...libraryFilters, limit: Number(event.target.value), offset: 0 })}
                >
                  <option value={25}>25 / page</option>
                  <option value={50}>50 / page</option>
                  <option value={100}>100 / page</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="inline-flex min-h-10 items-center gap-2 text-sm text-muted-foreground">
                <Checkbox id="lib-compare" checked={compareMode} onCheckedChange={(c) => setCompareMode(c === true)} />
                Compare
              </label>
              <SavedViews storageKey="nebularr.savedViews.library" />
              <Button
                type="button"
                variant="outline"
                disabled={libraryMode === "drilldown" && !selectedShow}
                title={libraryMode === "drilldown" && !selectedShow ? "Select a show to export its episodes" : undefined}
                onClick={() => {
                  if (libraryMode === "drilldown" && !selectedShow) return;
                  const url = api.exportUrl(
                    libraryMode === "movies"
                      ? "/api/ui/movies/export.csv"
                      : libraryMode === "all-episodes"
                        ? "/api/ui/episodes/export.csv"
                        : `/api/ui/shows/${selectedShow?.id ?? 0}/episodes/export.csv`,
                    {
                      search: libraryFilters.search,
                      instance_name: libraryMode === "drilldown" ? selectedShow?.instance : libraryFilters.instance,
                      season_number: libraryFilters.showSeason ?? undefined,
                      // The episodes table (drilldown) sorts independently of the
                      // shows-list sort, so its export must match what's on screen.
                      sort_by: libraryMode === "drilldown" ? episodeSortBy : libraryFilters.sortBy,
                      sort_dir: libraryFilters.sortDir,
                    },
                  );
                  window.location.href = url;
                }}
              >
                Export CSV
              </Button>
            </div>
          </div>

          <TabsContent value="drilldown">
            {shows.isError ? (
              <QueryErrorNotice label="shows" retry={() => void shows.refetch()} error={shows.error} />
            ) : shows.isLoading ? (
              <p className="border-t border-border py-6 text-sm text-muted-foreground">Loading…</p>
            ) : (shows.data?.items.length ?? 0) === 0 ? (
              <p className="border-t border-border py-6 text-sm text-muted-foreground">No shows match current filters.</p>
            ) : (
              <ul aria-label="Shows">
                {(shows.data?.items ?? []).map((row: ShowRow) => {
                  const selected = selectedShow?.id === row.series_id && selectedShow?.instance === row.instance_name;
                  return (
                    <li key={`${row.instance_name}-${row.series_id}`}>
                      <button
                        type="button"
                        aria-expanded={selected}
                        onClick={() => {
                          if (selected) {
                            setSelectedShow(null);
                            return;
                          }
                          setSelectedShow({ id: row.series_id, instance: row.instance_name, title: row.title });
                          setLibraryFilters(clearSeasonOnShowSelect(libraryFilters));
                        }}
                        className={cn(
                          "group grid w-full grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-x-5 border-t border-border py-2.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none sm:grid-cols-[48px_minmax(0,1fr)_110px_110px_120px]",
                          selected && "bg-muted",
                        )}
                      >
                        <Poster
                          kind="series"
                          instanceName={row.instance_name}
                          itemId={row.series_id}
                          title={row.title}
                          size={250}
                          disabled={artOff}
                          className="w-12 shadow-[0_6px_14px_-8px_rgba(0,0,0,0.9)] transition-transform group-hover:scale-105"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-base">{row.title}</span>
                          <span className="mt-0.5 flex items-center gap-3 text-xs text-subtle-foreground">
                            <span>{row.instance_name}</span>
                            <StatusBadge status={row.status} className="text-xs" />
                          </span>
                        </span>
                        <span className="hidden text-sm text-muted-foreground sm:block">{row.season_count} seasons</span>
                        <span className="text-right text-sm text-muted-foreground sm:text-left">{row.episode_count} episodes</span>
                        <span className="hidden text-right font-mono text-xs text-subtle-foreground sm:block">{fmtDate(row.last_seen_at)}</span>
                      </button>
                      {selected ? (
                        <section aria-label={`${row.title} episodes`} className="-mx-4 animate-rise overflow-hidden border-t border-border sm:-mx-10">
                          <div className="relative isolate h-[300px] sm:h-[340px]">
                            <Fanart kind="series" instanceName={row.instance_name} itemId={row.series_id} title={row.title} disabled={artOff} className="-z-10" />
                            <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-transparent from-30% to-card to-95%" />
                            <div className="absolute inset-x-4 bottom-6 flex flex-wrap items-end justify-between gap-4 sm:inset-x-10">
                              <div className="min-w-0">
                                <h2 className="cond text-[clamp(48px,7vw,88px)] leading-[0.84] font-[760]">{row.title}</h2>
                                <p className="mt-3 text-sm text-foreground/80">
                                  {row.season_count} seasons · {row.status} · {row.instance_name}
                                  {row.path ? <span className="ml-2 font-mono text-xs">{row.path}</span> : null}
                                </p>
                              </div>
                              <p className="text-sm text-foreground/80">
                                <span className="cond text-[34px] font-[640] text-foreground">{gridHave}</span> of {gridItems.length || row.episode_count} on disk
                              </p>
                            </div>
                          </div>
                          <div className="bg-card px-4 pt-6 pb-8 sm:px-10">
                            {gridEpisodes.isError ? (
                              <QueryErrorNotice label="episodes" retry={() => void gridEpisodes.refetch()} error={gridEpisodes.error} />
                            ) : gridEpisodes.isLoading ? (
                              <p className="text-sm text-muted-foreground">Loading episodes…</p>
                            ) : (
                              <div className="grid gap-10 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                                <div className="min-w-0">
                                  <SeasonGrid episodes={gridItems} selectedId={selectedEpisode?.episode_id} onSelect={(ep) => setSelectedEpisodeId(ep.episode_id)} />
                                  <QualityLegend className="mt-5" />
                                </div>
                                {selectedEpisode ? (
                                  <div className="min-w-0 lg:border-l lg:border-border lg:pl-8">
                                    <p className="text-[13px] text-subtle-foreground">Selected episode</p>
                                    <h3 className="mt-1.5 mb-4 text-xl font-medium">
                                      S{String(selectedEpisode.season_number).padStart(2, "0")}E{String(selectedEpisode.episode_number).padStart(2, "0")}
                                      {selectedEpisode.episode_title ? ` · ${selectedEpisode.episode_title}` : ""}
                                    </h3>
                                    <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                                      <dt className="text-subtle-foreground">Quality</dt>
                                      <dd className={selectedEpisode.has_file ? "text-signal" : "text-warn"}>
                                        {selectedEpisode.has_file ? selectedEpisode.quality ?? "on disk" : "missing"}
                                      </dd>
                                      <dt className="text-subtle-foreground">Aired</dt>
                                      <dd>{fmtDate(selectedEpisode.air_date)}</dd>
                                      {selectedEpisode.has_file ? (
                                        <>
                                          <dt className="text-subtle-foreground">Video</dt>
                                          <dd>
                                            {selectedEpisode.video_codec ?? "—"}
                                            {selectedEpisode.video_dynamic_range ? ` · ${selectedEpisode.video_dynamic_range}` : ""}
                                          </dd>
                                          <dt className="text-subtle-foreground">Audio</dt>
                                          <dd>
                                            {selectedEpisode.audio_codec ?? "—"}
                                            {selectedEpisode.audio_channels ? ` ${selectedEpisode.audio_channels}` : ""}
                                            {selectedEpisode.audio_languages?.length ? ` · ${selectedEpisode.audio_languages.join(", ")}` : ""}
                                          </dd>
                                          <dt className="text-subtle-foreground">Subtitles</dt>
                                          <dd>{selectedEpisode.subtitle_languages?.length ? selectedEpisode.subtitle_languages.join(", ") : "—"}</dd>
                                          <dt className="text-subtle-foreground">Size</dt>
                                          <dd>{fmtSize(selectedEpisode.size_bytes)}</dd>
                                          <dt className="text-subtle-foreground">File</dt>
                                          <dd className="font-mono text-xs break-all text-muted-foreground">
                                            {selectedEpisode.relative_path ?? selectedEpisode.file_path ?? "—"}
                                          </dd>
                                        </>
                                      ) : null}
                                    </dl>
                                    <button type="button" className={cn(actionLinkClass, "mt-4")} onClick={() => setDetailDrawer(selectedEpisode)}>
                                      Every detail
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            )}

                            <div className="mt-10">
                              <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
                                <h3 className="cond text-[22px] font-bold">Episode list</h3>
                                <div className="flex flex-wrap gap-2">
                                  <select
                                    className={selectClass}
                                    value={libraryFilters.showSeason ?? "all"}
                                    onChange={(event) =>
                                      setLibraryFilters({
                                        ...libraryFilters,
                                        showSeason: event.target.value === "all" ? null : Number(event.target.value),
                                      })
                                    }
                                    aria-label="Season"
                                  >
                                    <option value="all">All seasons</option>
                                    {(showSeasons.data ?? []).map((entry) => (
                                      <option key={entry.season_number} value={entry.season_number}>
                                        Season {entry.season_number}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    className={selectClass}
                                    value={episodeSortBy}
                                    onChange={(event) => setEpisodeSortBy(event.target.value)}
                                    aria-label="Sort episodes by"
                                  >
                                    {EPISODE_SORT_OPTIONS.map((option) => (
                                      <option key={option.value} value={option.value}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </div>
                              {showEpisodes.isError ? (
                                <QueryErrorNotice label="episodes" retry={() => void showEpisodes.refetch()} error={showEpisodes.error} />
                              ) : null}
                              {renderEpisodeTable(showEpisodes.data?.items ?? [], false)}
                              {showEpisodes.isLoading ? <p className="pt-3 text-xs text-muted-foreground">Loading episodes…</p> : null}
                              <Pagination
                                total={showEpisodes.data?.total ?? 0}
                                offset={episodesOffset}
                                limit={libraryFilters.limit}
                                onChange={setEpisodesOffset}
                              />
                            </div>
                          </div>
                        </section>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <Pagination
              total={shows.data?.total ?? 0}
              offset={libraryFilters.offset}
              limit={libraryFilters.limit}
              onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
            />
          </TabsContent>

          <TabsContent value="all-episodes">
            {allEpisodes.isError ? (
              <QueryErrorNotice label="episodes" retry={() => void allEpisodes.refetch()} error={allEpisodes.error} />
            ) : allEpisodes.isLoading ? (
              <p className="border-t border-border py-6 text-sm text-muted-foreground">Loading…</p>
            ) : (allEpisodes.data?.items.length ?? 0) === 0 ? (
              <p className="border-t border-border py-6 text-sm text-muted-foreground">No episodes match current filters.</p>
            ) : (
              renderEpisodeTable(allEpisodes.data?.items ?? [], true)
            )}
            <Pagination
              total={allEpisodes.data?.total ?? 0}
              offset={libraryFilters.offset}
              limit={libraryFilters.limit}
              onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
            />
          </TabsContent>

          <TabsContent value="movies">
            {newestMovie && libraryFilters.offset === 0 && !libraryFilters.search ? (
              <section
                className="relative isolate mb-8 block h-[260px] overflow-hidden rounded-[3px] sm:h-[300px]"
                aria-label={`Newest movie: ${newestMovie.title}`}
              >
                <Fanart kind="movie" instanceName={newestMovie.instance_name} itemId={newestMovie.item_id} title={newestMovie.title} disabled={artOff} className="-z-10" />
                <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-r from-background/95 via-background/55 to-transparent" />
                <div className="absolute bottom-7 left-6 max-w-xl sm:left-8">
                  <p className="text-[13px] text-foreground/80">Newest · {dayOrClock(newestMovie.date_added ?? newestMovie.seen_at)}</p>
                  <h2 className="cond mt-2 text-[clamp(44px,6vw,72px)] leading-[0.84] font-[760]">{newestMovie.title}</h2>
                  <p className="mt-3 text-[15px] text-foreground/80">
                    {[newestMovie.year, newestMovie.quality, newestMovie.video_codec, newestMovie.size_bytes ? fmtSize(newestMovie.size_bytes) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </section>
            ) : null}
            {movies.isError ? (
              <QueryErrorNotice label="movies" retry={() => void movies.refetch()} error={movies.error} />
            ) : movies.isLoading ? (
              <p className="border-t border-border py-6 text-sm text-muted-foreground">Loading…</p>
            ) : (movies.data?.items.length ?? 0) === 0 ? (
              <p className="border-t border-border py-6 text-sm text-muted-foreground">No movies match current filters.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-4 lg:grid-cols-6" aria-label="Movies">
                {(movies.data?.items ?? []).map((row: MovieRow, i) => (
                  <li key={`${row.instance_name}-${row.movie_id}`} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => setDetailDrawer(row)}
                      className="group block w-full text-left transition-transform duration-300 hover:-translate-y-1.5 focus-visible:outline-none"
                    >
                      <span className="relative block">
                        <Poster
                          kind="movie"
                          instanceName={row.instance_name}
                          itemId={row.movie_id}
                          title={row.title}
                          year={row.year}
                          disabled={artOff}
                          className="animate-rise shadow-[0_10px_24px_-16px_rgba(0,0,0,0.8)] transition-shadow group-hover:shadow-[0_24px_40px_-18px_rgba(0,0,0,0.95)] group-focus-visible:ring-2 group-focus-visible:ring-ring"
                        />
                        {row.quality ? (
                          <span className="absolute top-2 right-2 rounded-sm bg-background/75 px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur" style={{ animationDelay: `${i * 30}ms` }}>
                            {qualityBadge(row.quality)}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-2.5 block truncate text-sm">{row.title}</span>
                      <span className="block text-xs text-subtle-foreground">
                        {row.file_path ? `${row.quality ?? "on disk"} · ${fmtSize(row.size_bytes)}` : <span className="text-warn">missing</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Pagination
              total={movies.data?.total ?? 0}
              offset={libraryFilters.offset}
              limit={libraryFilters.limit}
              onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
            />
          </TabsContent>
        </Tabs>
      </div>

      {detailDrawer ? <MediaDetailSheet row={detailDrawer} onClose={() => setDetailDrawer(null)} /> : null}
    </>
  );
}

function qualityBadge(quality: string): string {
  const q = quality.toLowerCase();
  if (q.includes("2160") || q.includes("4k")) return "4K";
  if (q.includes("1080")) return "HD";
  if (q.includes("720")) return "720";
  return "SD";
}
