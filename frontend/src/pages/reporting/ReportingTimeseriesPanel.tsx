import { memo, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtSize } from "../../hooks";
import type { ReportingPanel } from "../../types";
import { chartColor } from "./reportingShared";
import { SectionHead } from "@/components/ns/Page";

type ReportingTimeseriesPanelProps = {
  panel: ReportingPanel;
};

/** Rows arrive as `{ts, label, value}`; pivot to one datum per timestamp with
    a series per label so recharts can stack the areas. */
function pivotRows(rows: Array<Record<string, unknown>>): {
  data: Array<Record<string, unknown>>;
  labels: string[];
} {
  const labels: string[] = [];
  const byTs = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const ts = String(row.ts ?? "");
    const label = String(row.label ?? "value");
    if (!labels.includes(label)) labels.push(label);
    const datum = byTs.get(ts) ?? { ts };
    datum[label] = Number(row.value ?? 0);
    byTs.set(ts, datum);
  }
  return { data: [...byTs.values()], labels };
}

function ReportingTimeseriesPanelImpl({ panel }: ReportingTimeseriesPanelProps): JSX.Element {
  const rows = useMemo(() => (panel.rows ?? []) as Array<Record<string, unknown>>, [panel.rows]);
  const { data, labels } = useMemo(() => pivotRows(rows), [rows]);
  const looksLikeBytes = /bytes|size|storage/i.test(panel.title);
  const formatValue = (value: number): string =>
    looksLikeBytes ? fmtSize(value) : value.toLocaleString();

  return (
    <section className="col-span-12 min-w-0" aria-label={panel.title}>
      <SectionHead title={panel.title} aside={`${data.length} points`} />
      {data.length === 0 ? (
        <div className="border-y border-border py-10 text-sm text-muted-foreground">
          No snapshots yet — the daily stats job (or the first successful full sync) populates this chart.
        </div>
      ) : (
        <div className="mt-4 h-72 w-full">
          <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 288 }}>
            <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="ts" stroke="var(--subtle-foreground)" fontSize={11} fontFamily="var(--font-mono)" tickLine={false} axisLine={false} />
              <YAxis
                stroke="var(--subtle-foreground)"
                fontSize={11}
                fontFamily="var(--font-mono)"
                tickLine={false}
                axisLine={false}
                width={70}
                tickFormatter={(value: number) => formatValue(value)}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                }}
                labelStyle={{ color: "var(--popover-foreground)" }}
                itemStyle={{ color: "var(--popover-foreground)" }}
                formatter={(value) => (typeof value === "number" ? formatValue(value) : String(value ?? ""))}
              />
              {labels.map((label, idx) => (
                <Area
                  key={label}
                  type="monotone"
                  dataKey={label}
                  stackId="total"
                  stroke={chartColor(idx)}
                  fill={chartColor(idx)}
                  fillOpacity={0.12}
                  strokeWidth={2.5}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

export const ReportingTimeseriesPanel = memo(ReportingTimeseriesPanelImpl);
