import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { fmtDate, fmtSize, useDebouncedValue, useLocalStorageState } from "../hooks";
import { usePageTitle } from "../hooks/usePageTitle";
import type { EpisodeRow, MovieRow, ShowRow } from "../types";
import { Pagination } from "../components/ui";
import { GlassCard, CardContent, CardHeader, CardTitle } from "../components/nebula/GlassCard";
import { MediaCompareGrid, MediaDetailSheet } from "../components/nebula/MediaDetailSheet";
import { QueryErrorNotice } from "../components/nebula/QueryErrorNotice";
import { StatusBadge } from "../components/nebula/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Clapperboard, Film, ListVideo } from "lucide-react";
import { cn } from "@/lib/utils";
import { SavedViews } from "../components/nebula/SavedViews";
import { serializeLibraryState } from "./libraryUrlState";
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

  const shows = useQuery({
    queryKey: ["shows", debouncedSearch, libraryFilters.limit, libraryFilters.offset, libraryFilters.sortBy, libraryFilters.sortDir],
    queryFn: () =>
      api.shows({
        search: debouncedSearch,
        limit: libraryFilters.limit,
        offset: libraryFilters.offset,
        sort_by: libraryFilters.sortBy,
        sort_dir: libraryFilters.sortDir,
      }),
    enabled: libraryMode === "drilldown",
  });

  const showSeasons = useQuery({
    queryKey: ["show-seasons", selectedShow?.id, selectedShow?.instance],
    queryFn: () => api.showSeasons(selectedShow!.id, selectedShow!.instance),
    enabled: !!selectedShow && libraryMode === "drilldown",
  });

  const showEpisodes = useQuery({
    queryKey: [
      "show-episodes",
      selectedShow?.id,
      selectedShow?.instance,
      libraryFilters.showSeason,
      libraryFilters.limit,
      episodesOffset,
      episodeSortBy,
      libraryFilters.sortDir,
    ],
    queryFn: () =>
      api.showEpisodes(selectedShow!.id, selectedShow!.instance, {
        season_number: libraryFilters.showSeason,
        limit: libraryFilters.limit,
        offset: episodesOffset,
        sort_by: episodeSortBy,
        sort_dir: libraryFilters.sortDir,
      }),
    enabled: !!selectedShow && libraryMode === "drilldown",
  });

  const allEpisodes = useQuery({
    queryKey: [
      "all-episodes",
      debouncedSearch,
      debouncedInstance,
      libraryFilters.limit,
      libraryFilters.offset,
      libraryFilters.sortBy,
      libraryFilters.sortDir,
    ],
    queryFn: () =>
      api.allEpisodes({
        search: debouncedSearch,
        instance_name: debouncedInstance,
        limit: libraryFilters.limit,
        offset: libraryFilters.offset,
        sort_by: libraryFilters.sortBy,
        sort_dir: libraryFilters.sortDir,
      }),
    enabled: libraryMode === "all-episodes",
  });

  const movies = useQuery({
    queryKey: [
      "movies",
      debouncedSearch,
      debouncedInstance,
      libraryFilters.limit,
      libraryFilters.offset,
      libraryFilters.sortBy,
      libraryFilters.sortDir,
    ],
    queryFn: () =>
      api.movies({
        search: debouncedSearch,
        instance_name: debouncedInstance,
        limit: libraryFilters.limit,
        offset: libraryFilters.offset,
        sort_by: libraryFilters.sortBy,
        sort_dir: libraryFilters.sortDir,
      }),
    enabled: libraryMode === "movies",
  });

  const renderLibraryRows = (rows: EpisodeRow[]) =>
    rows.map((row) => (
      <tr
        key={row.episode_id}
        tabIndex={0}
        onClick={() => setDetailDrawer(row)}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            setDetailDrawer(row);
          }
        }}
        className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <td className="p-2">{row.series_title}</td>
        <td className="p-2">{row.instance_name}</td>
        <td className="p-2 tabular-nums">{row.season_number}</td>
        <td className="p-2 tabular-nums">{row.episode_number}</td>
        <td className="p-2">{row.episode_title}</td>
        <td className="p-2">{fmtDate(row.air_date)}</td>
        <td className="p-2 tabular-nums">{fmtSize(row.size_bytes)}</td>
        <td className="p-2">{row.video_codec ?? "-"}</td>
        <td className="p-2">{row.audio_codec ?? "-"}</td>
        <td className="p-2">{row.has_file ? "downloaded" : row.series_status ?? "-"}</td>
        {compareMode ? (
          <td className="p-2">
            <button
              type="button"
              className="rounded-md border border-border bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:bg-secondary/80"
              onClick={(event) => {
                event.stopPropagation();
                setCompareRows((existing) => {
                  const has = existing.find((item) => item.episode_id === row.episode_id);
                  if (has) return existing.filter((item) => item.episode_id !== row.episode_id);
                  if (existing.length >= 2) return [existing[1], row];
                  return [...existing, row];
                });
              }}
            >
              {compareRows.find((item) => item.episode_id === row.episode_id) ? "Remove" : "Compare"}
            </button>
          </td>
        ) : null}
      </tr>
    ));

  const compareSummary =
    compareMode && compareRows.length === 2 ? (
      <GlassCard>
        <CardHeader>
          <CardTitle className="text-base">Compare mode</CardTitle>
          <p className="text-xs text-muted-foreground">Differing fields are highlighted.</p>
        </CardHeader>
        <CardContent>
          <MediaCompareGrid
            a={compareRows[0] as unknown as Record<string, unknown>}
            b={compareRows[1] as unknown as Record<string, unknown>}
          />
        </CardContent>
      </GlassCard>
    ) : null;

  return (
    <>
      <div className="space-y-6">
        {compareSummary}

        <Tabs
          value={libraryMode}
          onValueChange={(v) => {
            const mode = v as LibraryMode;
            setLibraryMode(mode);
            if (!SORT_OPTIONS[mode].some((option) => option.value === libraryFilters.sortBy)) {
              setLibraryFilters({ ...libraryFilters, sortBy: SORT_OPTIONS[mode][0].value, offset: 0 });
            }
          }}
          className="w-full"
        >
          <GlassCard>
            <CardHeader className="space-y-4 pb-4">
              <div className="flex w-full min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <TabsList className="grid h-auto w-full min-w-0 min-h-9 max-w-full grid-cols-3 gap-0.5 sm:max-w-xl">
                  <TabsTrigger value="drilldown" className="min-w-0 gap-1.5">
                    <Clapperboard className="size-3.5" aria-hidden />
                    <span className="hidden sm:inline">TV shows</span>
                  </TabsTrigger>
                  <TabsTrigger value="all-episodes" className="min-w-0 gap-1.5">
                    <ListVideo className="size-3.5" aria-hidden />
                    <span className="hidden sm:inline">All eps</span>
                  </TabsTrigger>
                  <TabsTrigger value="movies" className="min-w-0 gap-1.5">
                    <Film className="size-3.5" aria-hidden />
                    <span className="hidden sm:inline">Movies</span>
                  </TabsTrigger>
                </TabsList>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                  <SavedViews storageKey="nebularr.savedViews.library" />
                  <div className="flex shrink-0 items-center gap-2">
                    <Checkbox
                      id="lib-compare"
                      checked={compareMode}
                      onCheckedChange={(c) => setCompareMode(c === true)}
                    />
                    <Label htmlFor="lib-compare" className="text-sm text-muted-foreground">
                      Compare
                    </Label>
                  </div>
                  <Label className="text-xs text-muted-foreground">Sort by</Label>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
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
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
                <div className="grid w-full gap-2 sm:max-w-xs sm:flex-1">
                  <Label htmlFor="nebularr-library-search" className="text-xs text-muted-foreground">
                    Search
                  </Label>
                  <Input
                    id="nebularr-library-search"
                    placeholder="Titles, paths, metadata…"
                    value={libraryFilters.search}
                    onChange={(event) => setLibraryFilters({ ...libraryFilters, search: event.target.value, offset: 0 })}
                    className="h-9"
                  />
                </div>
                <div className="grid w-full gap-2 sm:max-w-[200px]">
                  <Label htmlFor="nebularr-library-instance" className="text-xs text-muted-foreground">
                    Instance
                  </Label>
                  <select
                    id="nebularr-library-instance"
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
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
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label="Sort direction"
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                    value={libraryFilters.sortDir}
                    onChange={(event) => setLibraryFilters({ ...libraryFilters, sortDir: event.target.value as "asc" | "desc" })}
                  >
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                  <select
                    aria-label="Rows per page"
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                    value={libraryFilters.limit}
                    onChange={(event) => setLibraryFilters({ ...libraryFilters, limit: Number(event.target.value), offset: 0 })}
                  >
                    <option value={25}>25 / page</option>
                    <option value={50}>50 / page</option>
                    <option value={100}>100 / page</option>
                  </select>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={libraryMode === "drilldown" && !selectedShow}
                    title={
                      libraryMode === "drilldown" && !selectedShow
                        ? "Select a show to export its episodes"
                        : undefined
                    }
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
                          sort_by: libraryFilters.sortBy,
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
            </CardHeader>
          </GlassCard>

          <TabsContent value="drilldown" className="mt-4 space-y-4">
            <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="min-w-0 space-y-3 lg:col-span-5">
                <h3 className="text-sm font-medium text-muted-foreground">Shows</h3>
                {shows.isError ? (
                  <QueryErrorNotice label="shows" retry={() => void shows.refetch()} error={shows.error} />
                ) : shows.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : (shows.data?.items.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No shows match current filters.</p>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {(shows.data?.items ?? []).map((row: ShowRow) => {
                      const selected =
                        selectedShow?.id === row.series_id && selectedShow?.instance === row.instance_name;
                      return (
                        <button
                          type="button"
                          key={`${row.instance_name}-${row.series_id}`}
                          onClick={() => setSelectedShow({ id: row.series_id, instance: row.instance_name, title: row.title })}
                          className={cn(
                            "w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl",
                          )}
                        >
                          <GlassCard
                            className={cn(
                              "h-full p-0 transition-colors",
                              selected ? "border-primary/50 ring-2 ring-primary/40" : "hover:border-primary/30",
                            )}
                            size="sm"
                          >
                            <CardHeader className="p-3 pb-2">
                              <CardTitle className="line-clamp-2 text-sm font-semibold leading-snug">{row.title}</CardTitle>
                              <p className="text-[11px] text-muted-foreground">{row.instance_name}</p>
                            </CardHeader>
                            <CardContent className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-0">
                              <StatusBadge status={row.status} className="text-[0.6rem]" />
                              <span className="text-xs text-muted-foreground">
                                {row.episode_count} ep · {row.season_count} szn
                              </span>
                            </CardContent>
                          </GlassCard>
                        </button>
                      );
                    })}
                  </div>
                )}
                <Pagination
                  total={shows.data?.total ?? 0}
                  offset={libraryFilters.offset}
                  limit={libraryFilters.limit}
                  onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
                />
              </div>
              <GlassCard className="min-w-0 lg:col-span-7">
                <CardHeader>
                  <CardTitle className="text-base">Episodes{selectedShow ? ` — ${selectedShow.title}` : ""}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <select
                      className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-2 text-sm sm:w-auto"
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
                      className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-2 text-sm sm:w-auto"
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
                  {showEpisodes.isError ? (
                    <QueryErrorNotice label="episodes" retry={() => void showEpisodes.refetch()} error={showEpisodes.error} />
                  ) : null}
                  <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                          <th className="p-2 font-medium">Series</th>
                          <th className="p-2 font-medium">Instance</th>
                          <th className="p-2 font-medium">S</th>
                          <th className="p-2 font-medium">E</th>
                          <th className="p-2 font-medium">Title</th>
                          <th className="p-2 font-medium">Air</th>
                          <th className="p-2 font-medium">Size</th>
                          <th className="p-2 font-medium">Video</th>
                          <th className="p-2 font-medium">Audio</th>
                          <th className="p-2 font-medium">Status</th>
                          {compareMode ? <th className="p-2 font-medium">Cmp</th> : null}
                        </tr>
                      </thead>
                      <tbody>{renderLibraryRows(showEpisodes.data?.items ?? [])}</tbody>
                    </table>
                  </div>
                  {showEpisodes.isLoading ? <p className="text-xs text-muted-foreground">Loading episodes…</p> : null}
                  <Pagination
                    total={showEpisodes.data?.total ?? 0}
                    offset={episodesOffset}
                    limit={libraryFilters.limit}
                    onChange={setEpisodesOffset}
                  />
                </CardContent>
              </GlassCard>
            </div>
          </TabsContent>

          <TabsContent value="all-episodes" className="mt-4">
            <GlassCard>
              <CardHeader>
                <CardTitle className="text-base">All episodes</CardTitle>
              </CardHeader>
              <CardContent>
                {allEpisodes.isError ? (
                  <QueryErrorNotice label="episodes" retry={() => void allEpisodes.refetch()} error={allEpisodes.error} />
                ) : null}
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full min-w-[900px] text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                        <th className="p-2 font-medium">Series</th>
                        <th className="p-2 font-medium">Instance</th>
                        <th className="p-2 font-medium">S</th>
                        <th className="p-2 font-medium">E</th>
                        <th className="p-2 font-medium">Title</th>
                        <th className="p-2 font-medium">Air</th>
                        <th className="p-2 font-medium">Size</th>
                        <th className="p-2 font-medium">Video</th>
                        <th className="p-2 font-medium">Audio</th>
                        <th className="p-2 font-medium">Status</th>
                        {compareMode ? <th className="p-2 font-medium">Cmp</th> : null}
                      </tr>
                    </thead>
                    <tbody>{renderLibraryRows(allEpisodes.data?.items ?? [])}</tbody>
                  </table>
                </div>
                {allEpisodes.isLoading ? <p className="mt-2 text-xs text-muted-foreground">Loading…</p> : null}
                <Pagination
                  total={allEpisodes.data?.total ?? 0}
                  offset={libraryFilters.offset}
                  limit={libraryFilters.limit}
                  onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
                />
              </CardContent>
            </GlassCard>
          </TabsContent>

          <TabsContent value="movies" className="mt-4 space-y-4">
            {movies.isError ? (
              <QueryErrorNotice label="movies" retry={() => void movies.refetch()} error={movies.error} />
            ) : movies.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (movies.data?.items.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No movies match current filters.</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {(movies.data?.items ?? []).map((row: MovieRow) => (
                  <button
                    type="button"
                    key={`${row.instance_name}-${row.movie_id}`}
                    onClick={() => setDetailDrawer(row)}
                    className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
                  >
                    <GlassCard className="h-full transition-colors hover:border-primary/30" size="sm">
                      <CardHeader className="p-3 pb-1">
                        <CardTitle className="line-clamp-2 text-sm font-semibold">{row.title}</CardTitle>
                        <p className="text-xs text-muted-foreground">
                          {row.year ?? "—"} · {row.instance_name}
                        </p>
                      </CardHeader>
                      <CardContent className="space-y-2 px-3 pb-3">
                        <div className="flex flex-wrap gap-1.5">
                          <StatusBadge status={row.status} className="text-[0.6rem]" />
                          {row.monitored ? <span className="text-[0.6rem] font-medium uppercase text-primary">monitored</span> : null}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {fmtSize(row.size_bytes)} · {row.video_codec ?? "—"} / {row.audio_codec ?? "—"}
                        </p>
                        <p className="text-[11px] text-muted-foreground">Last seen {fmtDate(row.last_seen_at)}</p>
                      </CardContent>
                    </GlassCard>
                  </button>
                ))}
              </div>
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
