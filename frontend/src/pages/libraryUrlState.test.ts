import { beforeEach, describe, expect, it } from "vitest";
import { serializeLibraryState } from "./libraryUrlState";

const defaults = {
  search: "",
  instance: "",
  limit: 50,
  offset: 0,
  sortBy: "title",
  sortDir: "asc" as const,
  showSeason: null,
};

describe("serializeLibraryState", () => {
  it("writes nothing for the default state", () => {
    expect(serializeLibraryState("drilldown", defaults, null).toString()).toBe("");
  });

  it("round-trips non-default state through URL params", () => {
    const params = serializeLibraryState(
      "all-episodes",
      { ...defaults, search: "attack on", instance: "anime", limit: 100, offset: 200, sortBy: "size_bytes", sortDir: "desc" },
      null,
    );
    expect(params.get("mode")).toBe("all-episodes");
    expect(params.get("q")).toBe("attack on");
    expect(params.get("inst")).toBe("anime");
    expect(params.get("limit")).toBe("100");
    expect(params.get("offset")).toBe("200");
    expect(params.get("sort")).toBe("size_bytes");
    expect(params.get("dir")).toBe("desc");
  });

  it("encodes the selected show only in drilldown mode", () => {
    const show = { id: 42, instance: "default", title: "Some | Show" };
    const drill = serializeLibraryState("drilldown", defaults, show);
    expect(drill.get("show")).toBe("42|default|Some | Show");
    const movies = serializeLibraryState("movies", defaults, show);
    expect(movies.get("show")).toBeNull();
  });
});

import { buildLibrarySearchParams } from "./libraryUrlState";

describe("buildLibrarySearchParams", () => {
  beforeEach(() => window.localStorage.clear());

  it("preserves persisted mode and filters while setting the query and resetting offset", () => {
    window.localStorage.setItem("nebularr.library.mode", JSON.stringify("movies"));
    window.localStorage.setItem(
      "nebularr.library.filters",
      JSON.stringify({ instance: "main", limit: 100, offset: 40, sortBy: "year", sortDir: "desc" }),
    );
    const params = buildLibrarySearchParams("dune");
    expect(params.get("mode")).toBe("movies");
    expect(params.get("q")).toBe("dune");
    expect(params.get("inst")).toBe("main");
    expect(params.get("limit")).toBe("100");
    expect(params.get("sort")).toBe("year");
    expect(params.get("dir")).toBe("desc");
    expect(params.get("offset")).toBeNull(); // offset 0 is the default, omitted
  });

  it("falls back to defaults on corrupt localStorage", () => {
    window.localStorage.setItem("nebularr.library.mode", "{not json");
    window.localStorage.setItem("nebularr.library.filters", "also broken");
    const params = buildLibrarySearchParams("hi");
    expect(params.get("mode")).toBeNull(); // drilldown default
    expect(params.get("q")).toBe("hi");
  });
});
