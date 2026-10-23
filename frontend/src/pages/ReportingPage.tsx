import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { fmtDate, useLocalStorageState } from "../hooks";
import { usePageTitle } from "../hooks/usePageTitle";
import { queryKeys } from "../lib/queryKeys";
import type { ReportingPanel } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QueryErrorNotice } from "../components/nebula/QueryErrorNotice";
import { SavedViews } from "../components/nebula/SavedViews";
import { ReportingDistributionPanel } from "./reporting/ReportingDistributionPanel";
import { ReportingTablePanel } from "./reporting/ReportingTablePanel";
import { ReportingTimeseriesPanel } from "./reporting/ReportingTimeseriesPanel";
import { resetPanelOffset, tokenizeFilter } from "./reporting/reportingShared";
import { Figure, Figures, PageHead } from "@/components/ns/Page";
import { actionLinkClass } from "@/lib/ns";
import { cn } from "@/lib/utils";

export function ReportingPage(): JSX.Element {
  usePageTitle("Reports");
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
    setReportingDashboardFilters((prev) => ({
      ...prev,
      [nextKey]: searchParams.get("dq") ?? "",
    }));
    setReportingInstance(searchParams.get("inst") ?? "");
    const limitRaw = searchParams.get("limit");
    // limit=0 is a valid deep link (the "Max" setting), so don't || it away.
    setReportingLimit(limitRaw != null && limitRaw !== "" && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const reportingDashboards = useQuery({
    queryKey: queryKeys.reportingDashboards,
    queryFn: api.reportingDashboards,
  });
  const reportingDashboardParams = { instance_name: reportingInstance, limit: reportingLimit };
  const reportingDashboard = useQuery({
    queryKey: queryKeys.reportingDashboard(reportingDashboardKey, reportingDashboardParams),
    queryFn: () => api.reportingDashboard(reportingDashboardKey, reportingDashboardParams),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });

  const reportingDashboardFilter = reportingDashboardFilters[reportingDashboardKey] ?? "";
  const deferredGlobalFilter = useDeferredValue(reportingGlobalFilter);
  const deferredDashboardFilter = useDeferredValue(reportingDashboardFilter);
  const reportingSharedTerms = useMemo(
    () => [...tokenizeFilter(deferredGlobalFilter), ...tokenizeFilter(deferredDashboardFilter)],
    [deferredGlobalFilter, deferredDashboardFilter],
  );
  const reportingLimitUnlimited = reportingLimit <= 0;

  // Dashboard-wide changes (different data, different global/dashboard filter,
  // shared page size) invalidate every panel's pagination. A single panel's
  // own filter (reportingPanelFilters/reportingColumnFilters) only affects
  // that panel, so it's scoped in the handlers below instead of resetting
  // every other panel's page back to the start.
  useEffect(() => {
    setReportingTableOffsets({});
  }, [
    reportingDashboardKey,
    reportingInstance,
    reportingLimit,
    reportingTablePageSize,
    deferredGlobalFilter,
    deferredDashboardFilter,
    reportingIgnoreSeasonZero,
  ]);

  const handlePanelFilterChange = useCallback((panelStateKey: string, value: string) => {
    setReportingPanelFilters((prev) => ({ ...prev, [panelStateKey]: value }));
    setReportingTableOffsets((prev) => resetPanelOffset(prev, panelStateKey));
  }, []);
  const handleOffsetChange = useCallback((panelStateKey: string, value: number) => {
    setReportingTableOffsets((prev) => ({ ...prev, [panelStateKey]: value }));
  }, []);
  const handleColumnFilterChange = useCallback((panelStateKey: string, column: string, next: string[]) => {
    setReportingColumnFilters((prev) => ({ ...prev, [`${panelStateKey}:${column}`]: next }));
    setReportingTableOffsets((prev) => resetPanelOffset(prev, panelStateKey));
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
          <Figures className="col-span-12" key={`report-stats-${batch[0]?.id ?? i}`}>
            {batch.map((p, idx) => (
              <Figure
                key={p.id}
                value={typeof p.value === "number" ? p.value.toLocaleString() : (p.value ?? "—")}
                label={p.title}
                style={{ animationDelay: `${idx * 60}ms` }}
              />
            ))}
          </Figures>,
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

  const clearFilters = (): void => {
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
  };

  const fieldLabelClass = "grid gap-1 text-[11px] text-subtle-foreground";

  return (
    <div className="pb-16">
      <PageHead title="Reports" lead="Straight from the warehouse. Every panel can be exported as CSV." />

      {reportingDashboards.isError ? (
        <QueryErrorNotice
          label="reporting dashboards"
          retry={() => void reportingDashboards.refetch()}
          error={reportingDashboards.error}
        />
      ) : (
        <div className="flex gap-x-7 overflow-x-auto border-b border-border [scrollbar-width:none]" role="tablist" aria-label="Reporting dashboards">
          {(reportingDashboards.data ?? []).map((dash) => {
            const active = reportingDashboardKey === dash.key;
            return (
              <button
                type="button"
                key={dash.key}
                role="tab"
                aria-selected={active}
                className={cn(
                  "shrink-0 border-b-2 py-3.5 text-[15px] whitespace-nowrap transition-colors",
                  active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setReportingDashboardKey(dash.key)}
              >
                {dash.title}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-x-6 gap-y-4 py-5">
        <label className={cn(fieldLabelClass, "min-w-44 flex-1 sm:max-w-xs")}>
          Global filter
          <Input
            className="h-11"
            placeholder="Apply to every panel…"
            value={reportingGlobalFilter}
            onChange={(event) => setReportingGlobalFilter(event.target.value)}
          />
        </label>
        <label className={cn(fieldLabelClass, "min-w-44 flex-1 sm:max-w-xs")}>
          This dashboard
          <Input
            className="h-11"
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
        <label className={cn(fieldLabelClass, "min-w-44 sm:max-w-52")}>
          Instance
          <Input
            className="h-11"
            placeholder="All instances"
            value={reportingInstance}
            onChange={(event) => setReportingInstance(event.target.value)}
          />
        </label>
        <div className={fieldLabelClass}>
          <span id="reporting-limit">API row limit</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-sm border border-border" role="group" aria-labelledby="reporting-limit">
              <button
                type="button"
                aria-label="Fewer rows"
                className="size-11 text-base text-foreground hover:bg-muted"
                onClick={() => setReportingLimit(Math.max(100, (reportingLimitUnlimited ? 1000 : reportingLimit) - 100))}
              >
                −
              </button>
              <span className="min-w-12 text-center text-sm tabular-nums text-foreground">
                {reportingLimitUnlimited ? "∞" : reportingLimit}
              </span>
              <button
                type="button"
                aria-label="More rows"
                className="size-11 text-base text-foreground hover:bg-muted"
                onClick={() => setReportingLimit(reportingLimitUnlimited ? 1000 : reportingLimit + 100)}
              >
                +
              </button>
            </div>
            <button
              type="button"
              aria-pressed={reportingLimitUnlimited}
              className={cn(
                "min-h-11 border-b px-1 text-sm",
                reportingLimitUnlimited ? "border-signal text-signal" : "border-input text-foreground hover:border-foreground",
              )}
              onClick={() => setReportingLimit(0)}
            >
              Max
            </button>
          </div>
        </div>
        <label className="flex min-h-11 items-center gap-2.5 text-sm text-foreground">
          <input
            type="checkbox"
            className="size-[18px] accent-signal"
            checked={reportingIgnoreSeasonZero}
            onChange={(event) => setReportingIgnoreSeasonZero(event.target.checked)}
          />
          <span>Ignore season 0 (specials)</span>
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <SavedViews storageKey="nebularr.savedViews.reporting" />
          <button type="button" className={actionLinkClass} onClick={clearFilters}>
            Clear filters
          </button>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => void reportingDashboard.refetch()}>
            Refresh
          </Button>
        </div>
      </div>

      {reportingDashboard.isError ? (
        <QueryErrorNotice
          label="reporting dashboard"
          retry={() => void reportingDashboard.refetch()}
          error={reportingDashboard.error}
        />
      ) : null}

      {reportingDashboard.data ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pt-4 pb-5">
          <p className="max-w-2xl text-[15px] text-muted-foreground">
            <span className="text-foreground">{reportingDashboard.data.title}.</span> {reportingDashboard.data.description}
          </p>
          {reportingDashboard.data.generated_at ? (
            <time className="font-mono text-xs text-subtle-foreground" dateTime={reportingDashboard.data.generated_at}>
              generated {fmtDate(reportingDashboard.data.generated_at)}
            </time>
          ) : null}
        </div>
      ) : null}

      <div className={cn("grid grid-cols-12 gap-x-14 gap-y-14", reportingDashboard.isPlaceholderData && "opacity-60 transition-opacity")}>
        {renderReportingPanelNodes()}
      </div>

      {reportingDashboard.isLoading ? (
        <p className="flex items-center gap-2 border-t border-border py-5 text-sm text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-signal" />
          Loading dashboard…
        </p>
      ) : null}
    </div>
  );
}
