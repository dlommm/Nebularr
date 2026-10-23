import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { artUrl, ghostWord, titleCardStyle } from "./artwork";
import { groupSeasons, qualityTier } from "./quality";
import { relTime, sinceShort } from "./time";
import { SyncLanes } from "@/components/ns/SyncLanes";
import type { EpisodeRow, RunTimeline } from "@/types";

const NOW = new Date("2026-10-22T14:56:00Z");

describe("relTime", () => {
  it("speaks in plain English", () => {
    expect(relTime("2026-10-22T14:56:20Z", NOW)).toBe("just now");
    expect(relTime("2026-10-22T14:52:00Z", NOW)).toBe("4 min ago");
    expect(relTime("2026-10-22T05:56:00Z", NOW)).toBe("9 h ago");
    expect(relTime("2026-10-21T12:00:00Z", NOW)).toBe("yesterday");
    expect(relTime(null, NOW)).toBe("never");
    expect(sinceShort("2026-10-22T05:56:00Z", NOW)).toBe("9 h");
  });
});

describe("artwork helpers", () => {
  it("builds proxied URLs with an encoded instance name", () => {
    expect(artUrl("series", "sonarr anime", 12, "poster", 500)).toBe("/api/art/series/sonarr%20anime/12/poster?size=500");
    expect(artUrl("movie", "radarr", 7, "fanart")).toBe("/api/art/movie/radarr/7/fanart");
  });

  it("gives the same title the same card", () => {
    expect(titleCardStyle("Halcyon Station")).toEqual(titleCardStyle("  halcyon station "));
    expect(ghostWord("The Quiet Orchard")).toBe("Quiet");
  });
});

describe("quality tiers", () => {
  it("maps Arr quality names to tiers and missing files to outlines", () => {
    expect(qualityTier(true, "Bluray-2160p")).toBe("q4");
    expect(qualityTier(true, "WEBDL-1080p")).toBe("q3");
    expect(qualityTier(true, "HDTV-720p")).toBe("q2");
    expect(qualityTier(true, "DVD")).toBe("q1");
    expect(qualityTier(false, "Bluray-2160p")).toBe("qm");
  });

  it("groups episodes into sorted seasons with on-disk counts", () => {
    const ep = (season: number, episode: number, hasFile: boolean): EpisodeRow =>
      ({ season_number: season, episode_number: episode, has_file: hasFile, size_bytes: hasFile ? 10 : null, episode_id: season * 100 + episode }) as EpisodeRow;
    const seasons = groupSeasons([ep(2, 2, true), ep(1, 1, false), ep(2, 1, true)]);
    expect(seasons.map((s) => s.number)).toEqual([1, 2]);
    expect(seasons[1].episodes.map((e) => e.episode_number)).toEqual([1, 2]);
    expect(seasons[1].have).toBe(2);
    expect(seasons[1].bytes).toBe(20);
  });
});

describe("SyncLanes", () => {
  const timeline = (overrides: Partial<RunTimeline["lanes"][number]>[]): RunTimeline => ({
    now: NOW.toISOString(),
    hours: 24,
    lanes: overrides.map((o, i) => ({ key: `k${i}`, label: `lane ${i}`, kind: "sonarr", events: [], last_at: null, ...o })),
  });

  it("calls out a source that has gone quiet", () => {
    render(<SyncLanes timeline={timeline([{ label: "sonarr-anime", last_at: "2026-10-22T05:56:00Z" }])} />);
    expect(screen.getByRole("img", { name: /sonarr-anime.*silent for 9 hours/i })).toBeInTheDocument();
  });

  it("flags a run of failures", () => {
    const failed = (at: string) => ({ at, kind: "incremental", status: "failed" });
    render(
      <SyncLanes
        timeline={timeline([{ label: "radarr", kind: "radarr", events: [failed("2026-10-22T13:30:00Z"), failed("2026-10-22T14:00:00Z")] }])}
      />,
    );
    expect(screen.getByText("failed in a row")).toBeInTheDocument();
  });

  it("does not treat a quiet webhook lane as a problem", () => {
    render(<SyncLanes timeline={timeline([{ label: "Webhooks", kind: "webhooks", last_at: null }])} />);
    expect(screen.queryByText(/silent/i)).not.toBeInTheDocument();
  });
});
