import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsPage } from "./AutomationsPage";
import { ActionErrorProvider } from "../context/ActionErrorContext";
import { api } from "../api";
import type { AutomationRow } from "../types";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      automations: vi.fn(),
      automationTemplates: vi.fn(),
      automationRootFolders: vi.fn(),
      validateAutomation: vi.fn(),
      validateSchedule: vi.fn(),
      saveAutomation: vi.fn(),
      deleteAutomation: vi.fn(),
      runAutomation: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api);

const ROW: AutomationRow = {
  id: 1,
  name: "dub hunt",
  template_key: "anime-dub-enforcer",
  params: { scope: { media: "both" }, actions: [{ type: "search_missing" }] },
  enabled: true,
  dry_run: true,
  cron: "0 6 */2 * *",
  timezone: "UTC",
  budget_per_run: 10,
  cooldown_days: 7,
  created_at: "2026-07-30T00:00:00Z",
  updated_at: "2026-07-30T00:00:00Z",
  last_run_id: null,
  last_run_status: null,
  last_run_started_at: null,
  last_run_matched: null,
  last_run_actions: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.automations.mockResolvedValue({ automations: [ROW] });
  mockedApi.automationTemplates.mockResolvedValue({
    templates: [
      {
        key: "custom",
        title: "Custom rule",
        description: "Build your own.",
        default_cron: "0 8 * * 6",
        default_params: { scope: { media: "both" }, actions: [{ type: "search_missing" }] },
      },
    ],
  });
  mockedApi.automationRootFolders.mockResolvedValue({ root_folders: [] });
  mockedApi.validateAutomation.mockResolvedValue({ valid: true, match_preview: {} });
  mockedApi.validateSchedule.mockResolvedValue({ valid: true, next_fire_times: [] });
  mockedApi.saveAutomation.mockResolvedValue({ status: "ok" });
  mockedApi.deleteAutomation.mockResolvedValue({ status: "ok" });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ActionErrorProvider>
          <AutomationsPage />
        </ActionErrorProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function openRowMenu(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: /more actions for dub hunt/i }));
}

describe("AutomationsPage", () => {
  it("asks before taking a rule live, and only saves once confirmed", async () => {
    // Leaving dry-run is the one control that starts real indexer traffic, so
    // it must never be a single stray click.
    renderPage();
    await openRowMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /go live/i }));

    expect(await screen.findByText(/take “dub hunt” live\?/i)).toBeInTheDocument();
    expect(mockedApi.saveAutomation).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^go live$/i }));

    await waitFor(() => expect(mockedApi.saveAutomation).toHaveBeenCalledTimes(1));
    expect(mockedApi.saveAutomation.mock.calls[0][1]).toMatchObject({ dry_run: false });
  });

  it("does not save when the go-live confirmation is dismissed", async () => {
    renderPage();
    await openRowMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /go live/i }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    expect(mockedApi.saveAutomation).not.toHaveBeenCalled();
  });

  it("asks before deleting", async () => {
    renderPage();
    await openRowMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));

    expect(await screen.findByText(/delete “dub hunt”\?/i)).toBeInTheDocument();
    expect(mockedApi.deleteAutomation).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(mockedApi.deleteAutomation).toHaveBeenCalledWith(1));
  });

  it("returning to dry-run is reversible, so it stays a single click", async () => {
    mockedApi.automations.mockResolvedValue({ automations: [{ ...ROW, dry_run: false }] });
    renderPage();
    await openRowMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /back to dry-run/i }));

    await waitFor(() => expect(mockedApi.saveAutomation).toHaveBeenCalledTimes(1));
    expect(mockedApi.saveAutomation.mock.calls[0][1]).toMatchObject({ dry_run: true });
  });

  it("does not carry one rule's invalidity over to the next rule opened", async () => {
    mockedApi.validateAutomation.mockResolvedValue({ valid: false, error: "bad rule" });
    renderPage();
    await openRowMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /^edit$/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled(),
    );

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    // Hold the next rule's verdict outstanding, so Save's state can only come
    // from the reset — not from a fresh validation result racing the assertion.
    mockedApi.validateAutomation.mockReturnValue(new Promise(() => {}));
    await openRowMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /^edit$/i }));

    expect(screen.getByRole("button", { name: /save changes/i })).toBeEnabled();
  });

  it("opens the template picker in the sheet instead of stacking it on the page", async () => {
    renderPage();
    // Nothing template-ish is mounted until the user asks to create one.
    expect(screen.queryByText(/pick a starting point/i)).toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: /new automation/i }));

    expect(await screen.findByText(/pick a starting point/i)).toBeInTheDocument();
  });
});
