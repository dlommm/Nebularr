import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportingTimeseriesPanel } from "./ReportingTimeseriesPanel";
import type { ReportingPanel } from "../../types";

function buildPanel(rows: ReportingPanel["rows"]): ReportingPanel {
  return { id: "storage_over_time", title: "Library Size Over Time (bytes)", kind: "timeseries", rows };
}

describe("ReportingTimeseriesPanel", () => {
  it("shows an empty-state message when there are no snapshots", () => {
    render(<ReportingTimeseriesPanel panel={buildPanel([])} />);
    expect(screen.getByText(/No snapshots yet/i)).toBeInTheDocument();
  });

  it("reports one point per distinct timestamp", () => {
    render(
      <ReportingTimeseriesPanel
        panel={buildPanel([
          { ts: "2026-07-01", label: "sonarr", value: 100 },
          { ts: "2026-07-01", label: "radarr", value: 50 },
          { ts: "2026-07-02", label: "sonarr", value: 120 },
          { ts: "2026-07-02", label: "radarr", value: 55 },
          { ts: "2026-07-03", label: "sonarr", value: 130 },
        ])}
      />,
    );
    expect(screen.getByText("3 points")).toBeInTheDocument();
    expect(screen.getByText("Library Size Over Time (bytes)")).toBeInTheDocument();
  });
});
