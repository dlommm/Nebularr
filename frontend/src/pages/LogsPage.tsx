import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { LogViewerRow } from "../components/ui";

export function LogsPage(): JSX.Element {
  usePageTitle("Logs");
  const queryClient = useQueryClient();
  const [logsPaused, setLogsPaused] = useState(false);
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const uiLogs = useQuery({
    queryKey: ["ui-logs"],
    queryFn: () => api.uiLogs(500),
    refetchInterval: logsPaused ? false : 2500,
  });

  useEffect(() => {
    if (logsPaused || !logsEndRef.current) return;
    logsEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [logsPaused, uiLogs.data?.items]);

  return (
    <div className="card">
      <h3>Application logs</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Recent log lines captured in memory on this instance (up to {uiLogs.data?.capacity?.toLocaleString() ?? "…"} lines). Shows
        loggers under the application namespace (e.g. arrsync.*), not uvicorn access logs. For full history use container or
        process logs. Set level under Integrations → Application logging.
      </p>
      <div className="row mt8">
        <label className="pill">
          <input type="checkbox" checked={logsPaused} onChange={(event) => setLogsPaused(event.target.checked)} />
          pause live updates
        </label>
        <button type="button" className="secondary" onClick={() => void queryClient.invalidateQueries({ queryKey: ["ui-logs"] })}>
          Refresh now
        </button>
        <span className="muted">
          showing {uiLogs.data?.items?.length ?? 0} line{(uiLogs.data?.items?.length ?? 0) === 1 ? "" : "s"}
        </span>
      </div>
      <div className="log-viewport mt8">
        {(uiLogs.data?.items ?? []).map((entry, idx) => (
          <LogViewerRow key={`${String(entry.ts)}-${idx}`} entry={entry} />
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
