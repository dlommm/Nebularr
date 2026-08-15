import { describe, expect, it } from "vitest";
import {
  describeCron,
  describeLimits,
  describeRequirements,
  describeScope,
  summarizeAutomation,
} from "./automationSummary";

describe("describeCron", () => {
  it.each([
    ["0 6 * * *", "every day at 06:00"],
    ["30 5 * * 6", "every Saturday at 05:30"],
    ["0 6 */2 * *", "every 2 days at 06:00"],
    ["15 6 * * 1,5", "every Monday and Friday at 06:15"],
    ["0 0 15 * *", "monthly on the 15th at 00:00"],
    ["*/5 * * * *", "every 5 minutes"],
    ["0 */3 * * *", "every 3 hours"],
  ])("phrases %s as %s", (cron, expected) => {
    expect(describeCron(cron)).toBe(expected);
  });

  it("falls back to the raw expression rather than guessing at exotic shapes", () => {
    // Honest fallback: a step-hour + day-of-week combination has no short
    // phrasing we can guarantee is accurate, so the user sees the truth.
    expect(describeCron("0 */4 * * 1-5")).toBe("0 */4 * * 1-5");
    expect(describeCron("nonsense")).toBe("nonsense");
    expect(describeCron("")).toBe("");
  });

  it("rejects out-of-range clock fields instead of formatting them", () => {
    expect(describeCron("70 99 * * *")).toBe("70 99 * * *");
  });
});

describe("describeScope", () => {
  it("defaults to monitored across both media", () => {
    expect(describeScope({})).toBe("monitored movies and series");
  });

  it("drops the monitored qualifier when the rule looks at everything", () => {
    expect(describeScope({ media: "movies", monitored_only: false })).toBe("movies");
  });

  it("names folders, genres and tags", () => {
    expect(
      describeScope({
        media: "series",
        anime_only: true,
        genres_any: ["action"],
        root_folders_any: ["/media/anime", "/media/anime-4k"],
        tags_any: ["keep"],
      }),
    ).toBe("monitored anime series in action under /media/anime and /media/anime-4k tagged keep");
  });
});

describe("describeRequirements", () => {
  it("returns null when nothing is required", () => {
    expect(describeRequirements({})).toBeNull();
  });

  it("joins every requirement clause", () => {
    expect(
      describeRequirements({ audio_language_any: ["english", "eng"], resolution_min: 1080 }),
    ).toBe("english and eng audio and 1080p or better");
  });
});

describe("summarizeAutomation", () => {
  it("renders the common upgrade rule as one sentence", () => {
    expect(
      summarizeAutomation({
        cron: "30 5 * * 6",
        params: {
          scope: { media: "movies" },
          require: { resolution_min: 1080 },
          actions: [{ type: "search_upgrade" }],
        },
      }),
    ).toBe(
      "Every Saturday at 05:30, look at monitored movies — for anything that isn't 1080p or better, search for an upgrade.",
    );
  });

  it("gives conforming-state actions their own clause", () => {
    // These fire on items that DO meet the bar, so folding them into the
    // "anything that isn't…" clause would state the opposite of the truth.
    const sentence = summarizeAutomation({
      cron: "0 6 * * *",
      params: {
        scope: { media: "movies" },
        require: { resolution_min: 1080 },
        actions: [
          { type: "search_upgrade" },
          { type: "set_monitored", value: false, when: "conforming" },
        ],
      },
    });
    expect(sentence).toContain("for anything that isn't 1080p or better, search for an upgrade");
    expect(sentence).toContain("unmonitor it once it conforms");
  });

  it("describes a no-requirements rule as hunting missing files", () => {
    expect(
      summarizeAutomation({
        cron: "0 6 * * *",
        params: { scope: {}, actions: [{ type: "search_missing" }] },
      }),
    ).toBe(
      "Every day at 06:00, look at monitored movies and series — for anything missing a file, search for the missing file.",
    );
  });

  it("quotes the tag label so the applied tag is unambiguous", () => {
    expect(
      summarizeAutomation({
        cron: "0 7 * * 6",
        params: {
          scope: { media: "both" },
          require: { video_codec_any: ["x265"] },
          actions: [{ type: "tag", label: "x264-candidate" }],
        },
      }),
    ).toContain("tag it “x264-candidate”");
  });
});

describe("describeLimits", () => {
  it("stays silent for rules that never search", () => {
    // Budget and cooldown govern searches only; claiming otherwise on a
    // tag-only rule would be a false statement about the backend.
    expect(
      describeLimits({ params: { actions: [{ type: "tag", label: "x" }] }, budget_per_run: 10 }),
    ).toBeNull();
  });

  it("states budget and cooldown for search rules", () => {
    expect(
      describeLimits({
        params: { actions: [{ type: "search_missing" }] },
        budget_per_run: 1,
        cooldown_days: 1,
      }),
    ).toBe("Up to 1 search per run, at most once every 1 day per item.");
  });
});
