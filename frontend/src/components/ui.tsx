import { formatLogExtras } from "../lib/logExtras";
import { StatusBadge } from "./nebula/StatusBadge";
import { Button } from "@/components/ui/button";
import { GlassCard, CardContent, CardHeader, CardTitle } from "./nebula/GlassCard";

export function StatusPill({ status }: { status: string }): JSX.Element {
  return <StatusBadge status={status} />;
}

export function Pagination({
  total,
  offset,
  limit,
  onChange,
}: {
  total: number;
  offset: number;
  limit: number;
  onChange: (nextOffset: number) => void;
}): JSX.Element {
  const start = Math.min(offset + 1, total);
  const end = Math.min(offset + limit, total);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-2 text-[13px] text-muted-foreground">
      <span>
        {total === 0 ? "0 results" : `${start}-${end} of ${total}`}
      </span>
      <Button type="button" variant="outline" size="sm" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Prev
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next
      </Button>
    </div>
  );
}

const LOG_LEVEL_TEXT: Record<string, string> = {
  debug: "text-muted-foreground",
  info: "text-ok",
  warning: "text-warn",
  error: "text-critical",
  critical: "text-critical",
};

/** "14:52:07" for an ISO timestamp; anything unparseable is shown as-is. */
function logClock(ts: unknown): string {
  const raw = String(ts ?? "");
  const d = new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) return raw;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function LogViewerRow({ entry }: { entry: Record<string, unknown> }): JSX.Element {
  const lvl = String(entry.level ?? "?");
  const levelClass = LOG_LEVEL_TEXT[lvl.toLowerCase()] ?? "text-muted-foreground";
  const extra = formatLogExtras(entry);
  return (
    <div className="px-4 py-0.5 leading-[1.75] text-foreground transition-colors hover:bg-muted/50">
      <div className="grid grid-cols-[auto_4.5rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[auto_4.5rem_minmax(0,12rem)_minmax(0,1fr)]">
        <span className="tabular-nums whitespace-nowrap text-subtle-foreground" title={String(entry.ts ?? "")}>
          {logClock(entry.ts)}
        </span>
        <span className={`font-medium uppercase ${levelClass}`}>{lvl}</span>
        <span className="hidden truncate text-subtle-foreground sm:block" title={String(entry.logger ?? "")}>
          {String(entry.logger ?? "")}
        </span>
        <span className="min-w-0 break-words">{String(entry.message ?? "")}</span>
      </div>
      {extra ? (
        <pre className="my-1 ml-0 whitespace-pre-wrap border-l border-border pl-3 text-[11px] text-muted-foreground sm:ml-[calc(4.5rem+1rem)]">
          {extra}
        </pre>
      ) : null}
    </div>
  );
}

export function DiagnosticsPanel({
  message,
  context,
  clear,
}: {
  message: string | null;
  context: string | null;
  clear: () => void;
}): JSX.Element | null {
  if (!message) return null;
  return (
    <GlassCard className="mb-4 border-critical/40 bg-transparent">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm text-critical">Diagnostics</CardTitle>
        <Button type="button" variant="outline" size="sm" onClick={clear}>
          Dismiss
        </Button>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-foreground/90">{message}</p>
        {context ? <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">{context}</pre> : null}
      </CardContent>
    </GlassCard>
  );
}
