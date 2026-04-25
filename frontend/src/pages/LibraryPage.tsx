import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { fmtDate, fmtSize, useDebouncedValue, useLocalStorageState } from "../hooks";
import { usePageTitle } from "../hooks/usePageTitle";
import type { EpisodeRow, MovieRow, ShowRow } from "../types";
import { Pagination } from "../components/ui";

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
      <div className="card compare-card">
        <h3>Compare mode</h3>
        <div className="compare-grid">
          <div>
            <strong>A:</strong> {compareRows[0].series_title} S{compareRows[0].season_number}E{compareRows[0].episode_number}
            <div className="muted">
              {compareRows[0].video_codec} / {compareRows[0].audio_codec} / {fmtSize(compareRows[0].size_bytes)}
            </div>
          </div>
          <div>
            <strong>B:</strong> {compareRows[1].series_title} S{compareRows[1].season_number}E{compareRows[1].episode_number}
            <div className="muted">
              {compareRows[1].video_codec} / {compareRows[1].audio_codec} / {fmtSize(compareRows[1].size_bytes)}
            </div>
          </div>
        </div>
      </div>
    ) : null;

  return (
    <>
      {compareSummary}
      <div className="grid">
        <div className="card span-12 sticky-toolbar">
          <div className="row">
            <button type="button" className={libraryMode === "drilldown" ? "" : "secondary"} onClick={() => setLibraryMode("drilldown")}>
              Drilldown
            </button>
            <button type="button" className={libraryMode === "all-episodes" ? "" : "secondary"} onClick={() => setLibraryMode("all-episodes")}>
              All episodes
            </button>
            <button type="button" className={libraryMode === "movies" ? "" : "secondary"} onClick={() => setLibraryMode("movies")}>
              Movies
            </button>
            <label className="pill">
              <input type="checkbox" checked={compareMode} onChange={(e) => setCompareMode(e.target.checked)} /> compare mode
            </label>
            <label className="pill">
              Column profile
              <select
                value={libraryFilters.sortBy}
                onChange={(event) => setLibraryFilters({ ...libraryFilters, sortBy: event.target.value, offset: 0 })}
              >
                <option value="title">Operations</option>
                <option value="size_bytes">Media forensics</option>
                <option value="air_date">Language audit</option>
              </select>
            </label>
          </div>
          <div className="row mt8">
            <input
              ref={searchInputRef}
              id="nebularr-library-search"
              placeholder="Search..."
              value={libraryFilters.search}
              onChange={(event) => setLibraryFilters({ ...libraryFilters, search: event.target.value, offset: 0 })}
            />
            <input
              placeholder="Instance"
              value={libraryFilters.instance}
              onChange={(event) => setLibraryFilters({ ...libraryFilters, instance: event.target.value, offset: 0 })}
            />
            <select
              value={libraryFilters.sortDir}
              onChange={(event) => setLibraryFilters({ ...libraryFilters, sortDir: event.target.value as "asc" | "desc" })}
            >
              <option value="asc">ASC</option>
              <option value="desc">DESC</option>
            </select>
            <select
              value={libraryFilters.limit}
              onChange={(event) => setLibraryFilters({ ...libraryFilters, limit: Number(event.target.value), offset: 0 })}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <button
              type="button"
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
              Export CSV (all)
            </button>
          </div>
        </div>

        {libraryMode === "drilldown" ? (
          <>
            <div className="card span-4">
              <h3>Shows</h3>
              <div className="table-wrap compact">
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Instance</th>
                      <th>Episodes</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shows.isLoading ? (
                      <tr>
                        <td colSpan={4} className="muted">
                          Loading shows…
                        </td>
                      </tr>
                    ) : null}
                    {(shows.data?.items ?? []).map((row: ShowRow) => (
                      <tr key={`${row.instance_name}-${row.series_id}`}>
                        <td>{row.title}</td>
                        <td>{row.instance_name}</td>
                        <td>{row.episode_count}</td>
                        <td>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              setSelectedShow({ id: row.series_id, instance: row.instance_name, title: row.title });
                              setLibraryFilters({ ...libraryFilters, offset: 0 });
                            }}
                          >
                            Select
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!shows.isLoading && (shows.data?.items.length ?? 0) === 0 ? (
                      <tr>
                        <td colSpan={4} className="muted">
                          No shows match current filters.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <Pagination
                total={shows.data?.total ?? 0}
                offset={libraryFilters.offset}
                limit={libraryFilters.limit}
                onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
              />
            </div>
            <div className="card span-8">
              <h3>Episodes {selectedShow ? `- ${selectedShow.title}` : ""}</h3>
              <div className="row">
                <select
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
                      season {entry.season_number}
                    </option>
                  ))}
                </select>
              </div>
              <div className="table-wrap compact">
                <table>
                  <thead>
                    <tr>
                      <th>Series</th>
                      <th>Instance</th>
                      <th>Season</th>
                      <th>Episode</th>
                      <th>Title</th>
                      <th>Air date</th>
                      <th>Size</th>
                      <th>Video</th>
                      <th>Audio</th>
                      <th>Status</th>
                      {compareMode ? <th>Compare</th> : null}
                    </tr>
                  </thead>
                  <tbody>{renderLibraryRows(showEpisodes.data?.items ?? [])}</tbody>
                </table>
              </div>
              {showEpisodes.isLoading ? <div className="muted mt8">Loading selected show episodes…</div> : null}
              <Pagination
                total={showEpisodes.data?.total ?? 0}
                offset={libraryFilters.offset}
                limit={libraryFilters.limit}
                onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
              />
            </div>
          </>
        ) : null}

        {libraryMode === "all-episodes" ? (
          <div className="card span-12">
            <h3>All episodes</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Series</th>
                    <th>Instance</th>
                    <th>Season</th>
                    <th>Episode</th>
                    <th>Title</th>
                    <th>Air date</th>
                    <th>Size</th>
                    <th>Video</th>
                    <th>Audio</th>
                    <th>Status</th>
                    {compareMode ? <th>Compare</th> : null}
                  </tr>
                </thead>
                <tbody>{renderLibraryRows(allEpisodes.data?.items ?? [])}</tbody>
              </table>
            </div>
            {allEpisodes.isLoading ? <div className="muted mt8">Loading episodes…</div> : null}
            <Pagination
              total={allEpisodes.data?.total ?? 0}
              offset={libraryFilters.offset}
              limit={libraryFilters.limit}
              onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
            />
          </div>
        ) : null}

        {libraryMode === "movies" ? (
          <div className="card span-12">
            <h3>Movies</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Year</th>
                    <th>Instance</th>
                    <th>Status</th>
                    <th>Size</th>
                    <th>Video</th>
                    <th>Audio</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {movies.isLoading ? (
                    <tr>
                      <td colSpan={8} className="muted">
                        Loading movies…
                      </td>
                    </tr>
                  ) : null}
                  {(movies.data?.items ?? []).map((row: MovieRow) => (
                    <tr key={`${row.instance_name}-${row.movie_id}`} onClick={() => setDetailDrawer(row)}>
                      <td>{row.title}</td>
                      <td>{row.year ?? "-"}</td>
                      <td>{row.instance_name}</td>
                      <td>{row.status}</td>
                      <td>{fmtSize(row.size_bytes)}</td>
                      <td>{row.video_codec ?? "-"}</td>
                      <td>{row.audio_codec ?? "-"}</td>
                      <td>{fmtDate(row.last_seen_at)}</td>
                    </tr>
                  ))}
                  {!movies.isLoading && (movies.data?.items.length ?? 0) === 0 ? (
                    <tr>
                      <td colSpan={8} className="muted">
                        No movies match current filters.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <Pagination
              total={movies.data?.total ?? 0}
              offset={libraryFilters.offset}
              limit={libraryFilters.limit}
              onChange={(nextOffset) => setLibraryFilters({ ...libraryFilters, offset: nextOffset })}
            />
          </div>
        ) : null}
      </div>

      {detailDrawer ? (
        <aside className="detail-drawer">
          <div className="row">
            <strong>Detail drawer</strong>
            <button type="button" className="secondary" onClick={() => setDetailDrawer(null)}>
              Close
            </button>
          </div>
          <pre>{JSON.stringify(detailDrawer, null, 2)}</pre>
        </aside>
      ) : null}
    </>
  );
}
