import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { pollInterval, useServerEvents } from "./useServerEvents";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, () => void>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: () => void): void {
    this.listeners.set(type, handler);
  }

  close(): void {
    this.closed = true;
  }
}

describe("useServerEvents", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    queryClient = new QueryClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("connects, invalidates matching queries on events, and cleans up", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result, unmount } = renderHook(() => useServerEvents(), { wrapper });

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/ui/events");
    expect(result.current.connected).toBe(false);

    act(() => source.onopen?.());
    expect(result.current.connected).toBe(true);

    act(() => source.listeners.get("sync.finished")?.());
    const invalidatedKeys = invalidateSpy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(invalidatedKeys).toContain(JSON.stringify(["runs"]));
    expect(invalidatedKeys).toContain(JSON.stringify(["sync-progress"]));

    unmount();
    expect(source.closed).toBe(true);
  });

  it("reports disconnected on error and schedules a reconnect", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useServerEvents(), { wrapper });
    const first = FakeEventSource.instances[0];

    act(() => first.onopen?.());
    expect(result.current.connected).toBe(true);

    act(() => first.onerror?.());
    expect(result.current.connected).toBe(false);
    expect(first.closed).toBe(true);

    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});

describe("pollInterval", () => {
  it("relaxes when connected and falls back when not", () => {
    expect(pollInterval(true, 2_000, 30_000)).toBe(30_000);
    expect(pollInterval(false, 2_000, 30_000)).toBe(2_000);
  });
});
