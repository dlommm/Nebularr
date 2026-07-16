import { describe, expect, it } from "vitest";
import { errText, fmtDate, fmtDuration } from "./hooks";

describe("fmtDate", () => {
  it("formats valid dates", () => {
    expect(fmtDate("2026-07-01T10:00:00Z")).not.toBe("Invalid Date");
  });

  it("returns the raw string for unparsable input instead of 'Invalid Date'", () => {
    expect(fmtDate("not-a-date")).toBe("not-a-date");
  });

  it("returns a dash for empty values", () => {
    expect(fmtDate(null)).toBe("-");
    expect(fmtDate(undefined)).toBe("-");
    expect(fmtDate("")).toBe("-");
  });
});

describe("errText", () => {
  it("uses .message for Error instances", () => {
    expect(errText(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(errText("plain")).toBe("plain");
    expect(errText(42)).toBe("42");
  });
});

describe("fmtDuration", () => {
  it("renders hours/minutes/seconds", () => {
    expect(fmtDuration(3725)).toBe("1h 2m 5s");
    expect(fmtDuration(65)).toBe("1m 5s");
    expect(fmtDuration(5)).toBe("5s");
  });
});

import { reconnectDelayMs } from "./hooks/useServerEvents";

describe("reconnectDelayMs", () => {
  it("backs off exponentially and caps at 60s", () => {
    expect(reconnectDelayMs(1)).toBe(5_000);
    expect(reconnectDelayMs(2)).toBe(10_000);
    expect(reconnectDelayMs(3)).toBe(20_000);
    expect(reconnectDelayMs(4)).toBe(40_000);
    expect(reconnectDelayMs(5)).toBe(60_000);
    expect(reconnectDelayMs(10)).toBe(60_000);
  });
});
