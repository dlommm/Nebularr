import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportingTablePanel } from "./ReportingTablePanel";
import { MAX_UNLIMITED_ROWS } from "./reportingShared";
import type { ReportingPanel } from "../../types";

function buildPanel(rowCount: number): ReportingPanel {
  return {
    id: "big-table",
    title: "Big table",
    kind: "table",
    rows: Array.from({ length: rowCount }, (_, i) => ({
      title: `Row ${i}`,
      season_number: (i % 20) + 1,
      quality: i % 2 === 0 ? "WEBDL-1080p" : "Bluray-2160p",
    })),
  };
}

function renderPanel(panel: ReportingPanel, pageSize: number) {
  return render(
    <ReportingTablePanel
      panel={panel}
      panelStateKey="overview:big-table"
      sharedTerms={[]}
      ignoreSeasonZero={false}
      panelFilter=""
      onPanelFilterChange={vi.fn()}
      pageSize={pageSize}
      onPageSizeChange={vi.fn()}
      offset={0}
      onOffsetChange={vi.fn()}
      columnFilters={{}}
      onColumnFilterChange={vi.fn()}
      exportUrl="/api/reporting/dashboards/overview/panels/big-table/export.csv"
    />,
  );
}

describe("ReportingTablePanel", () => {
  it("caps the 'All' page size at MAX_UNLIMITED_ROWS rendered rows", () => {
    const { container } = renderPanel(buildPanel(5000), 0);
    const bodyRows = container.querySelectorAll("tbody tr");
    expect(bodyRows.length).toBeLessThanOrEqual(MAX_UNLIMITED_ROWS);
    expect(bodyRows.length).toBe(MAX_UNLIMITED_ROWS);
    expect(screen.getByText(/for the complete dataset/i)).toBeInTheDocument();
  });

  it("renders a normal page without the cap notice", () => {
    const { container } = renderPanel(buildPanel(50), 10);
    expect(container.querySelectorAll("tbody tr").length).toBe(10);
    expect(screen.queryByText(/for the complete dataset/i)).not.toBeInTheDocument();
  });
});
