import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AutomationList } from "./AutomationList";
import type { AutomationRow } from "../../types";

const ROW: AutomationRow = {
  id: 1,
  name: "dub hunt",
  template_key: "anime-dub-enforcer",
  params: {},
  enabled: true,
  dry_run: true,
  cron: "0 6 */2 * *",
  timezone: "UTC",
  budget_per_run: 10,
  cooldown_days: 7,
  created_at: "2026-07-30T00:00:00Z",
  updated_at: "2026-07-30T00:00:00Z",
  last_run_id: 5,
  last_run_status: "dry_run",
  last_run_started_at: "2026-07-30T06:00:00Z",
  last_run_matched: 12,
  last_run_actions: 0,
};

describe("AutomationList", () => {
  it("shows empty state without rows", () => {
    render(
      <AutomationList
        automations={[]}
        onEdit={vi.fn()}
        onRun={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    expect(screen.getByText(/no automations yet/i)).toBeInTheDocument();
  });

  it("renders row with dry-run badge and fires onRun", () => {
    const onRun = vi.fn();
    render(
      <AutomationList
        automations={[ROW]}
        onEdit={vi.fn()}
        onRun={onRun}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    expect(screen.getByText("dub hunt")).toBeInTheDocument();
    expect(screen.getByText(/dry run/i)).toBeInTheDocument();
    expect(screen.getByText(/matched 12/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(onRun).toHaveBeenCalledWith(ROW);
  });
});
