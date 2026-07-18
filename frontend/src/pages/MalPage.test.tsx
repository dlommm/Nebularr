import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MalPage } from "./MalPage";
import { ActionErrorProvider } from "../context/ActionErrorContext";
import { api } from "../api";
import type { MalConfigResponse, MalJobRunRow, MalOverview, WorkStatusResponse } from "../types";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      malConfig: vi.fn(),
      malOverview: vi.fn(),
      malJobRuns: vi.fn(),
      workStatus: vi.fn(),
      triggerMalIngest: vi.fn(),
      triggerMalIngestBacklog: vi.fn(),
      triggerMalMatchRefresh: vi.fn(),
      triggerMalTagSync: vi.fn(),
      triggerCoverageTagSync: vi.fn(),
      status: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api);

const BASE_CONFIG: MalConfigResponse = {
  client_id_configured: true,
  env_fallback_configured: false,
  ingest_enabled: true,
  matcher_enabled: true,
  tagging_enabled: true,
  allow_title_year_match: false,
  source_mal_dubs_enabled: true,
  source_mydublist_enabled: true,
  coverage_tagging_enabled: false,
  mydublist_tier: "normal",
  mal_max_ids_per_run: 200,
  mal_min_request_interval_seconds: 1,
  mal_jikan_min_request_interval_seconds: 1,
};

const BASE_OVERVIEW: MalOverview = {
  dubbed_total: 10,
  partial_total: 0,
  source_counts: {},
  coverage: {},
  fetched_success: 8,
  pending_fetch: 2,
  linked: 5,
  unlinked: 3,
  manual_link_count: 0,
  unmatched: [],
};

const EMPTY_WORK_STATUS: WorkStatusResponse = {
  active: false,
  items: [],
  warehouse_running: false,
  mal_running: false,
  setup_running: false,
};

/** The batch-size input's `useState("200")` default happens to match the
    mocked server default, so `findByDisplayValue("200")`/`findByTitle(...)`
    can resolve on the very first render — before the async `malConfig` query
    settles and its populate-once effect fires, which would then stomp
    whatever the test just typed. Wait for malConfig-derived render output
    first so the effect has already run before interacting with the field. */
async function findBatchInput(): Promise<HTMLInputElement> {
  await screen.findByText(/default from server: 200 per batch/i);
  return screen.getByTitle("MAL_MAX_IDS_PER_RUN override for this action (1–500)") as HTMLInputElement;
}

function renderMalPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ActionErrorProvider>
        <MemoryRouter>
          <MalPage />
        </MemoryRouter>
      </ActionErrorProvider>
    </QueryClientProvider>,
  );
}

describe("MalPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.malConfig.mockResolvedValue(BASE_CONFIG);
    mockedApi.malOverview.mockResolvedValue(BASE_OVERVIEW);
    mockedApi.malJobRuns.mockResolvedValue([] as MalJobRunRow[]);
    mockedApi.workStatus.mockResolvedValue(EMPTY_WORK_STATUS);
    mockedApi.status.mockResolvedValue({} as never);
  });

  it("disables every pipeline button while a trigger is in flight and fires the trigger only once on a double click", async () => {
    // A mutable holder (rather than a bare `let`) sidesteps a TS control-flow
    // narrowing quirk where a variable reassigned only inside a closure gets
    // narrowed to `never` at the call site below.
    const trigger: { resolve: (() => void) | null } = { resolve: null };
    mockedApi.triggerMalIngest.mockImplementation(
      () =>
        new Promise<{ status: string; details: unknown }>((resolve) => {
          trigger.resolve = () => resolve({ status: "ok", details: {} });
        }),
    );

    renderMalPage();
    const ingestButton = await screen.findByRole("button", { name: "Run MAL ingest" });
    const matchButton = await screen.findByRole("button", { name: "Run match refresh" });

    // Two rapid clicks before the promise resolves — the guard must let only
    // one trigger through, and disable every other pipeline button meanwhile.
    fireEvent.click(ingestButton);
    fireEvent.click(ingestButton);

    await waitFor(() => expect(ingestButton).toBeDisabled());
    expect(matchButton).toBeDisabled();
    expect(mockedApi.triggerMalIngest).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/MAL pipeline is running/i)).toBeInTheDocument();

    trigger.resolve?.();
    await waitFor(() => expect(ingestButton).not.toBeDisabled());
    expect(mockedApi.triggerMalIngest).toHaveBeenCalledTimes(1);
  });

  it("preserves an operator's edited batch size across a background malConfig refetch", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ActionErrorProvider>
          <MemoryRouter>
            <MalPage />
          </MemoryRouter>
        </ActionErrorProvider>
      </QueryClientProvider>,
    );

    const batchInput = await findBatchInput();
    await userEvent.clear(batchInput);
    await userEvent.type(batchInput, "350");
    await waitFor(() => expect(screen.getByDisplayValue("350")).toBeInTheDocument());

    // Simulate a server-driven refetch (e.g. saved on the Integrations page,
    // or a routine background refetch) that would otherwise clobber the draft.
    mockedApi.malConfig.mockResolvedValue({ ...BASE_CONFIG, mal_max_ids_per_run: 100 });
    await queryClient.invalidateQueries({ queryKey: ["mal-config"] });

    await waitFor(() => expect(mockedApi.malConfig).toHaveBeenCalledTimes(2));
    expect(screen.getByDisplayValue("350")).toBeInTheDocument();
  });

  it("keeps the batch-size input editable when cleared, instead of snapping back to the server default", async () => {
    renderMalPage();
    const batchInput = await findBatchInput();

    await userEvent.clear(batchInput);
    expect(batchInput.value).toBe("");

    await userEvent.type(batchInput, "350");
    expect(batchInput.value).toBe("350");
  });

  it("parses the batch-size draft to a clamped number only when a pipeline is triggered", async () => {
    mockedApi.triggerMalIngest.mockResolvedValue({ status: "ok", details: {} });
    renderMalPage();
    const batchInput = await findBatchInput();

    await userEvent.clear(batchInput);
    await userEvent.type(batchInput, "999999"); // well above the 500 cap

    await userEvent.click(screen.getByRole("button", { name: "Run MAL ingest" }));
    await waitFor(() => expect(mockedApi.triggerMalIngest).toHaveBeenCalledWith({ max_ids_per_run: 500 }));
  });
});
