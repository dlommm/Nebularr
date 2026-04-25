import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { LogViewerRow } from "../components/ui";
import { GlassCard, CardContent, CardHeader, CardTitle, CardDescription } from "../components/nebula/GlassCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

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
    <GlassCard>
      <CardHeader>
        <CardTitle className="text-lg">Application logs</CardTitle>
        <CardDescription>
          In-memory lines on this instance (up to {uiLogs.data?.capacity?.toLocaleString() ?? "…"}). arrsync.* loggers — not
          uvicorn access. tune level under Integrations → application logging.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Checkbox id="logs-pause" checked={logsPaused} onCheckedChange={(c) => setLogsPaused(c === true)} />
            <Label htmlFor="logs-pause" className="text-sm text-muted-foreground">
              Pause live updates
            </Label>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => void queryClient.invalidateQueries({ queryKey: ["ui-logs"] })}>
            Refresh
          </Button>
          <span className="text-xs text-muted-foreground">
            {uiLogs.data?.items?.length ?? 0} line{(uiLogs.data?.items?.length ?? 0) === 1 ? "" : "s"}
          </span>
        </div>
        <div className="log-viewport max-h-[min(70vh,720px)] overflow-y-auto rounded-xl border border-white/10 bg-[#0a0e18] p-2 font-mono text-xs">
          {(uiLogs.data?.items ?? []).map((entry, idx) => (
            <LogViewerRow key={`${String(entry.ts)}-${idx}`} entry={entry} />
          ))}
          <div ref={logsEndRef} />
        </div>
      </CardContent>
    </GlassCard>
  );
}
