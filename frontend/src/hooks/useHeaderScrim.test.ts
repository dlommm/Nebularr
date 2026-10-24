import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { HEADER_SCRIM_DEFAULT, HEADER_SCRIM_KEY, HEADER_SCRIM_MAX, HEADER_SCRIM_MIN, useHeaderScrim } from "./useHeaderScrim";

afterEach(() => window.localStorage.removeItem(HEADER_SCRIM_KEY));

describe("useHeaderScrim", () => {
  it("defaults when nothing is stored or the value is junk", () => {
    expect(renderHook(() => useHeaderScrim()).result.current[0]).toBe(HEADER_SCRIM_DEFAULT);
    window.localStorage.setItem(HEADER_SCRIM_KEY, "not json");
    expect(renderHook(() => useHeaderScrim()).result.current[0]).toBe(HEADER_SCRIM_DEFAULT);
  });

  it("clamps stored and written values to the slider range", () => {
    window.localStorage.setItem(HEADER_SCRIM_KEY, "9");
    const { result } = renderHook(() => useHeaderScrim());
    expect(result.current[0]).toBe(HEADER_SCRIM_MAX);
    act(() => result.current[1](0));
    expect(result.current[0]).toBe(HEADER_SCRIM_MIN);
    expect(window.localStorage.getItem(HEADER_SCRIM_KEY)).toBe(String(HEADER_SCRIM_MIN));
  });

  it("keeps every mounted reader in step, so the header follows the setting", () => {
    const header = renderHook(() => useHeaderScrim());
    const setting = renderHook(() => useHeaderScrim());
    act(() => setting.result.current[1](1.3));
    expect(header.result.current[0]).toBe(1.3);
  });
});
