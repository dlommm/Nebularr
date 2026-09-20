import { beforeEach, describe, expect, it, vi } from "vitest";
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
      validateAutomation: vi.fn().mockResolvedValue({ valid: true, match_preview: { radarr: 34 } }),
      automationRootFolders: vi.fn().mockResolvedValue({
        root_folders: [
          { path: "/media/anime", media: "series", instances: ["sonarr"], item_count: 12 },
          { path: "/media/movies", media: "movies", instances: ["radarr"], item_count: 40 },
        ],
      }),
    },
  };
});

const DRAFT: AutomationDraft = {
  id: 1,
  name: "resolution floor",
  template_key: "custom",
  cron: "0 5 * * 6",
  timezone: "UTC",
  enabled: true,
  dry_run: true,
  budget_per_run: 10,
  cooldown_days: 7,
  params: {
    scope: { media: "movies" },
    require: { resolution_min: 1080 },
    actions: [{ type: "search_upgrade" }],
  },
};

// Call counts accumulate across tests otherwise (no global clearMocks), which
// would make the settle-wait below pass instantly on every test after the first.
beforeEach(() => {
  vi.clearAllMocks();
});

async function renderEditor(draft: AutomationDraft = DRAFT) {
  const onChange = vi.fn();
  render(<AutomationEditor draft={draft} onChange={onChange} onValidityChange={vi.fn()} />);
  // Let the mount-time root-folder fetch and the live validation settle before
  // interacting, so stray act() warnings can't mask a real one.
  await waitFor(() => expect(api.automationRootFolders).toHaveBeenCalled());
  await waitFor(() => expect(api.validateAutomation).toHaveBeenCalled());
  return onChange;
}

