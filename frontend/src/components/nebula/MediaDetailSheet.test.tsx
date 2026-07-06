import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MediaCompareGrid, MediaDetailSheet } from "./MediaDetailSheet";
import { mediaDetailSections, mediaTitle } from "../../lib/mediaDetail";

const episodeRow = {
  instance_name: "default",
  series_id: 1,
  series_title: "Test Show",
  episode_id: 11,
  season_number: 1,
  episode_number: 2,
  episode_title: "Pilot Part 2",
  air_date: "2026-01-02",
  runtime_minutes: 42,
  monitored: true,
  has_file: true,
  file_path: "/tv/Test Show/S01E02.mkv",
  size_bytes: 1073741824,
  quality: "WEBDL-1080p",
  audio_codec: "EAC3",
  audio_channels: "5.1",
  video_codec: "x265",
  video_dynamic_range: "HDR",
  audio_languages: ["eng", "jpn"],
  subtitle_languages: ["eng"],
  release_group: "GROUP",
  custom_format_score: "120",
  series_status: "continuing",
};

const movieRow = {
  instance_name: "default",
  movie_id: 5,
  title: "Test Movie",
  year: 2024,
  monitored: false,
  status: "released",
  file_path: "/movies/Test Movie (2024).mkv",
  size_bytes: 4294967296,
  quality: "Bluray-2160p",
  video_codec: "x265",
  audio_codec: "TrueHD",
  audio_languages: ["eng"],
  subtitle_languages: [],
  last_seen_at: "2026-07-01T00:00:00Z",
};

describe("MediaDetailSheet", () => {
  it("renders episode fields instead of raw JSON", () => {
    render(<MediaDetailSheet row={episodeRow} onClose={vi.fn()} />);
    expect(screen.getByText("Test Show · S01E02")).toBeInTheDocument();
    expect(screen.getByText("/tv/Test Show/S01E02.mkv")).toBeInTheDocument();
    expect(screen.getByText("1.00 GiB")).toBeInTheDocument();
    expect(screen.getByText("WEBDL-1080p")).toBeInTheDocument();
    expect(screen.getByText("GROUP")).toBeInTheDocument();
    expect(screen.getByText("jpn")).toBeInTheDocument();
    expect(screen.getByText("Raw JSON")).toBeInTheDocument();
  });

  it("renders movie fields with year in the title", () => {
    render(<MediaDetailSheet row={movieRow} onClose={vi.fn()} />);
    expect(screen.getByText("Test Movie (2024)")).toBeInTheDocument();
    expect(screen.getByText("Bluray-2160p")).toBeInTheDocument();
  });
});

describe("mediaDetailSections", () => {
  it("produces parallel sections for episodes and movies", () => {
    const episodeSections = mediaDetailSections(episodeRow);
    const movieSections = mediaDetailSections(movieRow);
    expect(episodeSections.map((s) => s.title)).toEqual(["Overview", "File", "Media", "Schedule"]);
    expect(movieSections.map((s) => s.title)).toEqual(["Overview", "File", "Media", "Activity"]);
  });

  it("mediaTitle pads season/episode numbers", () => {
    expect(mediaTitle(episodeRow)).toBe("Test Show · S01E02");
  });
});

describe("MediaCompareGrid", () => {
  it("highlights differing fields", () => {
    const other = { ...episodeRow, episode_id: 12, quality: "Bluray-2160p", size_bytes: 2147483648 };
    const { container } = render(<MediaCompareGrid a={episodeRow} b={other} />);
    expect(container.querySelectorAll(".bg-warn\\/10").length).toBeGreaterThan(0);
    expect(screen.getByText("WEBDL-1080p")).toBeInTheDocument();
    expect(screen.getByText("Bluray-2160p")).toBeInTheDocument();
  });
});
