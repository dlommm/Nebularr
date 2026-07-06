import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** Query keys invalidated per server event type. */
const EVENT_QUERY_KEYS: Record<string, string[][]> = {
  "sync.progress": [["sync-progress"], ["work-status"]],
  "sync.finished": [["sync-progress"], ["work-status"], ["runs"], ["recent-runs"], ["sync-activity"], ["status"]],
  "webhook.dead_letter": [["webhook-queue"], ["webhook-jobs"], ["status"]],
  "webhook.processed": [
    ["webhook-queue"],
    ["webhook-jobs"],
    ["status"],
    ["sync-activity"],
    ["shows"],
    ["all-episodes"],
    ["movies"],
  ],
  "health.changed": [["status"], ["healthz"]],
};

const RECONNECT_DELAY_MS = 5_000;

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

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    let source: EventSource | null = null;
    let disposed = false;

    const open = (): void => {
      if (disposed) return;
      source = new EventSource("/api/ui/events");
      source.onopen = () => setConnected(true);
      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (!disposed) {
          reconnectTimer.current = setTimeout(open, RECONNECT_DELAY_MS);
        }
      };
      for (const eventType of Object.keys(EVENT_QUERY_KEYS)) {
        source.addEventListener(eventType, () => {
          for (const key of EVENT_QUERY_KEYS[eventType]) {
            void queryClient.invalidateQueries({ queryKey: key });
          }
        });
      }
    };

    open();
    return () => {
      disposed = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
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
