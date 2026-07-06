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
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
      <span>
        {total === 0 ? "0 results" : `${start}-${end} of ${total}`}
      </span>
      <Button type="button" variant="secondary" size="sm" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Prev
      </Button>
      <Button type="button" variant="secondary" size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
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

export function LogViewerRow({ entry }: { entry: Record<string, unknown> }): JSX.Element {
  const lvl = String(entry.level ?? "?");
  const levelClass = LOG_LEVEL_TEXT[lvl.toLowerCase()] ?? "text-muted-foreground";
  const extra = formatLogExtras(entry);
  return (
    <div className="border-b border-border px-1 py-1.5 text-foreground last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{String(entry.ts ?? "")}</span>
        <span className={`shrink-0 rounded px-1.5 text-[10px] font-semibold uppercase ${levelClass}`}>{lvl}</span>
        <span className="min-w-0 break-all text-[11px] text-primary">{String(entry.logger ?? "")}</span>
        <span className="min-w-[200px] flex-1 break-words">{String(entry.message ?? "")}</span>
      </div>
      {extra ? (
        <pre className="mt-1.5 whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
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
    <GlassCard className="mb-4 border-critical/40 bg-critical/5">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm text-critical">Diagnostics</CardTitle>
        <Button type="button" variant="secondary" size="sm" onClick={clear}>
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
