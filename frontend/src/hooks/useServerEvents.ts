import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, redirectToLogin } from "../api";
import { queryKeys } from "../lib/queryKeys";

/** Query keys invalidated per server event type. */
const EVENT_QUERY_KEYS: Record<string, readonly (readonly unknown[])[]> = {
  "sync.progress": [queryKeys.syncProgress, queryKeys.workStatus],
  "sync.finished": [
    queryKeys.syncProgress,
    queryKeys.workStatus,
    queryKeys.runs,
    queryKeys.recentRuns,
    queryKeys.syncActivity,
    queryKeys.status,
    // Library data + drilldowns: a finished sync can add/remove/rename rows.
    queryKeys.shows(),
    queryKeys.allEpisodes(),
    queryKeys.movies(),
    queryKeys.showSeasons(),
    queryKeys.showEpisodes(),
  ],
  "webhook.dead_letter": [queryKeys.webhookQueue, queryKeys.webhookJobs(), queryKeys.status],
  "webhook.processed": [
    queryKeys.webhookQueue,
    queryKeys.webhookJobs(),
    queryKeys.status,
    queryKeys.syncActivity,
    queryKeys.shows(),
    queryKeys.allEpisodes(),
    queryKeys.movies(),
    queryKeys.showEpisodes(),
    queryKeys.showSeasons(),
  ],
  "health.changed": [queryKeys.status, queryKeys.healthz],
};

/** Keys refreshed immediately when the tab regains visibility, since the
    browser may have silently dropped the SSE connection while backgrounded. */
const VISIBILITY_REFRESH_KEYS: readonly (readonly unknown[])[] = [
  queryKeys.status,
  queryKeys.healthz,
  queryKeys.workStatus,
  queryKeys.syncProgress,
];

const RECONNECT_DELAY_MS = 5_000;
const RECONNECT_DELAY_MAX_MS = 60_000;
// After this many consecutive failures, probe auth: an expired session makes
// EventSource fail forever (it can't see the 401), so surface a re-login.
const AUTH_PROBE_AFTER_FAILURES = 3;
// Trailing debounce: a burst of events for the same key (e.g. many
// webhook.processed in a row) collapses into a single invalidation.
const INVALIDATE_DEBOUNCE_MS = 300;

export function reconnectDelayMs(consecutiveFailures: number): number {
  const attempt = Math.max(1, consecutiveFailures);
  return Math.min(RECONNECT_DELAY_MS * 2 ** (attempt - 1), RECONNECT_DELAY_MAX_MS);
}

/**
 * Subscribes to `/api/ui/events` (SSE) and invalidates the matching React
 * Query caches as events arrive. Returns whether the stream is currently
 * connected so callers can relax their polling intervals; on any error the
 * hook reports disconnected and pages fall back to their polling cadence.
 */
export function useServerEvents(): { connected: boolean } {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failuresRef = useRef(0);

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    let source: EventSource | null = null;
    let disposed = false;
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const scheduleInvalidate = (key: readonly unknown[]): void => {
      const cacheKey = JSON.stringify(key);
      const existing = debounceTimers.get(cacheKey);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        cacheKey,
        setTimeout(() => {
          debounceTimers.delete(cacheKey);
          void queryClient.invalidateQueries({ queryKey: key as unknown[] });
        }, INVALIDATE_DEBOUNCE_MS),
      );
    };

    const probeAuth = (): void => {
      void api
        .authStatus()
        .then((status) => {
          if (disposed) return;
          if (status.enabled && !status.authenticated) {
            toast.error("Session expired — please sign in again");
            redirectToLogin();
          }
        })
        .catch(() => {
          // Server unreachable: keep backing off; nothing to surface yet.
        });
    };

    const open = (): void => {
      if (disposed) return;
      source = new EventSource("/api/ui/events");
      source.onopen = () => {
        failuresRef.current = 0;
        setConnected(true);
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (disposed) return;
        failuresRef.current += 1;
        if (failuresRef.current === AUTH_PROBE_AFTER_FAILURES) {
          probeAuth();
        }
        reconnectTimer.current = setTimeout(open, reconnectDelayMs(failuresRef.current));
      };
      for (const eventType of Object.keys(EVENT_QUERY_KEYS)) {
        source.addEventListener(eventType, () => {
          for (const key of EVENT_QUERY_KEYS[eventType]) {
            scheduleInvalidate(key);
          }
        });
      }
    };

    const reconnectNow = (): void => {
      failuresRef.current = 0;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      source?.close();
      source = null;
      open();
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") return;
      reconnectNow();
      for (const key of VISIBILITY_REFRESH_KEYS) {
        void queryClient.invalidateQueries({ queryKey: key as unknown[] });
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    open();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      debounceTimers.forEach((timer) => clearTimeout(timer));
      debounceTimers.clear();
      source?.close();
      setConnected(false);
    };
  }, [queryClient]);

  return { connected };
}

/** Pick a refetch interval: relaxed while SSE is connected, fallback when not. */
export function pollInterval(connected: boolean, fallbackMs: number, relaxedMs: number): number {
  return connected ? relaxedMs : fallbackMs;
}

/** Provided by AppLayout (single EventSource per app); pages read `connected`
    to relax their polling intervals. */
export const ServerEventsContext = createContext<{ connected: boolean }>({ connected: false });

export function useServerEventsStatus(): { connected: boolean } {
  return useContext(ServerEventsContext);
}