describe("AutomationEditor", () => {
  it("leads with the rule as a plain-English sentence", async () => {
    await renderEditor();
    expect(
      await screen.findByText(
        /Every Saturday at 05:00, look at monitored movies — for anything that isn't 1080p or better, search for an upgrade\./i,
      ),
    ).toBeInTheDocument();
  });

  it("validates live and reports the match count without a button press", async () => {
    await renderEditor();
    await waitFor(() => expect(api.validateAutomation).toHaveBeenCalled());
    expect(await screen.findByText(/would act on 34 items right now/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /validate/i })).toBeNull();
  });

  it("surfaces a server-rejected rule inline", async () => {
    vi.mocked(api.validateAutomation).mockResolvedValueOnce({
      valid: false,
      error: "search_upgrade needs at least one require clause",
    });
    await renderEditor();
    expect(await screen.findByText(/needs at least one require clause/i)).toBeInTheDocument();
  });

  it("keeps a conforming action when media leaves movies", async () => {
    // It used to be stripped here, because the backend only supported
    // when=conforming for movies. Series completeness is exactly that action
    // applied to a whole show, so stripping it now would delete the user's rule.
    const onChange = await renderEditor({
      ...DRAFT,
      params: {
        scope: { media: "movies" },
        actions: [{ type: "set_monitored", when: "conforming", value: false }],
      },
    });

    fireEvent.change(screen.getByLabelText("Media"), { target: { value: "series" } });

    const next = onChange.mock.calls[0][0] as AutomationDraft;
    expect(next.params?.scope?.media).toBe("series");
    expect(next.params?.actions ?? []).toContainEqual(
      expect.objectContaining({ type: "set_monitored", when: "conforming" }),
    );
  });

  it("drops the series-only status filter when media becomes movies", async () => {
    // The asymmetry that remains: the backend rejects series_status_any for
    // movies, so leaving it behind would make the rule unsaveable with no
    // visible cause (the control it came from is no longer on screen).
    const onChange = await renderEditor({
      ...DRAFT,
      params: {
        scope: { media: "series", series_status_any: ["ended"] },
        actions: [{ type: "tag", label: "ready", when: "conforming" }],
      },
    });

    fireEvent.change(screen.getByLabelText("Media"), { target: { value: "movies" } });

    const next = onChange.mock.calls[0][0] as AutomationDraft;
    expect(next.params?.scope?.media).toBe("movies");
    expect(next.params?.scope?.series_status_any).toEqual([]);
  });

  it("offers the series completeness controls for a series scope", async () => {
    await renderEditor({
      ...DRAFT,
      params: { scope: { media: "series" }, actions: [{ type: "tag", label: "x" }] },
    });
    // byRole, not byLabelText: these labels carry an explanatory second line, so
    // the label text matches more than one node.
    expect(screen.getByRole("checkbox", { name: /ignore specials/i })).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /count episodes you have unmonitored/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /filter series status/i }),
    ).toBeInTheDocument();
  });

  it("hides the series completeness controls for a movies scope", async () => {
    // A separate render rather than switching the select: the editor is fully
    // controlled, so a change event only reports upward — the parent owns what
    // media the component is then re-rendered with.
    await renderEditor({
      ...DRAFT,
      params: { scope: { media: "movies" }, actions: [{ type: "tag", label: "x" }] },
    });
    expect(screen.queryByRole("checkbox", { name: /ignore specials/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /filter series status/i })).toBeNull();
  });

  it("lets a tag action target the passing set", async () => {
    const onChange = await renderEditor({
      ...DRAFT,
      params: {
        scope: { media: "series" },
        actions: [{ type: "tag", label: "ready-to-unmonitor" }],
      },
    });

    fireEvent.change(screen.getByLabelText("Tag which items"), {
      target: { value: "conforming" },
    });

    const next = onChange.mock.calls[0][0] as AutomationDraft;
    expect(next.params?.actions?.[0]).toEqual(
      expect.objectContaining({ type: "tag", when: "conforming" }),
    );
  });

  it("unchecking new-dub-only leaves mal_dub_gate untouched", async () => {
    const onChange = await renderEditor({
      ...DRAFT,
      params: {
        scope: { media: "movies" },
        actions: [{ type: "search_missing" }],
        options: { mal_dub_gate: false, new_dub_only: true },
      },
    });

    await userEvent.click(screen.getByRole("checkbox", { name: /only act when a dub newly appears/i }));

    const next = onChange.mock.calls[0][0] as AutomationDraft;
    expect(next.params?.options?.new_dub_only).toBe(false);
    expect(next.params?.options?.mal_dub_gate).toBe(false);
  });

  it("edits list values as removable chips rather than a comma-separated string", async () => {
    const onChange = await renderEditor({
      ...DRAFT,
      params: { ...DRAFT.params, require: { audio_language_any: ["english", "eng"] } },
    });

    await userEvent.click(screen.getByRole("button", { name: "Remove eng" }));

    const next = onChange.mock.calls[0][0] as AutomationDraft;
    expect(next.params?.require?.audio_language_any).toEqual(["english"]);
  });

  it("offers only the selected media's folders in the location picker", async () => {
    await renderEditor();
    await waitFor(() => expect(api.automationRootFolders).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: /filter folder location/i }));

    expect(await screen.findByRole("menuitemcheckbox", { name: "/media/movies" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: "/media/anime" })).toBeNull();
  });

  it("keeps a saved folder the library no longer reports", async () => {
    await renderEditor({
      ...DRAFT,
      params: { ...DRAFT.params, scope: { media: "movies", root_folders_any: ["/mnt/retired"] } },
    });
    await waitFor(() => expect(api.automationRootFolders).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: /filter folder location/i }));

    const stale = await screen.findByRole("menuitemcheckbox", { name: "/mnt/retired" });
    expect(stale).toBeInTheDocument();
  });

  it("edits only the tag action its control is bound to", async () => {
    // A rule may legitimately carry both a conforming and a non-conforming tag;
    // the editor shows one control, so patching every match would collapse the
    // two labels into one and silently destroy the second rule half.
    const onChange = await renderEditor({
      ...DRAFT,
      params: {
        scope: { media: "series" },
        actions: [
          { type: "tag", label: "needs-fix", when: "non_conforming" },
          { type: "tag", label: "ready-to-unmonitor", when: "conforming" },
        ],
      },
    });

    fireEvent.change(screen.getByLabelText("Tag label"), { target: { value: "renamed" } });

    const next = onChange.mock.calls[0][0] as AutomationDraft;
    expect(next.params?.actions).toEqual([
      { type: "tag", label: "renamed", when: "non_conforming" },
      { type: "tag", label: "ready-to-unmonitor", when: "conforming" },
    ]);
  });
});
