import type { EpisodeRow } from "@/types";

export type QualityTier = "q4" | "q3" | "q2" | "q1" | "qm";

export const QUALITY_TIERS: { tier: Exclude<QualityTier, "qm">; label: string }[] = [
  { tier: "q4", label: "2160p" },
  { tier: "q3", label: "1080p" },
  { tier: "q2", label: "720p" },
  { tier: "q1", label: "SD" },
];

export function qualityTier(hasFile: boolean, quality: string | null | undefined): QualityTier {
  if (!hasFile) return "qm";
  const q = (quality ?? "").toLowerCase();
  if (q.includes("2160") || q.includes("4k") || q.includes("uhd")) return "q4";
  if (q.includes("1080")) return "q3";
  if (q.includes("720")) return "q2";
  return "q1";
}

type Season = { number: number; episodes: EpisodeRow[]; have: number; bytes: number };

export function groupSeasons(episodes: EpisodeRow[]): Season[] {
  const map = new Map<number, Season>();
  for (const ep of episodes) {
    const season = map.get(ep.season_number) ?? { number: ep.season_number, episodes: [], have: 0, bytes: 0 };
    season.episodes.push(ep);
    if (ep.has_file) {
      season.have += 1;
      season.bytes += ep.size_bytes ?? 0;
    }
    map.set(ep.season_number, season);
  }
  return [...map.values()]
    .sort((a, b) => a.number - b.number)
    .map((s) => ({ ...s, episodes: [...s.episodes].sort((a, b) => a.episode_number - b.episode_number) }));
}
