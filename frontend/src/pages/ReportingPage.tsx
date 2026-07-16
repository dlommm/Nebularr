import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { fmtDate, useLocalStorageState } from "../hooks";
import { usePageTitle } from "../hooks/usePageTitle";
import type { ReportingPanel } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SavedViews } from "../components/nebula/SavedViews";
import { ReportingDistributionPanel } from "./reporting/ReportingDistributionPanel";
import { ReportingTablePanel } from "./reporting/ReportingTablePanel";
import { ReportingTimeseriesPanel } from "./reporting/ReportingTimeseriesPanel";
import { tokenizeFilter } from "./reporting/reportingShared";

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
  const [searchParams, setSearchParams] = useSearchParams();
  const lastWrittenSearch = useRef<string | null>(null);

  // State → URL so dashboards and filters are linkable (SavedViews/Copy link).
  useEffect(() => {
    const params = new URLSearchParams();
    if (reportingDashboardKey !== "overview") params.set("dash", reportingDashboardKey);
    if (reportingGlobalFilter) params.set("q", reportingGlobalFilter);
    const dashboardFilter = reportingDashboardFilters[reportingDashboardKey] ?? "";
    if (dashboardFilter) params.set("dq", dashboardFilter);
    if (reportingInstance) params.set("inst", reportingInstance);
    if (reportingLimit !== 200) params.set("limit", String(reportingLimit));
    const canonical = params.toString();
    if (canonical !== searchParams.toString()) {
      lastWrittenSearch.current = canonical;
      setSearchParams(new URLSearchParams(canonical), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportingDashboardKey, reportingGlobalFilter, reportingDashboardFilters, reportingInstance, reportingLimit]);

  // External URL change (deep link, saved view, back/forward) → state.
  useEffect(() => {
    const current = searchParams.toString();
    if (current === lastWrittenSearch.current || [...searchParams.keys()].length === 0) return;
    const dash = searchParams.get("dash");
    const nextKey = dash ?? "overview";
    setReportingDashboardKey(nextKey);
    setReportingGlobalFilter(searchParams.get("q") ?? "");
    setReportingDashboardFilters({
      ...reportingDashboardFilters,
      [nextKey]: searchParams.get("dq") ?? "",
    });
    setReportingInstance(searchParams.get("inst") ?? "");
    const limitRaw = searchParams.get("limit");
    // limit=0 is a valid deep link (the "Max" setting), so don't || it away.
    setReportingLimit(limitRaw != null && limitRaw !== "" && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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

  const reportingDashboardFilter = reportingDashboardFilters[reportingDashboardKey] ?? "";
  const deferredGlobalFilter = useDeferredValue(reportingGlobalFilter);
  const deferredDashboardFilter = useDeferredValue(reportingDashboardFilter);
  const reportingSharedTerms = useMemo(
    () => [...tokenizeFilter(deferredGlobalFilter), ...tokenizeFilter(deferredDashboardFilter)],
    [deferredGlobalFilter, deferredDashboardFilter],
  );
  const reportingLimitUnlimited = reportingLimit <= 0;

  useEffect(() => {
    setReportingTableOffsets({});
  }, [
    reportingDashboardKey,
    reportingInstance,
    reportingLimit,
    reportingTablePageSize,
    deferredGlobalFilter,
    deferredDashboardFilter,
    reportingPanelFilters,
    reportingColumnFilters,
    reportingIgnoreSeasonZero,
  ]);

  const handlePanelFilterChange = useCallback((panelStateKey: string, value: string) => {
    setReportingPanelFilters((prev) => ({ ...prev, [panelStateKey]: value }));
  }, []);
  const handleOffsetChange = useCallback((panelStateKey: string, value: number) => {
    setReportingTableOffsets((prev) => ({ ...prev, [panelStateKey]: value }));
  }, []);
  const handleColumnFilterChange = useCallback((panelStateKey: string, column: string, next: string[]) => {
    setReportingColumnFilters((prev) => ({ ...prev, [`${panelStateKey}:${column}`]: next }));
  }, []);
  const handlePageSizeChange = useCallback(
    (value: number) => setReportingTablePageSize(value),
    [setReportingTablePageSize],
  );

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
          <div className="col-span-12" key={`report-stats-${batch[0]?.id ?? i}`}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {batch.map((p) => (
                <div
                  className="rounded-xl border border-border bg-card px-4 py-3 shadow-[var(--shadow-card)]"
                  key={p.id}
                >
                  <div className="truncate text-xs text-muted-foreground" title={p.title}>
                    {p.title}
                  </div>
                  <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                    {typeof p.value === "number" ? p.value.toLocaleString() : (p.value ?? "—")}
                  </div>
                </div>
              ))}
            </div>
          </div>,
        );
      } else {
        const panelStateKey = `${reportingDashboardKey}:${panel.id}`;
        // limit 0 = server maximum: "Export CSV" genuinely means the full
        // dataset, not just the rows currently loaded on screen.
        const exportUrl = api.reportingPanelExportUrl(reportingDashboardKey, panel.id, {
          instance_name: reportingInstance,
          limit: 0,
        });
        if (panel.kind === "timeseries") {
          nodes.push(<ReportingTimeseriesPanel key={panel.id} panel={panel} />);
        } else if (panel.kind === "distribution") {
          nodes.push(
            <ReportingDistributionPanel
              key={panel.id}
              panel={panel}
              panelStateKey={panelStateKey}
              sharedTerms={reportingSharedTerms}
              ignoreSeasonZero={reportingIgnoreSeasonZero}
              panelFilter={reportingPanelFilters[panelStateKey] ?? ""}
              onPanelFilterChange={handlePanelFilterChange}
              exportUrl={exportUrl}
            />,
          );
        } else {
          nodes.push(
            <ReportingTablePanel
              key={panel.id}
              panel={panel}
              panelStateKey={panelStateKey}
              sharedTerms={reportingSharedTerms}
              ignoreSeasonZero={reportingIgnoreSeasonZero}
              panelFilter={reportingPanelFilters[panelStateKey] ?? ""}
              onPanelFilterChange={handlePanelFilterChange}
              pageSize={reportingTablePageSize}
              onPageSizeChange={handlePageSizeChange}
              offset={reportingTableOffsets[panelStateKey] ?? 0}
              onOffsetChange={handleOffsetChange}
              columnFilters={reportingColumnFilters}
              onColumnFilterChange={handleColumnFilterChange}
              exportUrl={exportUrl}
            />,
          );
        }
        i += 1;
      }
    }
    return nodes;
  };

  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-12 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
        <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Reporting dashboards">
          {(reportingDashboards.data ?? []).map((dash) => (
            <button
              type="button"
              key={dash.key}
              role="tab"
              aria-selected={reportingDashboardKey === dash.key}
              className={
                reportingDashboardKey === dash.key
                  ? "rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
                  : "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              }
              onClick={() => setReportingDashboardKey(dash.key)}
            >
              {dash.title}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-44 flex-1 gap-1.5 sm:max-w-xs">
            <span className="text-xs text-muted-foreground">Global filter</span>
            <Input
              className="h-9"
              placeholder="Apply to every panel…"
              value={reportingGlobalFilter}
              onChange={(event) => setReportingGlobalFilter(event.target.value)}
            />
          </label>
          <label className="grid min-w-44 flex-1 gap-1.5 sm:max-w-xs">
            <span className="text-xs text-muted-foreground">This dashboard</span>
            <Input
              className="h-9"
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
          <label className="grid min-w-44 gap-1.5 sm:max-w-52">
            <span className="text-xs text-muted-foreground">Instance</span>
            <Input
              className="h-9"
              placeholder="Optional warehouse instance"
              value={reportingInstance}
              onChange={(event) => setReportingInstance(event.target.value)}
            />
          </label>
          <div className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">API row limit</span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setReportingLimit(Math.max(100, (reportingLimitUnlimited ? 1000 : reportingLimit) - 100))}
              >
                −
              </Button>
              <span className="min-w-12 text-center text-sm tabular-nums text-foreground">
                {reportingLimitUnlimited ? "∞" : reportingLimit}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setReportingLimit(reportingLimitUnlimited ? 1000 : reportingLimit + 100)}
              >
                +
              </Button>
              <Button
                type="button"
                variant={reportingLimitUnlimited ? "default" : "secondary"}
                size="sm"
                onClick={() => setReportingLimit(0)}
              >
                Max
              </Button>
            </div>
          </div>
          <label className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="accent-primary"
              checked={reportingIgnoreSeasonZero}
              onChange={(event) => setReportingIgnoreSeasonZero(event.target.checked)}
            />
            <span>Ignore Season 0</span>
          </label>
          <div className="ml-auto flex items-center gap-2">
            <SavedViews storageKey="nebularr.savedViews.reporting" />
            <Button type="button" size="sm" onClick={() => void reportingDashboard.refetch()}>
              Refresh
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
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
            </Button>
          </div>
        </div>
      </div>

      {reportingDashboard.data ? (
        <div className="col-span-12 flex flex-wrap items-end justify-between gap-2 px-1">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{reportingDashboard.data.title}</h2>
            <p className="text-sm text-muted-foreground">{reportingDashboard.data.description}</p>
          </div>
          {reportingDashboard.data.generated_at ? (
            <time className="text-xs text-muted-foreground" dateTime={reportingDashboard.data.generated_at}>
              Generated {fmtDate(reportingDashboard.data.generated_at)}
            </time>
          ) : null}
        </div>
      ) : null}

      {renderReportingPanelNodes()}

      {reportingDashboard.isLoading ? (
        <div className="col-span-12 flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-primary" />
          <span>Loading dashboard…</span>
        </div>
      ) : null}
    </div>
  );
}
