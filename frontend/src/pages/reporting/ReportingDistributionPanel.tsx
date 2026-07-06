import { memo, useDeferredValue, useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  const { total, max, pieData } = useMemo(() => {
    const totalValue = filteredRows.reduce((acc, row) => acc + Number(row.value ?? 0), 0);
    const maxValue = filteredRows.reduce((acc, row) => Math.max(acc, Number(row.value ?? 0)), 0);
    const pie = filteredRows.slice(0, 12).map((row, idx) => ({
      name: String(row.label ?? "unknown").slice(0, 32),
      value: Number(row.value ?? 0),
      fill: chartColor(idx),
    }));
    return { total: totalValue, max: maxValue, pieData: pie };
  }, [filteredRows]);

  return (
    <div className="col-span-12 min-w-0 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)] lg:col-span-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{panel.title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 w-44"
            placeholder="Filter this chart…"
            value={panelFilter}
            onChange={(event) => onPanelFilterChange(panelStateKey, event.target.value)}
          />
          <span className="text-xs text-muted-foreground">
            {filteredRows.length} / {rows.length}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            title="Download CSV"
            onClick={() => {
              window.location.href = exportUrl;
            }}
          >
            CSV
          </Button>
        </div>
      </div>
      {pieData.length > 0 ? (
        <div className="mb-4 h-56 w-full rounded-xl border border-border bg-muted/30 px-1 py-2">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={44} outerRadius={72} paddingAngle={2}>
                {pieData.map((entry, i) => (
                  <Cell key={entry.name + i} fill={entry.fill} stroke="var(--border)" />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                }}
                labelStyle={{ color: "var(--popover-foreground)" }}
                itemStyle={{ color: "var(--popover-foreground)" }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {filteredRows.slice(0, 20).map((row, idx) => {
          const label = String(row.label ?? "unknown");
          const value = Number(row.value ?? 0);
          const pct = total > 0 ? (value / total) * 100 : 0;
          const widthPct = max > 0 ? (value / max) * 100 : 0;
          return (
            <div key={`${panel.id}-${label}-${idx}`}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-foreground" title={label}>
                  {label}
                </span>
                <span className="flex shrink-0 items-baseline gap-2">
                  <span className="text-xs font-medium tabular-nums text-foreground">{value.toLocaleString()}</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(2, widthPct)}%` }}
                />
              </div>
            </div>
          );
        })}
        {filteredRows.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No rows match the current filters.</div>
        ) : null}
      </div>
    </div>
  );
}

export const ReportingDistributionPanel = memo(ReportingDistributionPanelImpl);
