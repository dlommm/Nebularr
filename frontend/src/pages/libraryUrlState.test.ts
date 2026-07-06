import { describe, expect, it } from "vitest";
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
