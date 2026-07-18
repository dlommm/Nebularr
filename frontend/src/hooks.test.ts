import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { errText, fmtDate, fmtDuration, useLocalStorageState } from "./hooks";

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

describe("useLocalStorageState", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("resets to the new key's stored value when the key changes", () => {
    window.localStorage.setItem("nebularr.a", JSON.stringify("value-a"));
    window.localStorage.setItem("nebularr.b", JSON.stringify("value-b"));
    const { result, rerender } = renderHook(({ key }: { key: string }) => useLocalStorageState(key, "default"), {
      initialProps: { key: "nebularr.a" },
    });
    expect(result.current[0]).toBe("value-a");

    rerender({ key: "nebularr.b" });
    expect(result.current[0]).toBe("value-b");
  });

  it("falls back to the initial value when switching to a key with nothing stored", () => {
    const { result, rerender } = renderHook(({ key }: { key: string }) => useLocalStorageState(key, "default"), {
      initialProps: { key: "nebularr.c" },
    });
    expect(result.current[0]).toBe("default");

    rerender({ key: "nebularr.d" });
    expect(result.current[0]).toBe("default");
  });

  it("does not reset when re-rendered with the same key", () => {
    const { result, rerender } = renderHook(({ key }: { key: string }) => useLocalStorageState(key, "default"), {
      initialProps: { key: "nebularr.e" },
    });
    act(() => {
      result.current[1]("changed");
    });
    expect(result.current[0]).toBe("changed");

    rerender({ key: "nebularr.e" });
    expect(result.current[0]).toBe("changed");
  });

  it("supports functional updates like React's setState", () => {
    const { result } = renderHook(() => useLocalStorageState("nebularr.counter", 0));
    act(() => {
      result.current[1]((prev) => prev + 1);
    });
    expect(result.current[0]).toBe(1);
  });
});
