import { describe, expect, it } from "vitest";
import { clampPageOffset } from "./syncQueueShared";

describe("clampPageOffset", () => {
  it("leaves a valid offset untouched", () => {
    expect(clampPageOffset(0, 30, 50)).toBe(0);
    expect(clampPageOffset(100, 125, 50)).toBe(100);
  });

  it("clamps to 0 when there are no rows", () => {
    expect(clampPageOffset(0, 0, 50)).toBe(0);
    expect(clampPageOffset(50, 0, 50)).toBe(0);
  });

  it("clamps a negative offset to 0", () => {
    expect(clampPageOffset(-10, 30, 50)).toBe(0);
  });

  it("snaps back to the last valid page when total shrinks below the current page", () => {
    // Page 2 (offset 50) requested a page size of 50, but total shrank to 30
    // (e.g. a bulk requeue emptied it) — only page 1 (offset 0) exists now.
    expect(clampPageOffset(50, 30, 50)).toBe(0);
  });

  it("snaps back to the new last page, not all the way to 0, when several pages still exist", () => {
    // offset 100 (page 3) requested, but total shrank to 90 — page 2 (offset 50) is now last.
    expect(clampPageOffset(100, 90, 50)).toBe(50);
  });

  it("treats an offset equal to total as out of range (offsets are 0-based)", () => {
    expect(clampPageOffset(50, 50, 50)).toBe(0);
  });
});
