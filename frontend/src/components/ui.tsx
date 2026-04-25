import { formatLogExtras } from "../lib/logExtras";

export function StatusPill({ status }: { status: string }): JSX.Element {
  return <span className={`status-pill ${status.toLowerCase()}`}>{status}</span>;
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
    <div className="pager">
      <span>
        {total === 0 ? "0 results" : `${start}-${end} of ${total}`}
      </span>
      <button type="button" className="secondary" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Prev
      </button>
      <button type="button" className="secondary" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next
      </button>
    </div>
  );
}

export function LogViewerRow({ entry }: { entry: Record<string, unknown> }): JSX.Element {
  const lvl = String(entry.level ?? "?");
  const levelClass = `log-lvl-${lvl.toLowerCase()}`;
  const extra = formatLogExtras(entry);
  return (
    <div className={`log-row ${levelClass}`}>
      <div className="log-row-main">
        <span className="log-ts">{String(entry.ts ?? "")}</span>
        <span className="log-level-badge">{lvl}</span>
        <span className="log-logger">{String(entry.logger ?? "")}</span>
        <span className="log-message">{String(entry.message ?? "")}</span>
      </div>
      {extra ? <pre className="log-row-extra">{extra}</pre> : null}
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
    <div className="card error-card">
      <div className="row">
        <strong>Diagnostics</strong>
        <button type="button" className="secondary" onClick={clear}>
          Dismiss
        </button>
      </div>
      <div className="muted">{message}</div>
      {context ? <pre>{context}</pre> : null}
    </div>
  );
}
