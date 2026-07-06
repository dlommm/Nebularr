export type LibraryMode = "drilldown" | "all-episodes" | "movies";

export type LibraryFilters = {
  search: string;
  instance: string;
  limit: number;
  offset: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  showSeason: number | null;
};

export type SelectedShow = { id: number; instance: string; title: string } | null;

/** Canonical URL form of the library state; only non-defaults are written so
    plain visits keep a clean address bar. */
export function serializeLibraryState(
  mode: LibraryMode,
  filters: LibraryFilters,
  show: SelectedShow,
): URLSearchParams {
  const params = new URLSearchParams();
  if (mode !== "drilldown") params.set("mode", mode);
  if (filters.search) params.set("q", filters.search);
  if (filters.instance) params.set("inst", filters.instance);
  if (filters.limit !== 50) params.set("limit", String(filters.limit));
  if (filters.offset) params.set("offset", String(filters.offset));
  if (filters.sortBy !== "title") params.set("sort", filters.sortBy);
  if (filters.sortDir !== "asc") params.set("dir", filters.sortDir);
  if (filters.showSeason != null) params.set("season", String(filters.showSeason));
  if (show && mode === "drilldown") params.set("show", `${show.id}|${show.instance}|${show.title}`);
  return params;
}
