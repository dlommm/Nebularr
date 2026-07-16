import { describe, expect, it } from "vitest";
import { pageKeyFromStorageKey } from "./savedViewsShared";

describe("pageKeyFromStorageKey", () => {
  it("extracts the trailing segment as the page key", () => {
    expect(pageKeyFromStorageKey("nebularr.savedViews.reporting")).toBe("reporting");
    expect(pageKeyFromStorageKey("nebularr.savedViews.library")).toBe("library");
  });

  it("sanitizes unexpected characters", () => {
    expect(pageKeyFromStorageKey("Weird Key!")).toBe("weird-key-");
  });
});
