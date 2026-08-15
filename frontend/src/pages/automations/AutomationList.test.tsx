import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function renderList(overrides: Partial<React.ComponentProps<typeof AutomationList>> = {}) {
  const props = {
    automations: [ROW],
    onEdit: vi.fn(),
    onRun: vi.fn(),
    onDelete: vi.fn(),
    onToggle: vi.fn(),
    onHistory: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  };
  render(<AutomationList {...props} />);
  return props;
}

describe("AutomationList", () => {
  it("shows an empty state that offers the primary action", () => {
    const props = renderList({ automations: [] });
    expect(screen.getByText(/no automations yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));
    expect(props.onCreate).toHaveBeenCalled();
  });

  it("renders the row with its dry-run badge and fires onRun", () => {
    const props = renderList();
    expect(screen.getByText("dub hunt")).toBeInTheDocument();
    expect(screen.getByText(/dry run/i)).toBeInTheDocument();
    expect(screen.getByText(/12 matched/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(props.onRun).toHaveBeenCalledWith(ROW);
  });

  it("phrases the schedule in English instead of showing the raw crontab", () => {
    renderList();
    expect(screen.getByText(/every 2 days at 06:00/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 6 \*\/2 \* \*/)).toBeNull();
  });

  it("keeps only one action in the row and puts the rest behind the overflow menu", async () => {
    // The point of the redesign: Delete and "Go live" must not sit at the same
    // visual weight as Run now.
    const props = renderList();
    expect(screen.queryByRole("button", { name: /^delete/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /go live/i })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /more actions for dub hunt/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));
    expect(props.onDelete).toHaveBeenCalledWith(ROW);
  });

  it("routes going live through onToggle so the page can confirm it", async () => {
    const props = renderList();
    await userEvent.click(screen.getByRole("button", { name: /more actions for dub hunt/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /go live/i }));
    expect(props.onToggle).toHaveBeenCalledWith(ROW, { dry_run: false });
  });
});
