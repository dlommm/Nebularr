import { fmtDate, fmtSize } from "../hooks";

export type MediaRecord = Record<string, unknown>;

export type DetailField = {
  label: string;
  value: string;
  /** Render as language/codec badges instead of plain text. */
  badges?: string[];
};

export type DetailSection = {
  title: string;
  fields: DetailField[];
};

function str(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "—";
  return String(value);
}

function langList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function isEpisodeRecord(row: MediaRecord): boolean {
  return "episode_id" in row;
}

export function mediaTitle(row: MediaRecord): string {
  if (isEpisodeRecord(row)) {
    const season = String(row.season_number ?? "?").padStart(2, "0");
    const episode = String(row.episode_number ?? "?").padStart(2, "0");
    return `${str(row.series_title)} · S${season}E${episode}`;
  }
  const year = row.year ? ` (${String(row.year)})` : "";
  return `${str(row.title)}${year}`;
}

/** Field sections for an episode or movie row; shared by the detail sheet and
    compare view so both always list the same attributes. */
export function mediaDetailSections(row: MediaRecord): DetailSection[] {
  const episode = isEpisodeRecord(row);
  const overview: DetailField[] = episode
    ? [
        { label: "Series", value: str(row.series_title) },
        { label: "Episode", value: `S${str(row.season_number)}E${str(row.episode_number)} · ${str(row.episode_title)}` },
        { label: "Instance", value: str(row.instance_name) },
        { label: "Monitored", value: row.monitored ? "yes" : "no" },
        { label: "Series status", value: str(row.series_status) },
        { label: "Downloaded", value: row.has_file ? "yes" : "no" },
      ]
    : [
        { label: "Title", value: str(row.title) },
        { label: "Year", value: str(row.year) },
        { label: "Instance", value: str(row.instance_name) },
        { label: "Monitored", value: row.monitored ? "yes" : "no" },
        { label: "Status", value: str(row.status) },
      ];
  const file: DetailField[] = [
    { label: "Path", value: str(row.file_path ?? row.relative_path) },
    { label: "Size", value: typeof row.size_bytes === "number" ? fmtSize(row.size_bytes) : "—" },
    { label: "Quality", value: str(row.quality) },
    { label: "Release group", value: str(row.release_group) },
    { label: "Custom format score", value: str(row.custom_format_score) },
    { label: "Indexer flags", value: str(row.indexer_flags) },
  ];
  const media: DetailField[] = [
    { label: "Video", value: `${str(row.video_codec)} · ${str(row.video_dynamic_range)}` },
    { label: "Audio", value: `${str(row.audio_codec)} · ${str(row.audio_channels)} ch` },
    { label: "Audio languages", value: str(row.audio_languages), badges: langList(row.audio_languages) },
    { label: "Subtitles", value: str(row.subtitle_languages), badges: langList(row.subtitle_languages) },
  ];
  const timestamps: DetailField[] = episode
    ? [
        { label: "Air date", value: row.air_date ? fmtDate(String(row.air_date)) : "—" },
        { label: "Runtime", value: row.runtime_minutes ? `${str(row.runtime_minutes)} min` : "—" },
      ]
    : [
        { label: "Last seen", value: row.last_seen_at ? fmtDate(String(row.last_seen_at)) : "—" },
        { label: "Runtime", value: row.runtime_minutes ? `${str(row.runtime_minutes)} min` : "—" },
      ];
  return [
    { title: "Overview", fields: overview },
    { title: "File", fields: file },
    { title: "Media", fields: media },
    { title: episode ? "Schedule" : "Activity", fields: timestamps },
  ];
}
