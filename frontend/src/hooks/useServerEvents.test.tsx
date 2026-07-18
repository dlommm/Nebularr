import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { api, redirectToLogin } from "../api";
import { pollInterval, useServerEvents } from "./useServerEvents";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { ...actual.api, authStatus: vi.fn() },
    redirectToLogin: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

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

function keysInvalidated(invalidateSpy: { mock: { calls: unknown[][] } }): string[] {
  return invalidateSpy.mock.calls.map(([filters]) =>
    JSON.stringify((filters as { queryKey: unknown }).queryKey),
  );
}

describe("useServerEvents", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    queryClient = new QueryClient();
    vi.mocked(api.authStatus).mockReset().mockResolvedValue({
      enabled: false,
      authenticated: false,
      password_set: false,
      api_token_set: false,
    });
    vi.mocked(redirectToLogin).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("connects, debounce-invalidates matching queries on events, and cleans up", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result, unmount } = renderHook(() => useServerEvents(), { wrapper });

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/ui/events");
    expect(result.current.connected).toBe(false);

    act(() => source.onopen?.());
    expect(result.current.connected).toBe(true);

    act(() => source.listeners.get("sync.finished")?.());
    // Debounced: nothing fires synchronously.
    expect(invalidateSpy).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));

    const invalidatedKeys = keysInvalidated(invalidateSpy);
    expect(invalidatedKeys).toContain(JSON.stringify(["runs"]));
    expect(invalidatedKeys).toContain(JSON.stringify(["sync-progress"]));

    unmount();
    expect(source.closed).toBe(true);
  });

  it("reports disconnected on error and schedules a reconnect", () => {
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

  it("debounces a burst of same-key events into a single invalidation", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useServerEvents(), { wrapper });
    const source = FakeEventSource.instances[0];

    act(() => {
      source.listeners.get("sync.progress")?.();
      vi.advanceTimersByTime(100);
      source.listeners.get("sync.progress")?.();
      vi.advanceTimersByTime(100);
      source.listeners.get("sync.progress")?.();
    });
    // Each event re-armed the 300ms trailing timer, so it still hasn't fired.
    expect(invalidateSpy).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    const syncProgressCalls = invalidateSpy.mock.calls.filter(
      ([filters]) => JSON.stringify((filters as { queryKey: unknown }).queryKey) === JSON.stringify(["sync-progress"]),
    );
    expect(syncProgressCalls).toHaveLength(1);
  });

  it("adds show drilldown keys to webhook.processed and library keys to sync.finished", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useServerEvents(), { wrapper });
    const source = FakeEventSource.instances[0];

    act(() => source.listeners.get("webhook.processed")?.());
    act(() => vi.advanceTimersByTime(300));
    let keys = keysInvalidated(invalidateSpy);
    expect(keys).toContain(JSON.stringify(["show-episodes"]));
    expect(keys).toContain(JSON.stringify(["show-seasons"]));

    invalidateSpy.mockClear();
    act(() => source.listeners.get("sync.finished")?.());
    act(() => vi.advanceTimersByTime(300));
    keys = keysInvalidated(invalidateSpy);
    expect(keys).toContain(JSON.stringify(["shows"]));
    expect(keys).toContain(JSON.stringify(["all-episodes"]));
    expect(keys).toContain(JSON.stringify(["movies"]));
  });

  it("resets backoff, reconnects immediately, and refreshes status when the tab becomes visible", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderHook(() => useServerEvents(), { wrapper });
    const first = FakeEventSource.instances[0];
    act(() => first.onerror?.());
    expect(FakeEventSource.instances).toHaveLength(1);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // A fresh connection is opened immediately, without waiting for backoff.
    expect(FakeEventSource.instances).toHaveLength(2);

    const keys = keysInvalidated(invalidateSpy);
    expect(keys).toContain(JSON.stringify(["status"]));
    expect(keys).toContain(JSON.stringify(["healthz"]));
  });

  it("ignores visibilitychange while hidden", () => {
    renderHook(() => useServerEvents(), { wrapper });
    expect(FakeEventSource.instances).toHaveLength(1);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("ignores a stale auth-probe result after unmount (no toast, no redirect)", async () => {
    let resolveAuth:
      | ((value: { enabled: boolean; authenticated: boolean; password_set: boolean; api_token_set: boolean }) => void)
      | undefined;
    vi.mocked(api.authStatus).mockReturnValue(
      new Promise((resolve) => {
        resolveAuth = resolve;
      }),
    );

    const { unmount } = renderHook(() => useServerEvents(), { wrapper });
    const first = FakeEventSource.instances[0];
    // Three consecutive failures trigger the auth probe.
    act(() => first.onerror?.());
    act(() => first.onerror?.());
    act(() => first.onerror?.());
    expect(api.authStatus).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      resolveAuth?.({ enabled: true, authenticated: false, password_set: true, api_token_set: false });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(redirectToLogin).not.toHaveBeenCalled();
  });
});

describe("pollInterval", () => {
  it("relaxes when connected and falls back when not", () => {
    expect(pollInterval(true, 2_000, 30_000)).toBe(30_000);
    expect(pollInterval(false, 2_000, 30_000)).toBe(2_000);
  });
});
