import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { fmtDate, fmtSize, useDebouncedValue, useLocalStorageState } from "../hooks";
import { usePageTitle } from "../hooks/usePageTitle";
import type { EpisodeRow, MovieRow, ShowRow } from "../types";
import { Pagination } from "../components/ui";
import { GlassCard, CardContent, CardHeader, CardTitle } from "../components/nebula/GlassCard";
import { StatusBadge } from "../components/nebula/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Clapperboard, Film, ListVideo } from "lucide-react";
import { cn } from "@/lib/utils";

type LibraryMode = "drilldown" | "all-episodes" | "movies";

type LibraryFilters = {
  search: string;
  instance: string;
  limit: number;
  offset: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  showSeason: number | null;
};

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
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const pending = sessionStorage.getItem("nebularr.library.pendingSearch");
    if (pending) {
      sessionStorage.removeItem("nebularr.library.pendingSearch");
      setLibraryFilters({ ...libraryFilters, search: pending, offset: 0 });
    }
    // Only on mount: merge header search with initial localStorage filters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debouncedSearch = useDebouncedValue(libraryFilters.search, 300);
  const debouncedInstance = useDebouncedValue(libraryFilters.instance, 300);

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
      libraryFilters.offset,
      libraryFilters.sortBy,
      libraryFilters.sortDir,
    ],
    queryFn: () =>
      api.showEpisodes(selectedShow!.id, selectedShow!.instance, {
        season_number: libraryFilters.showSeason,
        limit: libraryFilters.limit,
        offset: libraryFilters.offset,
        sort_by: libraryFilters.sortBy,
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
      <tr key={row.episode_id} onClick={() => setDetailDrawer(row)}>
        <td>{row.series_title}</td>
        <td>{row.instance_name}</td>
        <td>{row.season_number}</td>
        <td>{row.episode_number}</td>
        <td>{row.episode_title}</td>
        <td>{fmtDate(row.air_date)}</td>
        <td>{fmtSize(row.size_bytes)}</td>
        <td>{row.video_codec ?? "-"}</td>
        <td>{row.audio_codec ?? "-"}</td>
        <td>{row.has_file ? "downloaded" : row.series_status ?? "-"}</td>
        {compareMode ? (
          <td>
            <button
              type="button"
              className="secondary"
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
      <GlassCard className="border-cyan-500/20">
        <CardHeader>
          <CardTitle className="text-base">Compare mode</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-sm">
              <p className="font-medium">A: {compareRows[0].series_title}</p>
              <p className="text-xs text-muted-foreground">
                S{compareRows[0].season_number}E{compareRows[0].episode_number} · {compareRows[0].video_codec} / {compareRows[0].audio_codec} /{" "}
                {fmtSize(compareRows[0].size_bytes)}
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-sm">
              <p className="font-medium">B: {compareRows[1].series_title}</p>
              <p className="text-xs text-muted-foreground">
                S{compareRows[1].season_number}E{compareRows[1].episode_number} · {compareRows[1].video_codec} / {compareRows[1].audio_codec} /{" "}
                {fmtSize(compareRows[1].size_bytes)}
              </p>
            </div>
          </div>
        </CardContent>
      </GlassCard>
    ) : null;

  return (
    <>
      <div className="space-y-6">
        {compareSummary}

        <Tabs value={libraryMode} onValueChange={(v) => setLibraryMode(v as LibraryMode)} className="w-full">
          <GlassCard className="sticky top-0 z-10 border-white/10">
            <CardHeader className="space-y-4 pb-4">
              <div className="flex w-full min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <TabsList className="grid h-auto w-full min-w-0 min-h-9 max-w-full grid-cols-3 gap-0.5 bg-white/[0.06] p-1 sm:max-w-xl">
                  <TabsTrigger value="drilldown" className="min-w-0 gap-1.5 data-[state=active]:bg-white/10">
                    <Clapperboard className="size-3.5" aria-hidden />
                    <span className="hidden sm:inline">TV shows</span>
                  </TabsTrigger>
                  <TabsTrigger value="all-episodes" className="min-w-0 gap-1.5 data-[state=active]:bg-white/10">
                    <ListVideo className="size-3.5" aria-hidden />
                    <span className="hidden sm:inline">All eps</span>
                  </TabsTrigger>
                  <TabsTrigger value="movies" className="min-w-0 gap-1.5 data-[state=active]:bg-white/10">
                    <Film className="size-3.5" aria-hidden />
                    <span className="hidden sm:inline">Movies</span>
                  </TabsTrigger>
                </TabsList>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
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
                    className="h-9 rounded-md border border-white/10 bg-white/5 px-2 text-sm"
                    value={libraryFilters.sortBy}
                    onChange={(event) => setLibraryFilters({ ...libraryFilters, sortBy: event.target.value, offset: 0 })}
                  >
                    <option value="title">Operations (title)</option>
                    <option value="size_bytes">Media forensics</option>
                    <option value="air_date">Language audit</option>
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
                <div className="grid w-full gap-2 sm:max-w-xs sm:flex-1">
                  <Label htmlFor="nebularr-library-search" className="text-xs text-muted-foreground">
                    Search
                  </Label>
                  <Input
                    ref={searchInputRef}
                    id="nebularr-library-search"
                    placeholder="Titles, paths, metadata…"
                    value={libraryFilters.search}
                    onChange={(event) => setLibraryFilters({ ...libraryFilters, search: event.target.value, offset: 0 })}
                    className="h-9 border-white/10 bg-white/5"
                  />
                </div>
                <div className="grid w-full gap-2 sm:max-w-[200px]">
                  <Label className="text-xs text-muted-foreground">Instance</Label>
                  <Input
                    placeholder="Filter instance"
                    value={libraryFilters.instance}
                    onChange={(event) => setLibraryFilters({ ...libraryFilters, instance: event.target.value, offset: 0 })}
                    className="h-9 border-white/10 bg-white/5"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <select
                    className="h-9 rounded-md border border-white/10 bg-white/5 px-2 text-sm"
                    value={libraryFilters.sortDir}
                    onChange={(event) => setLibraryFilters({ ...libraryFilters, sortDir: event.target.value as "asc" | "desc" })}
                  >
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                  <select
                    className="h-9 rounded-md border border-white/10 bg-white/5 px-2 text-sm"
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
                    onClick={() => {
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
                {shows.isLoading ? (
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
                          onClick={() => {
                            setSelectedShow({ id: row.series_id, instance: row.instance_name, title: row.title });
                            setLibraryFilters({ ...libraryFilters, offset: 0 });
                          }}
                          className={cn(
                            "text-left transition-transform hover:scale-[1.01] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          )}
                        >
                          <GlassCard
                            className={cn(
                              "h-full border-white/10 p-0",
                              selected ? "ring-2 ring-cyan-500/50" : "",
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
                  <select
                    className="h-9 w-full max-w-xs rounded-md border border-white/10 bg-white/5 px-2 text-sm sm:w-auto"
                    value={libraryFilters.showSeason ?? "all"}
                    onChange={(event) =>
                      setLibraryFilters({
                        ...libraryFilters,
                        showSeason: event.target.value === "all" ? null : Number(event.target.value),
                        offset: 0,
                      })
                    }
                  >
                    <option value="all">All seasons</option>
                    {(showSeasons.data ?? []).map((entry) => (
                      <option key={entry.season_number} value={entry.season_number}>
                        Season {entry.season_number}
                      </option>
                    ))}
                  </select>
                  <div className="overflow-x-auto rounded-xl border border-white/10">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead>
                        <tr className="border-b border-white/10 text-left text-xs text-muted-foreground">
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
                    offset={libraryFilters.offset}
                    limit={libraryFilters.limit}
                    onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
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
                <div className="overflow-x-auto rounded-xl border border-white/10">
                  <table className="w-full min-w-[900px] text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-left text-xs text-muted-foreground">
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
            {movies.isLoading ? (
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
                    className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <GlassCard className="h-full border-white/10" size="sm">
                      <div className="h-2 rounded-t-lg bg-gradient-to-r from-cyan-500/40 to-violet-500/50" />
                      <CardHeader className="p-3 pb-1">
                        <CardTitle className="line-clamp-2 text-sm font-semibold">{row.title}</CardTitle>
                        <p className="text-xs text-muted-foreground">
                          {row.year ?? "—"} · {row.instance_name}
                        </p>
                      </CardHeader>
                      <CardContent className="space-y-2 px-3 pb-3">
                        <div className="flex flex-wrap gap-1.5">
                          <StatusBadge status={row.status} className="text-[0.6rem]" />
                          {row.monitored ? <span className="text-[0.6rem] uppercase text-cyan-200/80">monitored</span> : null}
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

      {detailDrawer ? (
        <aside className="fixed inset-y-0 right-0 z-40 w-full max-w-md border-l border-white/10 glass-panel-strong p-4 shadow-2xl">
          <div className="mb-3 flex items-center justify-between gap-2">
            <strong className="text-sm">Details</strong>
            <Button type="button" variant="secondary" size="sm" onClick={() => setDetailDrawer(null)}>
              Close
            </Button>
          </div>
          <pre className="max-h-[calc(100vh-6rem)] overflow-auto text-xs text-cyan-100/90">{JSON.stringify(detailDrawer, null, 2)}</pre>
        </aside>
      ) : null}
    </>
  );
}
