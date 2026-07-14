import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { errText } from "../hooks";
import { usePageTitle } from "../hooks/usePageTitle";
import { LogViewerRow } from "../components/ui";
import { GlassCard, CardContent, CardHeader, CardTitle, CardDescription } from "../components/nebula/GlassCard";
import type { UiLogEntry } from "../types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const LEVEL_RANK: Record<string, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  critical: 50,
};

function entryText(entry: UiLogEntry): string {
  const level = String(entry.level ?? "?").toUpperCase();
  return `${String(entry.ts ?? "")} ${level} ${String(entry.logger ?? "")} ${String(entry.message ?? "")}`;
}

export function LogsPage(): JSX.Element {
  usePageTitle("Logs");
  const queryClient = useQueryClient();
  const [logsPaused, setLogsPaused] = useState(false);
  const [minLevel, setMinLevel] = useState("all");
  const [search, setSearch] = useState("");
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const logsScrollRef = useRef<HTMLDivElement | null>(null);
  // Stick-to-bottom: only follow new lines while the user is already at the
  // bottom, so scrolling up to read older lines isn't yanked back every poll.
  const stickToBottomRef = useRef(true);
  const uiLogs = useQuery({
    queryKey: ["ui-logs"],
    queryFn: () => api.uiLogs(500),
    refetchInterval: logsPaused ? false : 2500,
  });
  const items = useMemo(() => uiLogs.data?.items ?? [], [uiLogs.data?.items]);
  const eff = uiLogs.data?.effective_level;

  const filtered = useMemo(() => {
    const minRank = minLevel === "all" ? 0 : (LEVEL_RANK[minLevel] ?? 0);
    const query = search.trim().toLowerCase();
    return items.filter((entry) => {
      if (minRank > 0) {
        const rank = LEVEL_RANK[String(entry.level ?? "").toLowerCase()] ?? 0;
        if (rank < minRank) return false;
      }
      return !query || entryText(entry).toLowerCase().includes(query);
    });
  }, [items, minLevel, search]);
  const filterActive = minLevel !== "all" || search.trim() !== "";

  useEffect(() => {
    if (logsPaused || !stickToBottomRef.current || !logsEndRef.current) return;
    logsEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [logsPaused, filtered]);

  const onLogsScroll = (): void => {
    const el = logsScrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const downloadLogs = (): void => {
    const blob = new Blob([filtered.map(entryText).join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nebularr-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const copyLogs = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(filtered.map(entryText).join("\n"));
      toast.success(`Copied ${filtered.length} log line${filtered.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  return (
    <GlassCard>
      <CardHeader>
        <CardTitle className="text-lg">Application logs</CardTitle>
        <CardDescription>
          In-memory lines on this instance (up to {uiLogs.data?.capacity?.toLocaleString() ?? "…"}) at the effective level
          below. The buffer attaches to the root logger, so you should see the same <strong className="text-foreground/90">application
          and library</strong> log lines (for example <code className="rounded bg-muted px-1">httpx</code>,{" "}
          <code className="rounded bg-muted px-1">sqlalchemy</code>, <code className="rounded bg-muted px-1">arrsync</code>) that
          appear in the process stdout. <strong className="text-foreground/90">Uvicorn access logs</strong> may still be stdout-only
          if their loggers do not propagate. Tune level under Integrations → application logging.
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
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Level
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={minLevel}
              onChange={(event) => setMinLevel(event.target.value)}
              aria-label="Minimum log level"
            >
              <option value="all">All</option>
              <option value="debug">Debug+</option>
              <option value="info">Info+</option>
              <option value="warning">Warning+</option>
              <option value="error">Error+</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter lines…"
            className="h-9 w-56"
            aria-label="Filter log lines"
          />
          <Button type="button" variant="secondary" size="sm" onClick={() => void queryClient.invalidateQueries({ queryKey: ["ui-logs"] })}>
            Refresh
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={downloadLogs} disabled={filtered.length === 0}>
            Download
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void copyLogs()} disabled={filtered.length === 0}>
            Copy
          </Button>
          <span className="text-xs text-muted-foreground">
            {filterActive
              ? `${filtered.length} of ${items.length} line${items.length === 1 ? "" : "s"}`
              : `${items.length} line${items.length === 1 ? "" : "s"}`}
          </span>
        </div>
        {uiLogs.isError ? (
          <p className="text-sm text-critical">Could not load logs: {errText(uiLogs.error)}</p>
        ) : null}
        <div
          ref={logsScrollRef}
          onScroll={onLogsScroll}
          className="max-h-[min(70vh,720px)] overflow-y-auto rounded-[10px] border border-border bg-card p-2 font-mono text-xs"
        >
          {uiLogs.isLoading && items.length === 0 ? (
            <p className="m-0 px-1 py-2 text-sm text-muted-foreground">Loading…</p>
          ) : null}
          {items.length === 0 && !uiLogs.isLoading ? (
            <p className="m-0 px-1 py-2 text-sm text-muted-foreground">
              No log lines in the ring buffer yet.
              {eff
                ? ` Effective level is ${eff} (set under Integrations → application logging). Only messages at that level and above are shown.`
                : null}
            </p>
          ) : null}
          {items.length > 0 && filtered.length === 0 ? (
            <p className="m-0 px-1 py-2 text-sm text-muted-foreground">No lines match the current filter.</p>
          ) : null}
          {filtered.map((entry, idx) => (
            <LogViewerRow key={`${String(entry.ts)}-${idx}`} entry={entry} />
          ))}
          <div ref={logsEndRef} />
        </div>
      </CardContent>
    </GlassCard>
  );
}
