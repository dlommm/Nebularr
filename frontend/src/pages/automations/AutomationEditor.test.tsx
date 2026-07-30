import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AutomationEditor, type AutomationDraft } from "./AutomationEditor";
import { api } from "../../api";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      validateSchedule: vi.fn().mockResolvedValue({ valid: true, next_fire_times: [] }),
      validateAutomation: vi.fn(),
    },
  };
});

const MOVIES_DRAFT_WITH_CONFORMING_ACTION: AutomationDraft = {
  id: 1,
  name: "unmonitor movies",
  template_key: "custom",
  cron: "0 6 * * *",
  timezone: "UTC",
  enabled: true,
  dry_run: true,
  budget_per_run: 10,
  cooldown_days: 7,
  params: {
    scope: { media: "movies" },
    actions: [{ type: "set_monitored", when: "conforming", value: false }],
  },
};

describe("AutomationEditor", () => {
  it("drops the movies-only conforming set_monitored action when media leaves movies", async () => {
    const onChange = vi.fn();
    render(
      <AutomationEditor
        draft={MOVIES_DRAFT_WITH_CONFORMING_ACTION}
        onChange={onChange}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        saving={false}
      />,
    );

    // Let CronPreview's mounting cron-validation call settle (and its state
    // update flush under act) before interacting, so this test isn't flaky
    // about unrelated component internals.
    await waitFor(() => expect(api.validateSchedule).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/media/i), { target: { value: "both" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const nextDraft = onChange.mock.calls[0][0] as AutomationDraft;
    expect(nextDraft.params?.scope?.media).toBe("both");
    expect(nextDraft.params?.actions ?? []).not.toContainEqual(
      expect.objectContaining({ when: "conforming" }),
    );
  });
});
