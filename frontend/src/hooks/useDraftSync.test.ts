import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDraftSync } from "./useDraftSync";

type Row = { key: string; value: string };

const keyOf = (row: Row): string => row.key;

describe("useDraftSync", () => {
  it("initializes drafts from server data", () => {
    const initial: Row[] = [
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ];
    const { result } = renderHook(() => useDraftSync(initial, keyOf));
    expect(result.current.drafts).toEqual({
      a: { key: "a", value: "1" },
      b: { key: "b", value: "2" },
    });
    expect(result.current.dirtyKeys.size).toBe(0);
  });

  it("leaves drafts empty while server data hasn't loaded yet", () => {
    const { result } = renderHook(() => useDraftSync<Row>(undefined, keyOf));
    expect(result.current.drafts).toEqual({});
    expect(result.current.dirtyKeys.size).toBe(0);
  });

  it("a server refetch updates non-dirty rows but preserves a dirty row's edits", () => {
    const { result, rerender } = renderHook(({ data }: { data: Row[] }) => useDraftSync(data, keyOf), {
      initialProps: {
        data: [
          { key: "a", value: "1" },
          { key: "b", value: "2" },
        ],
      },
    });

    // Row A gets a local, unsaved edit.
    act(() => {
      result.current.setDraft("a", { value: "1-edited" });
    });
    expect(result.current.drafts.a.value).toBe("1-edited");
    expect(result.current.dirtyKeys.has("a")).toBe(true);

    // Server refetch brings fresh values for both rows.
    rerender({
      data: [
        { key: "a", value: "1-from-server" },
        { key: "b", value: "2-from-server" },
      ],
    });

    // Dirty row A must not be clobbered by the refetch...
    expect(result.current.drafts.a.value).toBe("1-edited");
    expect(result.current.dirtyKeys.has("a")).toBe(true);
    // ...but non-dirty row B picks up the new server value.
    expect(result.current.drafts.b.value).toBe("2-from-server");
  });

  it("resetDraft clears the dirty flag and re-syncs that row to the latest server value", () => {
    const { result, rerender } = renderHook(({ data }: { data: Row[] }) => useDraftSync(data, keyOf), {
      initialProps: {
        data: [{ key: "a", value: "1" }],
      },
    });

    act(() => {
      result.current.setDraft("a", { value: "1-edited" });
    });
    expect(result.current.dirtyKeys.has("a")).toBe(true);

    rerender({ data: [{ key: "a", value: "1-saved" }] });
    // Still dirty, so the refetch (e.g. from an unrelated row's save) doesn't overwrite it yet.
    expect(result.current.drafts.a.value).toBe("1-edited");

    act(() => {
      result.current.resetDraft("a");
    });

    expect(result.current.dirtyKeys.has("a")).toBe(false);
    expect(result.current.drafts.a.value).toBe("1-saved");
  });

  it("a resetDraft captured before a server refetch still adopts the NEW server value", () => {
    // Guards against a stale closure: resetDraft must read server data through a
    // ref, not close over the `serverData` it saw at creation time. Capturing the
    // callback reference *before* the refetch (as a memoized event handler would)
    // and calling it *after* must snap to the fresh value, not the one it was born with.
    const { result, rerender } = renderHook(({ data }: { data: Row[] }) => useDraftSync(data, keyOf), {
      initialProps: {
        data: [{ key: "a", value: "server-v1" }],
      },
    });

    act(() => {
      result.current.setDraft("a", { value: "local-edit" });
    });
    // Grab the resetDraft reference now, before server data changes underneath it.
    const capturedReset = result.current.resetDraft;

    // A background refetch (e.g. post-invalidate) brings a newer server value while
    // the row is still dirty, so the merge effect leaves the draft alone.
    rerender({ data: [{ key: "a", value: "server-v2" }] });
    expect(result.current.drafts.a.value).toBe("local-edit");

    act(() => {
      capturedReset("a");
    });

    expect(result.current.dirtyKeys.has("a")).toBe(false);
    // Must be the value from the latest refetch, not the stale "server-v1" closure.
    expect(result.current.drafts.a.value).toBe("server-v2");
  });

  it("saving one row resets only that row's draft, leaving other dirty rows untouched", () => {
    // Hoisted outside the render callback: an inline array literal there
    // would be a fresh reference every render, so the merge effect's
    // `[serverData]` dependency would never stabilize.
    const data: Row[] = [
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ];
    const { result } = renderHook(() => useDraftSync(data, keyOf));

    act(() => {
      result.current.setDraft("a", { value: "a-edit" });
      result.current.setDraft("b", { value: "b-edit" });
    });
    expect(result.current.dirtyKeys.has("a")).toBe(true);
    expect(result.current.dirtyKeys.has("b")).toBe(true);

    act(() => {
      result.current.resetDraft("a");
    });

    expect(result.current.dirtyKeys.has("a")).toBe(false);
    expect(result.current.dirtyKeys.has("b")).toBe(true);
    expect(result.current.drafts.b.value).toBe("b-edit");
  });

  it("drops the dirty flag for a row that disappears from server data", () => {
    const { result, rerender } = renderHook(({ data }: { data: Row[] }) => useDraftSync(data, keyOf), {
      initialProps: {
        data: [
          { key: "a", value: "1" },
          { key: "b", value: "2" },
        ],
      },
    });

    act(() => {
      result.current.setDraft("a", { value: "a-edit" });
    });
    expect(result.current.dirtyKeys.has("a")).toBe(true);

    rerender({ data: [{ key: "b", value: "2" }] });

    expect(result.current.dirtyKeys.has("a")).toBe(false);
    expect(result.current.drafts.a).toBeUndefined();
  });
});
