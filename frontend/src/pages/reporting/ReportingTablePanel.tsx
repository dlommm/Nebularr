import { memo, useDeferredValue, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ReportingPanel } from "../../types";
import { MultiSelectFilter } from "../../components/nebula/MultiSelectFilter";
import {
  MAX_UNLIMITED_ROWS,
  rowMatchesFilters,
  rowPassesSeasonFilter,
  stringifyCellValue,
  tokenizeFilter,
} from "./reportingShared";

type ReportingTablePanelProps = {
  panel: ReportingPanel;
  panelStateKey: string;
  sharedTerms: string[];
  ignoreSeasonZero: boolean;
  panelFilter: string;
  onPanelFilterChange: (panelStateKey: string, value: string) => void;
  pageSize: number;
  onPageSizeChange: (value: number) => void;
  offset: number;
  onOffsetChange: (panelStateKey: string, value: number) => void;
  /** Page-level record keyed `${panelStateKey}:${column}`; indexed directly so
      the same object reference can be shared across memoized panels. */
  columnFilters: Record<string, string[]>;
  onColumnFilterChange: (panelStateKey: string, column: string, next: string[]) => void;
  exportUrl: string;
};

function ReportingTablePanelImpl({
  panel,
  panelStateKey,
  sharedTerms,
  ignoreSeasonZero,
  panelFilter,
  onPanelFilterChange,
  pageSize,
  onPageSizeChange,
  offset: requestedOffset,
  onOffsetChange,
  columnFilters,
  onColumnFilterChange,
  exportUrl,
}: ReportingTablePanelProps): JSX.Element {
  const deferredPanelFilter = useDeferredValue(panelFilter);
  const rows = useMemo(() => (panel.rows ?? []) as Array<Record<string, unknown>>, [panel.rows]);

  const termFilteredRows = useMemo(() => {
    const terms = [...sharedTerms, ...tokenizeFilter(deferredPanelFilter)];
    return rows.filter((row) => rowPassesSeasonFilter(row, ignoreSeasonZero) && rowMatchesFilters(row, terms));
  }, [rows, sharedTerms, deferredPanelFilter, ignoreSeasonZero]);

  const columns = useMemo(
    () => (termFilteredRows.length > 0 ? Object.keys(termFilteredRows[0]) : rows.length > 0 ? Object.keys(rows[0]) : []),
    [termFilteredRows, rows],
  );

  const columnOptions = useMemo(() => {
    const options: Record<string, string[]> = {};
    for (const column of columns) {
      const counts = new Map<string, number>();
      for (const row of termFilteredRows) {
        const value = stringifyCellValue(row[column]);
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      options[column] = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 250)
        .map(([value]) => value);
    }
    return options;
  }, [columns, termFilteredRows]);

  const filteredRows = useMemo(() => {
    const active = columns
      .map((column) => ({
        column,
        values: (columnFilters[`${panelStateKey}:${column}`] ?? [])
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      }))
      .filter((entry) => entry.values.length > 0);
    if (active.length === 0) return termFilteredRows;
    return termFilteredRows.filter((row) =>
      active.every(({ column, values }) => values.includes(stringifyCellValue(row[column]).toLowerCase())),
    );
  }, [termFilteredRows, columns, columnFilters, panelStateKey]);

  const unlimited = pageSize <= 0;
  const total = filteredRows.length;
  const offset = unlimited ? 0 : Math.min(requestedOffset, Math.max(0, total - 1));
  const effectivePageSize = unlimited ? Math.min(total, MAX_UNLIMITED_ROWS) : pageSize;
  const end = unlimited ? effectivePageSize : Math.min(offset + effectivePageSize, total);
  const pagedRows = filteredRows.slice(offset, end);
  const capped = unlimited && total > MAX_UNLIMITED_ROWS;

  return (
    <div className="col-span-12 min-w-0 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{panel.title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 w-52"
            placeholder="Filter this table…"
            value={panelFilter}
            onChange={(event) => onPanelFilterChange(panelStateKey, event.target.value)}
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Page size</span>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={25}>25</option>
              <option value={40}>40</option>
              <option value={50}>50</option>
              <option value={75}>75</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={0}>All (first {MAX_UNLIMITED_ROWS})</option>
            </select>
          </label>
          <span className="text-xs tabular-nums text-muted-foreground">
            {total === 0 ? "0 rows" : `${offset + 1}–${end} of ${total}`} · {rows.length} raw
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={offset <= 0 || unlimited}
              onClick={() => onOffsetChange(panelStateKey, Math.max(0, offset - effectivePageSize))}
            >
              Prev
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={unlimited || offset + effectivePageSize >= total}
              onClick={() => onOffsetChange(panelStateKey, offset + effectivePageSize)}
            >
              Next
            </Button>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            title="Download CSV"
            onClick={() => {
              window.location.href = exportUrl;
            }}
          >
            Export CSV
          </Button>
        </div>
      </div>
      {capped ? (
        <div className="mb-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          Showing the first {MAX_UNLIMITED_ROWS.toLocaleString()} of {total.toLocaleString()} rows — use Export CSV for
          the full dataset.
        </div>
      ) : null}
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              {columns.map((column) => (
                <TableHead key={`${panel.id}-${column}`}>
                  <div className="flex items-center gap-1.5">
                    <span>{column}</span>
                    <MultiSelectFilter
                      label={column}
                      options={columnOptions[column] ?? []}
                      selected={columnFilters[`${panelStateKey}:${column}`] ?? []}
                      onChange={(next) => onColumnFilterChange(panelStateKey, column, next)}
                    />
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagedRows.map((row, idx) => (
              <TableRow key={`${panel.id}-${offset + idx}`}>
                {columns.map((column) => {
                  const rendered = stringifyCellValue(row[column]);
                  return (
                    <TableCell
                      key={`${panel.id}-${idx}-${column}`}
                      className="max-w-[420px] truncate text-xs"
                      title={rendered.length > 120 ? rendered : undefined}
                    >
                      {rendered}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
            {pagedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={Math.max(columns.length, 1)} className="py-6 text-center text-muted-foreground">
                  No rows match the current filters.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export const ReportingTablePanel = memo(ReportingTablePanelImpl);
