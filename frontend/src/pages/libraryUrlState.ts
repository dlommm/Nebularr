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

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  search: "",
  instance: "",
  limit: 50,
  offset: 0,
  sortBy: "title",
  sortDir: "asc",
  showSeason: null,
};

const LIBRARY_MODE_STORAGE_KEY = "nebularr.library.mode";
const LIBRARY_FILTERS_STORAGE_KEY = "nebularr.library.filters";

function storedJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Filters to apply when the user selects a different show in drilldown
    mode: the previous show's season filter almost never applies to the new
    show, and if it happens not to exist there the episode query would
    silently return zero rows instead of "no filter". */
export function clearSeasonOnShowSelect(filters: LibraryFilters): LibraryFilters {
  return filters.showSeason == null ? filters : { ...filters, showSeason: null };
}

/** Header-search URL: the user's persisted mode/filters with the new query and
    a reset offset, so searching never silently switches the view or drops
    instance/sort/limit choices (the URL→state effect applies full snapshots). */
export function buildLibrarySearchParams(query: string): URLSearchParams {
  const rawMode = storedJson<string>(LIBRARY_MODE_STORAGE_KEY, "drilldown");
  const mode: LibraryMode =
    rawMode === "all-episodes" || rawMode === "movies" ? rawMode : "drilldown";
  const stored = storedJson<Partial<LibraryFilters>>(LIBRARY_FILTERS_STORAGE_KEY, {});
  // Selected show is intentionally dropped so the search results are visible —
  // and with it, the season filter: it's meaningless without a show to scope
  // it to, and a dangling `season` param would otherwise ride along into the
  // URL (surfacing as an optionless Season dropdown, and a stray
  // `season_number` on Movies/All-episodes CSV exports).
  const filters: LibraryFilters = clearSeasonOnShowSelect({
    ...DEFAULT_LIBRARY_FILTERS,
    ...stored,
    search: query,
    offset: 0,
  });
  return serializeLibraryState(mode, filters, null);
}

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
