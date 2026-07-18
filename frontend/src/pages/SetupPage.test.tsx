import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupPage } from "./SetupPage";
import { ActionErrorProvider } from "../context/ActionErrorContext";
import { api, ApiError } from "../api";
import type { SetupStatus } from "../types";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      setupStatus: vi.fn(),
      setupInitializePostgres: vi.fn(),
      setupSkip: vi.fn(),
      setupWizard: vi.fn(),
      setupInitialSync: vi.fn(),
      authLogin: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api);

const NOT_READY_STATUS: SetupStatus = {
  completed: false,
  has_webhook_secret: false,
  integrations: {},
  schedules: [],
  database: { engine_ready: false, runtime_url_persisted: false, arrapp_role_exists: false },
  bootstrap_token_required: false,
};

const READY_STATUS: SetupStatus = {
  ...NOT_READY_STATUS,
  database: { engine_ready: true, runtime_url_persisted: true, arrapp_role_exists: true },
};

/** Walks the wizard from step 1 (PostgreSQL) to the final Review step,
    checking "run without authentication" at the Security step so Next isn't
    blocked there. Assumes `engineReady` is already true (READY_STATUS). */
async function goToReviewStep(): Promise<void> {
  await screen.findByText(/step 1 of/i);
  for (let i = 0; i < 4; i++) {
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
  }
  await userEvent.click(screen.getByRole("checkbox", { name: /run without authentication/i }));
  await userEvent.click(screen.getByRole("button", { name: "Next" })); // Security -> Initial Sync
  await userEvent.click(screen.getByRole("button", { name: "Next" })); // Initial Sync -> Review
  await screen.findByText(/step 7 of/i);
}

function renderSetup(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ActionErrorProvider>
        <MemoryRouter initialEntries={["/setup"]}>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/" element={<p>home page</p>} />
          </Routes>
        </MemoryRouter>
      </ActionErrorProvider>
    </QueryClientProvider>,
  );
}

describe("SetupPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.setupStatus.mockResolvedValue(NOT_READY_STATUS);
  });

  it("keeps the port field editable when cleared, instead of snapping back to 5432", async () => {
    renderSetup();
    const portInput = (await screen.findByPlaceholderText("Port")) as HTMLInputElement;
    expect(portInput.value).toBe("5432");

    await userEvent.clear(portInput);
    expect(portInput.value).toBe("");

    await userEvent.type(portInput, "6543");
    expect(portInput.value).toBe("6543");
  });

  it("parses the port draft to a number only on submit", async () => {
    mockedApi.setupInitializePostgres.mockResolvedValue({ status: "ok", restart_recommended: false });
    renderSetup();
    const portInput = (await screen.findByPlaceholderText("Port")) as HTMLInputElement;
    await userEvent.clear(portInput);
    await userEvent.type(portInput, "6543");

    await userEvent.click(screen.getByRole("button", { name: /wait for postgres/i }));

    await waitFor(() => expect(mockedApi.setupInitializePostgres).toHaveBeenCalledTimes(1));
    const [payload] = mockedApi.setupInitializePostgres.mock.calls[0];
    expect(payload.port).toBe(6543);
  });

  it("gives every setup input an accessible name", async () => {
    renderSetup();
    for (const name of ["Host", "Port", "Database name", "Username", "Password"]) {
      expect(await screen.findByLabelText(name)).toBeInTheDocument();
    }
  });

  it("makes Skip for now reachable from step 1, not only the final step", async () => {
    mockedApi.setupStatus.mockResolvedValue(READY_STATUS);
    mockedApi.setupSkip.mockResolvedValue({ status: "ok", completed: true });
    renderSetup();

    // Still on step 1 (PostgreSQL) — Skip must already be present and enabled.
    expect(await screen.findByText(/step 1 of/i)).toBeInTheDocument();
    const skipButton = screen.getByRole("button", { name: "Skip for now" });
    expect(skipButton).toBeEnabled();

    await userEvent.click(skipButton);
    expect(await screen.findByText("home page")).toBeInTheDocument();
    expect(mockedApi.setupSkip).toHaveBeenCalledTimes(1);
  });

  it("shows a setup-token input when bootstrap_token_required is true and sends it as X-Setup-Token on mutations", async () => {
    mockedApi.setupStatus.mockResolvedValue({ ...READY_STATUS, bootstrap_token_required: true });
    mockedApi.setupSkip.mockResolvedValue({ status: "ok", completed: true });
    renderSetup();

    const tokenInput = await screen.findByLabelText("Setup token required");
    await userEvent.type(tokenInput, "printed-in-container-log");

    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(mockedApi.setupSkip).toHaveBeenCalledWith("printed-in-container-log"));
  });

  it("does not send a token when bootstrap_token_required is false", async () => {
    mockedApi.setupStatus.mockResolvedValue(READY_STATUS);
    mockedApi.setupSkip.mockResolvedValue({ status: "ok", completed: true });
    renderSetup();

    const skipButton = await screen.findByRole("button", { name: "Skip for now" });
    expect(screen.queryByLabelText("Setup token required")).not.toBeInTheDocument();
    await userEvent.click(skipButton);
    await waitFor(() => expect(mockedApi.setupSkip).toHaveBeenCalledWith(undefined));
  });

  // SetupPage renders outside AppLayout, so neither the shared DiagnosticsPanel
  // nor toasts reach it — every mutating action needs its own inline surface.
  describe("inline error surfacing", () => {
    it("renders the backend's detail text when wizard submit fails (e.g. a missing/invalid setup token)", async () => {
      mockedApi.setupStatus.mockResolvedValue(READY_STATUS);
      mockedApi.setupWizard.mockRejectedValue(new ApiError(403, "missing or invalid X-Setup-Token header"));
      renderSetup();

      await goToReviewStep();
      await userEvent.click(screen.getByRole("button", { name: "Complete setup" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("missing or invalid X-Setup-Token header");
    });

    it("renders the backend's detail text when Skip fails", async () => {
      mockedApi.setupStatus.mockResolvedValue(READY_STATUS);
      mockedApi.setupSkip.mockRejectedValue(new ApiError(403, "missing or invalid X-Setup-Token header"));
      renderSetup();

      await userEvent.click(await screen.findByRole("button", { name: "Skip for now" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("missing or invalid X-Setup-Token header");
    });

    it("renders the backend's detail text when initializing Postgres fails", async () => {
      mockedApi.setupInitializePostgres.mockRejectedValue(new ApiError(504, "Postgres did not become ready in time"));
      renderSetup();

      await userEvent.click(await screen.findByRole("button", { name: /wait for postgres/i }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Postgres did not become ready in time");
    });

    it("clears a previous inline error once a new attempt is made", async () => {
      mockedApi.setupInitializePostgres
        .mockRejectedValueOnce(new ApiError(500, "connection refused"))
        .mockResolvedValueOnce({ status: "ok", restart_recommended: false });
      renderSetup();

      const connectButton = await screen.findByRole("button", { name: /wait for postgres/i });
      await userEvent.click(connectButton);
      expect(await screen.findByRole("alert")).toHaveTextContent("connection refused");

      await userEvent.click(connectButton);
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    });
  });
});
