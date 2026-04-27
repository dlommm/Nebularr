import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { api } from "../api";
import { fmtDate, useLocalStorageState } from "../hooks";
import { usePageTitle } from "../hooks/usePageTitle";
import type { ReportingPanel } from "../types";

export function ReportingPage(): JSX.Element {
  usePageTitle("Reporting");
  const [reportingDashboardKey, setReportingDashboardKey] = useLocalStorageState<string>(
    "nebularr.reporting.dashboard",
    "overview",
  );
  const [reportingGlobalFilter, setReportingGlobalFilter] = useLocalStorageState<string>(
    "nebularr.reporting.global-filter",
    "",
  );
  const [reportingDashboardFilters, setReportingDashboardFilters] = useLocalStorageState<Record<string, string>>(
    "nebularr.reporting.dashboard-filters",
    {},
  );
  const [reportingInstance, setReportingInstance] = useLocalStorageState<string>("nebularr.reporting.instance", "");
  const [reportingLimit, setReportingLimit] = useLocalStorageState<number>("nebularr.reporting.limit", 200);
  const [reportingIgnoreSeasonZero, setReportingIgnoreSeasonZero] = useLocalStorageState<boolean>(
    "nebularr.reporting.ignore-season-zero",
    false,
  );
  const [reportingTablePageSize, setReportingTablePageSize] = useLocalStorageState<number>(
    "nebularr.reporting.table.page-size",
    10,
  );
  const [reportingTableOffsets, setReportingTableOffsets] = useState<Record<string, number>>({});
  const [reportingPanelFilters, setReportingPanelFilters] = useState<Record<string, string>>({});
  const [reportingColumnFilters, setReportingColumnFilters] = useState<Record<string, string[]>>({});

  const reportingDashboards = useQuery({
    queryKey: ["reporting-dashboards"],
    queryFn: api.reportingDashboards,
  });
  const reportingDashboard = useQuery({
    queryKey: ["reporting-dashboard", reportingDashboardKey, reportingInstance, reportingLimit],
    queryFn: () =>
      api.reportingDashboard(reportingDashboardKey, {
        instance_name: reportingInstance,
        limit: reportingLimit,
      }),
    refetchInterval: 30_000,
  });

  const tokenizeFilter = (raw: string): string[] =>
    raw
      .toLowerCase()
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);

  const rowMatchesFilters = (row: Record<string, unknown>, terms: string[]): boolean => {
    if (terms.length === 0) return true;
    const haystack = Object.values(row)
      .map((value) => {
        if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
          return JSON.stringify(value);
        }
        return String(value ?? "");
      })
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };

  const stringifyCellValue = (value: unknown): string => {
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
      return JSON.stringify(value);
    }
    return String(value ?? "-");
  };

  const rowPassesSeasonFilter = (row: Record<string, unknown>): boolean => {
    if (!reportingIgnoreSeasonZero) return true;
    const seasonKeys = ["season_number", "season", "seasonNumber"];
    for (const key of seasonKeys) {
      if (!(key in row)) continue;
      const raw = row[key];
      const normalized = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
      if (!Number.isNaN(normalized) && normalized === 0) return false;
    }
    return true;
  };

  const reportingDashboardFilter = reportingDashboardFilters[reportingDashboardKey] ?? "";
  const reportingSharedTerms = useMemo(
    () => [...tokenizeFilter(reportingGlobalFilter), ...tokenizeFilter(reportingDashboardFilter)],
    [reportingGlobalFilter, reportingDashboardFilter],
  );
  const reportingPageSizeUnlimited = reportingTablePageSize <= 0;
  const reportingLimitUnlimited = reportingLimit <= 0;

  const rowMatchesColumnFilters = (
    row: Record<string, unknown>,
    panelStateKey: string,
    columns: string[],
  ): boolean => {
    return columns.every((column) => {
      const key = `${panelStateKey}:${column}`;
      const rawFilters = (reportingColumnFilters[key] ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean);
      if (rawFilters.length === 0) return true;
      const cellText = stringifyCellValue(row[column]).toLowerCase();
      return rawFilters.includes(cellText);
    });
  };

  useEffect(() => {
    setReportingTableOffsets({});
  }, [
    reportingDashboardKey,
    reportingInstance,
    reportingLimit,
    reportingTablePageSize,
    reportingGlobalFilter,
    reportingDashboardFilter,
    reportingPanelFilters,
    reportingColumnFilters,
  ]);

  const renderDistributionPanel = (panel: ReportingPanel): JSX.Element => {
    const rows = (panel.rows ?? []) as Array<Record<string, unknown>>;
    const panelStateKey = `${reportingDashboardKey}:${panel.id}`;
    const panelFilter = reportingPanelFilters[panelStateKey] ?? "";
    const terms = [...reportingSharedTerms, ...tokenizeFilter(panelFilter)];
    const filteredRows = rows.filter((row) => rowPassesSeasonFilter(row) && rowMatchesFilters(row, terms));
    const total = filteredRows.reduce((acc, row) => acc + Number(row.value ?? 0), 0);
    const max = filteredRows.reduce((acc, row) => Math.max(acc, Number(row.value ?? 0)), 0);
    const pieData = filteredRows.slice(0, 12).map((row, idx) => ({
      name: String(row.label ?? "unknown").slice(0, 32),
      value: Number(row.value ?? 0),
      fill: `hsl(${220 + ((idx * 19) % 100)} 70% ${52 - (idx % 5) * 4}%)`,
    }));
    return (
      <div className="card span-6 report-panel report-panel--chart" key={panel.id}>
        <div className="report-panel-head">
          <h3 className="report-panel-title">{panel.title}</h3>
          <div className="report-panel-actions">
            <input
              className="report-input report-input--narrow"
              placeholder="Filter this chart…"
              value={panelFilter}
              onChange={(event) =>
                setReportingPanelFilters((prev) => ({
                  ...prev,
                  [panelStateKey]: event.target.value,
                }))
              }
            />
            <span className="report-panel-meta">
              {filteredRows.length} / {rows.length}
            </span>
            <button
              type="button"
              className="secondary report-btn-icon"
              title="Download CSV"
              onClick={() => {
                window.location.href = api.reportingPanelExportUrl(reportingDashboardKey, panel.id, {
                  instance_name: reportingInstance,
                  limit: reportingLimit,
                });
              }}
            >
              CSV
            </button>
          </div>
        </div>
        {pieData.length > 0 ? (
          <div className="mb-4 h-56 w-full rounded-xl border border-cyan-500/15 bg-[#0a1020]/80 px-1 py-2">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={44} outerRadius={72} paddingAngle={2}>
                  {pieData.map((entry, i) => (
                    <Cell key={entry.name + i} fill={entry.fill} stroke="rgba(0,0,0,0.2)" />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#0e1630", border: "1px solid rgba(84,168,255,0.3)", borderRadius: 8 }}
                  labelStyle={{ color: "#e8f1fa" }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        ) : null}
        <div className="report-chart-body">
          {filteredRows.slice(0, 20).map((row, idx) => {
            const label = String(row.label ?? "unknown");
            const value = Number(row.value ?? 0);
            const pct = total > 0 ? (value / total) * 100 : 0;
            const widthPct = max > 0 ? (value / max) * 100 : 0;
            return (
              <div className="report-bar-row" key={`${panel.id}-${label}-${idx}`}>
                <div className="report-bar-top">
                  <span className="report-bar-label" title={label}>
                    {label}
                  </span>
                  <span className="report-bar-metric">
                    <span className="report-bar-count">{value.toLocaleString()}</span>
                    <span className="report-bar-pct">{pct.toFixed(1)}%</span>
                  </span>
                </div>
                <div className="report-bar-track">
                  <div className="report-bar-fill" style={{ width: `${Math.max(2, widthPct)}%` }} />
                </div>
              </div>
            );
          })}
          {filteredRows.length === 0 ? <div className="report-empty">No rows match the current filters.</div> : null}
        </div>
      </div>
    );
  };

  const renderTablePanel = (panel: ReportingPanel): JSX.Element => {
    const rows = (panel.rows ?? []) as Array<Record<string, unknown>>;
    const panelStateKey = `${reportingDashboardKey}:${panel.id}`;
    const panelFilter = reportingPanelFilters[panelStateKey] ?? "";
    const terms = [...reportingSharedTerms, ...tokenizeFilter(panelFilter)];
    const termFilteredRows = rows.filter((row) => rowPassesSeasonFilter(row) && rowMatchesFilters(row, terms));
    const columns =
      termFilteredRows.length > 0 ? Object.keys(termFilteredRows[0]) : rows.length > 0 ? Object.keys(rows[0]) : [];
    const columnOptions = Object.fromEntries(
      columns.map((column) => {
        const counts = new Map<string, number>();
        termFilteredRows.forEach((row) => {
          const value = stringifyCellValue(row[column]);
          counts.set(value, (counts.get(value) ?? 0) + 1);
        });
        const ranked = [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 250)
          .map(([value]) => value);
        return [column, ranked];
      }),
    ) as Record<string, string[]>;
    const filteredRows = termFilteredRows.filter((row) => rowMatchesColumnFilters(row, panelStateKey, columns));
    const total = filteredRows.length;
    const offset = Math.min(reportingTableOffsets[panelStateKey] ?? 0, Math.max(0, total - 1));
    const pageSize = reportingTablePageSize <= 0 ? total : reportingTablePageSize;
    const end = reportingTablePageSize <= 0 ? total : Math.min(offset + pageSize, total);
    const pagedRows = reportingTablePageSize <= 0 ? filteredRows : filteredRows.slice(offset, end);
    return (
      <div className="card span-12 report-panel report-panel--table" key={panel.id}>
        <div className="report-panel-head">
          <h3 className="report-panel-title">{panel.title}</h3>
          <div className="report-panel-actions report-panel-actions--wrap">
            <input
              className="report-input report-input--grow"
              placeholder="Filter this table…"
              value={panelFilter}
              onChange={(event) =>
                setReportingPanelFilters((prev) => ({
                  ...prev,
                  [panelStateKey]: event.target.value,
                }))
              }
            />
            <label className="report-inline-label">
              <span>Page size</span>
              <select value={reportingTablePageSize} onChange={(event) => setReportingTablePageSize(Number(event.target.value))}>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={25}>25</option>
                <option value={40}>40</option>
                <option value={50}>50</option>
                <option value={75}>75</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
                <option value={0}>Unlimited</option>
              </select>
            </label>
            <span className="report-panel-meta">
              {total === 0 ? "0 rows" : `${offset + 1}–${end} of ${total}`}
              {reportingPageSizeUnlimited ? " · all rows" : ""} · {rows.length} raw
            </span>
            <div className="report-pager-inline">
              <button
                type="button"
                className="secondary"
                disabled={offset <= 0 || reportingPageSizeUnlimited}
                onClick={() =>
                  setReportingTableOffsets((prev) => ({
                    ...prev,
                    [panelStateKey]: Math.max(0, (prev[panelStateKey] ?? 0) - pageSize),
                  }))
                }
              >
                Prev
              </button>
              <button
                type="button"
                className="secondary"
                disabled={reportingPageSizeUnlimited || offset + pageSize >= total}
                onClick={() =>
                  setReportingTableOffsets((prev) => ({
                    ...prev,
                    [panelStateKey]: (prev[panelStateKey] ?? 0) + pageSize,
                  }))
                }
              >
                Next
              </button>
            </div>
            <button
              type="button"
              className="secondary"
              title="Download CSV"
              onClick={() => {
                window.location.href = api.reportingPanelExportUrl(reportingDashboardKey, panel.id, {
                  instance_name: reportingInstance,
                  limit: reportingLimit,
                });
              }}
            >
              Export CSV
            </button>
          </div>
        </div>
        <div className="table-wrap report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={`${panel.id}-${column}`}>
                    <div className="report-th">
                      <span className="report-th-name">{column}</span>
                      <select
                        className="report-th-filter"
                        multiple
                        value={reportingColumnFilters[`${panelStateKey}:${column}`] ?? []}
                        onChange={(event) =>
                          setReportingColumnFilters((prev) => ({
                            ...prev,
                            [`${panelStateKey}:${column}`]: Array.from(event.target.selectedOptions, (option) => option.value),
                          }))
                        }
                      >
                        {(columnOptions[column] ?? []).map((option) => (
                          <option key={`${panelStateKey}:${column}:${option}`} value={option}>
                            {option.length > 80 ? `${option.slice(0, 80)}…` : option}
                          </option>
                        ))}
                      </select>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((row, idx) => (
                <tr key={`${panel.id}-${offset + idx}`}>
                  {columns.map((column) => {
                    const value = row[column];
                    const rendered = stringifyCellValue(value);
                    return (
                      <td key={`${panel.id}-${idx}-${column}`} className="report-td" title={rendered.length > 120 ? rendered : undefined}>
                        {rendered}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {pagedRows.length === 0 ? (
                <tr>
                  <td colSpan={Math.max(columns.length, 1)} className="report-empty-cell">
                    No rows match the current filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderReportingPanelNodes = (): JSX.Element[] => {
    const panels = reportingDashboard.data?.panels ?? [];
    const nodes: JSX.Element[] = [];
    let i = 0;
    while (i < panels.length) {
      const panel = panels[i];
      if (panel.kind === "stat") {
        const batch: ReportingPanel[] = [];
        while (i < panels.length && panels[i].kind === "stat") {
          batch.push(panels[i]);
          i += 1;
        }
        nodes.push(
          <div className="span-12 report-stat-band" key={`report-stats-${batch[0]?.id ?? i}`}>
            <div className="report-stat-grid">
              {batch.map((p) => (
                <div className="report-stat-card" key={p.id}>
                  <div className="report-stat-label">{p.title}</div>
                  <div className="report-stat-value">
                    {typeof p.value === "number" ? p.value.toLocaleString() : (p.value ?? "—")}
                  </div>
                </div>
              ))}
            </div>
          </div>,
        );
      } else if (panel.kind === "distribution") {
        nodes.push(renderDistributionPanel(panel));
        i += 1;
      } else {
        nodes.push(renderTablePanel(panel));
        i += 1;
      }
    }
    return nodes;
  };

  return (
    <div className="grid-12 reporting-grid">
      <div className="card span-12 sticky-toolbar report-toolbar-card">
        <div className="report-dashboard-tabs" role="tablist" aria-label="Reporting dashboards">
          {(reportingDashboards.data ?? []).map((dash) => (
            <button
              type="button"
              key={dash.key}
              role="tab"
              aria-selected={reportingDashboardKey === dash.key}
              className={`report-tab ${reportingDashboardKey === dash.key ? "report-tab--active" : ""}`}
              onClick={() => setReportingDashboardKey(dash.key)}
            >
              {dash.title}
            </button>
          ))}
        </div>
        <div className="report-toolbar">
          <label className="report-field">
            <span className="report-field-label">Global filter</span>
            <input
              className="report-input"
              placeholder="Apply to every panel…"
              value={reportingGlobalFilter}
              onChange={(event) => setReportingGlobalFilter(event.target.value)}
            />
          </label>
          <label className="report-field">
            <span className="report-field-label">This dashboard</span>
            <input
              className="report-input"
              placeholder="Narrow current report…"
              value={reportingDashboardFilter}
              onChange={(event) =>
                setReportingDashboardFilters({
                  ...reportingDashboardFilters,
                  [reportingDashboardKey]: event.target.value,
                })
              }
            />
          </label>
          <label className="report-field">
            <span className="report-field-label">Instance</span>
            <input
              className="report-input"
              placeholder="Optional warehouse instance"
              value={reportingInstance}
              onChange={(event) => setReportingInstance(event.target.value)}
            />
          </label>
          <div className="report-field report-field--compact">
            <span className="report-field-label">API row limit</span>
            <div className="report-stepper">
              <button
                type="button"
                className="secondary"
                onClick={() => setReportingLimit(Math.max(100, (reportingLimitUnlimited ? 1000 : reportingLimit) - 100))}
              >
                −
              </button>
              <span className="report-stepper-value">{reportingLimitUnlimited ? "∞" : reportingLimit}</span>
              <button
                type="button"
                className="secondary"
                onClick={() => setReportingLimit(reportingLimitUnlimited ? 1000 : reportingLimit + 100)}
              >
                +
              </button>
              <button
                type="button"
                className={reportingLimitUnlimited ? "report-stepper-max report-stepper-max--on" : "report-stepper-max secondary"}
                onClick={() => setReportingLimit(0)}
              >
                Max
              </button>
            </div>
          </div>
          <div className="report-field report-field--compact">
            <span className="report-field-label">Season filter</span>
            <label className="report-inline-label">
              <input
                type="checkbox"
                checked={reportingIgnoreSeasonZero}
                onChange={(event) => setReportingIgnoreSeasonZero(event.target.checked)}
              />
              <span>Ignore Season 0</span>
            </label>
          </div>
          <div className="report-toolbar-actions">
            <button type="button" onClick={() => void reportingDashboard.refetch()}>
              Refresh
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setReportingGlobalFilter("");
                setReportingDashboardFilters({
                  ...reportingDashboardFilters,
                  [reportingDashboardKey]: "",
                });
                setReportingPanelFilters((prev) =>
                  Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${reportingDashboardKey}:`))),
                );
                setReportingColumnFilters((prev) =>
                  Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${reportingDashboardKey}:`))),
                );
                setReportingIgnoreSeasonZero(false);
              }}
            >
              Clear filters
            </button>
          </div>
        </div>
      </div>

      {reportingDashboard.data ? (
        <div className="span-12 report-hero">
          <div className="report-hero-text">
            <h2 className="report-hero-title">{reportingDashboard.data.title}</h2>
            <p className="report-hero-desc">{reportingDashboard.data.description}</p>
          </div>
          {reportingDashboard.data.generated_at ? (
            <time className="report-hero-time" dateTime={reportingDashboard.data.generated_at}>
              Generated {fmtDate(reportingDashboard.data.generated_at)}
            </time>
          ) : null}
        </div>
      ) : null}

      {renderReportingPanelNodes()}

      {reportingDashboard.isLoading ? (
        <div className="card span-12 report-loading">
          <div className="report-loading-dot" />
          <span>Loading dashboard…</span>
        </div>
      ) : null}
    </div>
  );
}
