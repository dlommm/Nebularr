import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api, ApiError } from "./api";

const DEFAULT_SETUP_STATUS = {
  completed: true,
  has_webhook_secret: false,
  integrations: {},
  schedules: [],
  database: {
    engine_ready: true,
    runtime_url_persisted: true,
    arrapp_role_exists: true,
  },
  bootstrap_token_required: false,
};

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    api: {
      ...actual.api,
      setupStatus: vi.fn(() =>
        Promise.resolve(DEFAULT_SETUP_STATUS satisfies Awaited<ReturnType<typeof actual.api.setupStatus>>),
      ),
      authLogin: vi.fn(() => Promise.resolve({ status: "ok" })),
    },
  };
});

// Toggled per-test so RouteErrorBoundary has something to catch; declared via
// vi.hoisted since vi.mock factories are hoisted above normal module code.
const dashboardMock = vi.hoisted(() => ({ shouldThrow: false }));
vi.mock("./pages/DashboardPage", () => ({
  DashboardPage: () => {
    if (dashboardMock.shouldThrow) throw new Error("dashboard exploded");
    return <div>dashboard-ok</div>;
  },
}));

function renderApp(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function renderAppAt(initialPath: string): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.setupStatus).mockResolvedValue(
      DEFAULT_SETUP_STATUS satisfies Awaited<ReturnType<typeof api.setupStatus>>,
    );
    dashboardMock.shouldThrow = false;
  });

  it("renders nebularr shell with home in nav", async () => {
    renderApp();
    expect(await screen.findByText("Nebularr")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /home/i }).length).toBeGreaterThan(0);
  });

  it("RequireSetup shows QueryErrorNotice with a working retry when setup status fails to load", async () => {
    const setupStatusMock = vi.mocked(api.setupStatus);
    setupStatusMock.mockRejectedValueOnce(new Error("setup status unreachable"));
    renderApp();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not load setup status/i);
    expect(alert).toHaveTextContent(/setup status unreachable/i);

    // Retry re-runs the query; once it resolves, the real app shell renders.
    const callsBeforeRetry = setupStatusMock.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => expect(setupStatusMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry));
    // Use the page heading (not the ambiguous "Nebularr" sidebar text, which
    // also appears here) to confirm the real shell rendered post-retry.
    expect(await screen.findByRole("heading", { name: "Nebularr" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends a cold-load 401 from setup status to a login affordance, not a dead end", async () => {
    // On an auth-enabled box, a session-less cold load 401s on /api/setup/status
    // (not auth-exempt). RequireSetup must route to login rather than stranding
    // the user on a QueryErrorNotice with a retry that will only 401 again.
    vi.mocked(api.setupStatus).mockRejectedValueOnce(new ApiError(401, "authentication required"));
    renderApp();

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not reopen the session-expired dialog after a successful re-login", async () => {
    // App never unmounts, so the sessionExpired latch must clear on arrival at
    // /login — otherwise re-logging in navigates back into the app with the
    // undismissable dialog still open over the authenticated shell.
    vi.mocked(api.authLogin).mockResolvedValue({ status: "ok" });
    renderAppAt("/");
    expect(await screen.findByRole("heading", { name: "Nebularr" })).toBeInTheDocument();

    // Session expires mid-task: the forced re-login dialog appears.
    act(() => {
      window.dispatchEvent(new CustomEvent("nebularr:session-expired"));
    });
    expect(await screen.findByText(/session expired/i)).toBeInTheDocument();

    // Follow the dialog's only affordance to the login page; the dialog clears.
    await userEvent.click(screen.getByRole("button", { name: /^log in$/i }));
    const passwordField = await screen.findByLabelText(/password/i);
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();

    // Complete a successful login and return to the authenticated app.
    await userEvent.type(passwordField, "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    // The dialog must NOT reopen over the shell.
    expect(await screen.findByRole("heading", { name: "Nebularr" })).toBeInTheDocument();
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
  });

  describe("RouteErrorBoundary", () => {
    afterEach(() => {
      dashboardMock.shouldThrow = false;
    });

    it("catches a render error on one route and recovers via key-remount after navigating away", async () => {
      // React (and this file's own componentDidCatch) log the caught render
      // error to console.error — expected here, so keep it out of test output.
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      dashboardMock.shouldThrow = true;

      renderAppAt("/dashboard");
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/something went wrong/i);

      // Without `key={location.pathname}` on RouteErrorBoundary, this cached
      // error state would persist across the navigation below even though
      // the destination route's component never throws.
      dashboardMock.shouldThrow = false;
      await userEvent.click(screen.getAllByRole("link", { name: /^home$/i })[0]);

      expect(await screen.findByRole("heading", { name: "Nebularr" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      consoleErrorSpy.mockRestore();
    });
  });
});
