import { memo, useDeferredValue, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { SectionHead } from "@/components/ns/Page";
import type { ReportingPanel } from "../../types";
import {
  chartColor,
  rowMatchesFilters,
  rowPassesSeasonFilter,
  tokenizeFilter,
} from "./reportingShared";

type ReportingDistributionPanelProps = {
  panel: ReportingPanel;
  panelStateKey: string;
  sharedTerms: string[];
  ignoreSeasonZero: boolean;
  panelFilter: string;
  onPanelFilterChange: (panelStateKey: string, value: string) => void;
  exportUrl: string;
};

function ReportingDistributionPanelImpl({
  panel,
  panelStateKey,
  sharedTerms,
  ignoreSeasonZero,
  panelFilter,
  onPanelFilterChange,
  exportUrl,
}: ReportingDistributionPanelProps): JSX.Element {
  const deferredPanelFilter = useDeferredValue(panelFilter);
  const rows = useMemo(() => (panel.rows ?? []) as Array<Record<string, unknown>>, [panel.rows]);

  const filteredRows = useMemo(() => {
    const terms = [...sharedTerms, ...tokenizeFilter(deferredPanelFilter)];
    return rows.filter((row) => rowPassesSeasonFilter(row, ignoreSeasonZero) && rowMatchesFilters(row, terms));
  }, [rows, sharedTerms, deferredPanelFilter, ignoreSeasonZero]);

  const { total, max, bands } = useMemo(() => {
    const totalValue = filteredRows.reduce((acc, row) => acc + Number(row.value ?? 0), 0);
    const maxValue = filteredRows.reduce((acc, row) => Math.max(acc, Number(row.value ?? 0)), 0);
    // The band shows the top five (one per chart colour); everything after folds into "other" so the
    // strip always adds up to the whole.
    const top = filteredRows.slice(0, 5).map((row, idx) => ({
      name: String(row.label ?? "unknown"),
      value: Number(row.value ?? 0),
      color: chartColor(idx),
    }));
    const rest = totalValue - top.reduce((acc, band) => acc + band.value, 0);
    if (rest > 0) top.push({ name: "other", value: rest, color: "var(--muted)" });
    return { total: totalValue, max: maxValue, bands: top };
  }, [filteredRows]);
  const pctOf = (value: number): number => (total > 0 ? (value / total) * 100 : 0);

  return (
    <section className="col-span-12 min-w-0 lg:col-span-6" aria-label={panel.title}>
      <SectionHead
        title={panel.title}
        aside={
          <div className="flex flex-wrap items-center gap-3">
            <Input
              className="h-9 w-44"
              placeholder="Filter this chart…"
              aria-label={`Filter ${panel.title}`}
              value={panelFilter}
              onChange={(event) => onPanelFilterChange(panelStateKey, event.target.value)}
            />
            <span className="tabular-nums">
              {filteredRows.length} / {rows.length}
            </span>
            <a href={exportUrl} title="Download CSV" className="border-b border-input py-2 text-foreground hover:border-foreground">
              CSV
            </a>
          </div>
        }
      />
      {bands.length > 0 && total > 0 ? (
        <div
          className="mt-4 flex h-11 gap-0.5"
          role="img"
          aria-label={`${panel.title}: ${bands.map((band) => `${band.name} ${pctOf(band.value).toFixed(0)}%`).join(", ")}`}
        >
          {bands.map((band, idx) => (
            <span
              key={`${band.name}-${idx}`}
              className="min-w-0.5 origin-left animate-grow-x"
              style={{ flex: `${band.value} 1 0`, background: band.color, animationDelay: `${100 + idx * 90}ms` }}
              title={`${band.name}: ${band.value.toLocaleString()}`}
            />
          ))}
        </div>
      ) : null}
      <ul className="mt-5">
        {filteredRows.slice(0, 20).map((row, idx) => {
          const label = String(row.label ?? "unknown");
          const value = Number(row.value ?? 0);
          const widthPct = max > 0 ? (value / max) * 100 : 0;
          return (
            <li key={`${panel.id}-${label}-${idx}`} className="border-t border-border py-2.5 last:border-b">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span aria-hidden className="size-2 shrink-0" style={{ background: idx < 5 ? chartColor(idx) : "var(--muted)" }} />
                  <span className="truncate" title={label}>
                    {label}
                  </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
                  <span>{value.toLocaleString()}</span>
                  <span className="w-12 text-right text-xs text-subtle-foreground">{pctOf(value).toFixed(1)}%</span>
                </span>
              </div>
              <div className="mt-1.5 h-0.5 w-full bg-border">
                <div className="h-full bg-signal" style={{ width: `${Math.max(1, widthPct)}%` }} />
              </div>
            </li>
          );
        })}
        {filteredRows.length === 0 ? (
          <li className="border-t border-border py-6 text-sm text-muted-foreground">No rows match the current filters.</li>
        ) : null}
      </ul>
    </section>
  );
}

export const ReportingDistributionPanel = memo(ReportingDistributionPanelImpl);
