export const MAX_UNLIMITED_ROWS = 500;

export function tokenizeFilter(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function stringifyCellValue(value: unknown): string {
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    return JSON.stringify(value);
  }
  return String(value ?? "-");
}

export function rowMatchesFilters(row: Record<string, unknown>, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = Object.values(row)
    .map((value) => {
      if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
        return JSON.stringify(value);
      }
      return String(value ?? "");
    })
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function rowPassesSeasonFilter(row: Record<string, unknown>, ignoreSeasonZero: boolean): boolean {
  if (!ignoreSeasonZero) return true;
  const seasonKeys = ["season_number", "season", "seasonNumber"];
  for (const key of seasonKeys) {
    if (!(key in row)) continue;
    const raw = row[key];
    const normalized = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
    if (!Number.isNaN(normalized) && normalized === 0) return false;
  }
  return true;
}

/** Cycle through the theme's categorical chart tokens so charts follow the
    active light/dark palette instead of hard-coded colors. */
export function chartColor(index: number): string {
  return `var(--chart-${(index % 5) + 1})`;
}
