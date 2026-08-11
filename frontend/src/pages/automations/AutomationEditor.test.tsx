import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      automationRootFolders: vi.fn().mockResolvedValue({
        root_folders: [
          { path: "/media/anime", media: "series", instances: ["sonarr"], item_count: 12 },
          { path: "/media/movies", media: "movies", instances: ["radarr"], item_count: 40 },
        ],
      }),
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

    // Exact match: folder-picker rows are labelled with real paths like
    // "/media/movies", which a /media/i regex would also hit.
    fireEvent.change(screen.getByLabelText("Media"), { target: { value: "both" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const nextDraft = onChange.mock.calls[0][0] as AutomationDraft;
    expect(nextDraft.params?.scope?.media).toBe("both");
    expect(nextDraft.params?.actions ?? []).not.toContainEqual(
      expect.objectContaining({ when: "conforming" }),
    );
  });

  it("unchecking new-dub-only leaves mal_dub_gate untouched instead of forcing it true", async () => {
    const draft: AutomationDraft = {
      id: 2,
      name: "dub watcher",
      template_key: "custom",
      cron: "0 6 * * *",
      timezone: "UTC",
      enabled: true,
      dry_run: true,
      budget_per_run: 10,
      cooldown_days: 7,
      params: {
        scope: { media: "movies" },
        actions: [{ type: "search_missing" }],
        options: { mal_dub_gate: false, new_dub_only: true },
      },
    };
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationEditor draft={draft} onChange={onChange} onSave={vi.fn()} onCancel={vi.fn()} saving={false} />,
    );
    await waitFor(() => expect(api.validateSchedule).toHaveBeenCalled());

    await user.click(screen.getByRole("checkbox", { name: /new-dub watcher/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const nextDraft = onChange.mock.calls[0][0] as AutomationDraft;
    expect(nextDraft.params?.options?.new_dub_only).toBe(false);
    // mal_dub_gate started false and must stay false — unchecking must not force it true.
    expect(nextDraft.params?.options?.mal_dub_gate).toBe(false);
  });

  it("offers only the selected media's folders and scopes the rule to the picked one", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationEditor
        draft={MOVIES_DRAFT_WITH_CONFORMING_ACTION}
        onChange={onChange}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        saving={false}
      />,
    );
    await waitFor(() => expect(api.automationRootFolders).toHaveBeenCalled());

    const folder = await screen.findByRole("checkbox", { name: /\/media\/movies/ });
    // media is "movies", so the series-only folder must not be offered.
    expect(screen.queryByRole("checkbox", { name: /\/media\/anime/ })).toBeNull();

    await user.click(folder);

    const calls = onChange.mock.calls;
    const nextDraft = calls[calls.length - 1][0] as AutomationDraft;
    expect(nextDraft.params?.scope?.root_folders_any).toEqual(["/media/movies"]);
  });

  it("keeps a saved folder that the library no longer reports", async () => {
    const draft: AutomationDraft = {
      ...MOVIES_DRAFT_WITH_CONFORMING_ACTION,
      id: 3,
      params: {
        scope: { media: "movies", root_folders_any: ["/mnt/retired"] },
        actions: [{ type: "search_missing" }],
      },
    };
    render(
      <AutomationEditor draft={draft} onChange={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()} saving={false} />,
    );
    await waitFor(() => expect(api.automationRootFolders).toHaveBeenCalled());

    const stale = await screen.findByRole("checkbox", { name: /\/mnt\/retired/ });
    expect(stale).toBeChecked();
  });
});
