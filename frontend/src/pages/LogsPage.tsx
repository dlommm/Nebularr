import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { errText } from "../hooks";
import { usePageTitle } from "../hooks/usePageTitle";
import { LogViewerRow } from "../components/ui";
import { SectionCard } from "./integrations/shared";
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
    <SectionCard title="Application logs">
      <p className="-mt-2 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
        In-memory lines on this instance (up to {uiLogs.data?.capacity?.toLocaleString() ?? "…"}) at the effective level. The buffer
        attaches to the root logger, so you see the same application and library lines (<code className="font-mono text-xs">httpx</code>,{" "}
        <code className="font-mono text-xs">sqlalchemy</code>, <code className="font-mono text-xs">arrsync</code>) as the process stdout.
        Uvicorn access logs may stay stdout-only if their loggers do not propagate. Tune the level under Integrations → Logging.
      </p>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <label className="grid min-w-56 flex-[1_1_260px] gap-1 text-[11px] text-subtle-foreground">
          Filter lines
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="e.g. radarr, webhook, timeout"
            className="h-11"
            aria-label="Filter log lines"
          />
        </label>
        <label className="grid gap-1 text-[11px] text-subtle-foreground">
          Minimum level
          <select
            className="min-h-11 rounded-sm border border-border bg-muted px-2.5 text-sm text-foreground"
            value={minLevel}
            onChange={(event) => setMinLevel(event.target.value)}
            aria-label="Minimum log level"
          >
            <option value="all">All</option>
            <option value="debug">Debug and above</option>
            <option value="info">Info and above</option>
            <option value="warning">Warning and above</option>
            <option value="error">Error and above</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <div className="flex min-h-11 items-center gap-2">
          <Checkbox id="logs-pause" checked={logsPaused} onCheckedChange={(c) => setLogsPaused(c === true)} />
          <Label htmlFor="logs-pause" className="text-sm font-normal">
            Pause live updates
          </Label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => void queryClient.invalidateQueries({ queryKey: ["ui-logs"] })}>
            Refresh
          </Button>
          <Button type="button" variant="outline" className="min-h-11" onClick={downloadLogs} disabled={filtered.length === 0}>
            Download
          </Button>
          <Button type="button" variant="ghost" className="min-h-11" onClick={() => void copyLogs()} disabled={filtered.length === 0}>
            Copy
          </Button>
        </div>
      </div>
      {uiLogs.isError ? <p className="text-sm text-critical">Could not load logs: {errText(uiLogs.error)}</p> : null}
      <div
        ref={logsScrollRef}
        onScroll={onLogsScroll}
        role="log"
        aria-label="Application log"
        className="well max-h-[min(70vh,720px)] overflow-y-auto py-3 font-mono text-[12.5px]"
      >
        {uiLogs.isLoading && items.length === 0 ? <p className="m-0 px-4 py-2 text-sm text-muted-foreground">Loading…</p> : null}
        {items.length === 0 && !uiLogs.isLoading ? (
          <p className="m-0 px-4 py-2 text-sm text-muted-foreground">
            No log lines in the ring buffer yet.
            {eff
              ? ` Effective level is ${eff} (set under Integrations → Logging). Only messages at that level and above are shown.`
              : null}
          </p>
        ) : null}
        {items.length > 0 && filtered.length === 0 ? (
          <p className="m-0 px-4 py-2 text-sm text-muted-foreground">No lines match the current filter.</p>
        ) : null}
        {filtered.map((entry, idx) => (
          <LogViewerRow key={`${String(entry.ts)}-${idx}`} entry={entry} />
        ))}
        <div ref={logsEndRef} />
      </div>
      <p className="text-[13px] text-subtle-foreground">
        {filterActive
          ? `Showing ${filtered.length} of ${items.length} line${items.length === 1 ? "" : "s"}`
          : `Showing ${items.length} line${items.length === 1 ? "" : "s"}`}
        {logsPaused ? " · paused" : " · following"}
      </p>
    </SectionCard>
  );
}
