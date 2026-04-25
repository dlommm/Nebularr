import type { ScheduleRow } from "../types";

export const MAL_JOB_TYPE_ORDER = ["ingest", "matcher", "tag_sync"] as const;

export const SCHEDULE_MODE_LABELS: Record<string, string> = {
  incremental: "Incremental sync (Sonarr + Radarr + webhooks)",
  reconcile: "Full reconcile (Sonarr + Radarr)",
  full: "Full sync (legacy)",
  mal_ingest: "MAL — Dub list + anime ingest",
  mal_matcher: "MAL — Warehouse link / match refresh",
  mal_tag_sync: "MAL — English dub tag sync (Sonarr & Radarr)",
};

const SCHEDULE_VIEW_ORDER = [
  "incremental",
  "reconcile",
  "mal_ingest",
  "mal_matcher",
  "mal_tag_sync",
  "full",
] as const;

export function sortScheduleRows(rows: ScheduleRow[]): ScheduleRow[] {
  const rank = (mode: string): number => {
    const i = (SCHEDULE_VIEW_ORDER as readonly string[]).indexOf(mode);
    return i === -1 ? 999 : i;
  };
  return [...rows].sort((a, b) => rank(a.mode) - rank(b.mode) || a.mode.localeCompare(b.mode));
}
