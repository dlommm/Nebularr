import { formatLogExtras } from "../lib/logExtras";
import { StatusBadge } from "./nebula/StatusBadge";
import { Button } from "@/components/ui/button";
import { GlassCard, CardContent, CardHeader, CardTitle } from "./nebula/GlassCard";

export function StatusPill({ status }: { status: string }): JSX.Element {
  return <StatusBadge status={status} className="status-pill-legacy" />;
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

export function LogViewerRow({ entry }: { entry: Record<string, unknown> }): JSX.Element {
  const lvl = String(entry.level ?? "?");
  const levelClass = `log-lvl-${lvl.toLowerCase()}`;
  const extra = formatLogExtras(entry);
  return (
    <div className={`log-row ${levelClass} text-foreground`}>
      <div className="log-row-main">
        <span className="log-ts text-muted-foreground">{String(entry.ts ?? "")}</span>
        <span className="log-level-badge">{lvl}</span>
        <span className="log-logger text-cyan-200/80">{String(entry.logger ?? "")}</span>
        <span className="log-message text-foreground">{String(entry.message ?? "")}</span>
      </div>
      {extra ? <pre className="log-row-extra text-muted-foreground">{extra}</pre> : null}
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
    <GlassCard className="mb-4 border-rose-500/40 bg-rose-950/20" glow="none">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm text-rose-100">Diagnostics</CardTitle>
        <Button type="button" variant="secondary" size="sm" onClick={clear}>
          Dismiss
        </Button>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-rose-100/90">{message}</p>
        {context ? <pre className="mt-2 max-h-40 overflow-auto text-xs text-rose-200/80">{context}</pre> : null}
      </CardContent>
    </GlassCard>
  );
}
