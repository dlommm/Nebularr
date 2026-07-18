import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";
import { api, ApiError } from "../api";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      authStatus: vi.fn(),
      authLogin: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api);

function renderLogin(initialPath = "/login"): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>home page</p>} />
          <Route path="/dashboard" element={<p>dashboard page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.authStatus.mockResolvedValue({
      enabled: true,
      password_set: true,
      api_token_set: false,
      authenticated: false,
    });
  });

  it("submits the password and navigates home on success", async () => {
    mockedApi.authLogin.mockResolvedValue({ status: "ok" });
    renderLogin();
    await userEvent.type(screen.getByLabelText("Password"), "hunter2secret");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(mockedApi.authLogin).toHaveBeenCalledWith("hunter2secret");
    expect(await screen.findByText("home page")).toBeInTheDocument();
  });

  it("honours a safe ?next= path after login", async () => {
    mockedApi.authLogin.mockResolvedValue({ status: "ok" });
    renderLogin("/login?next=%2Fdashboard");
    await userEvent.type(screen.getByLabelText("Password"), "hunter2secret");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
  });

  it("ignores absolute ?next= URLs (open-redirect guard)", async () => {
    mockedApi.authLogin.mockResolvedValue({ status: "ok" });
    renderLogin(`/login?next=${encodeURIComponent("https://evil.example")}`);
    await userEvent.type(screen.getByLabelText("Password"), "hunter2secret");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText("home page")).toBeInTheDocument();
  });

  it("shows an error message on a rejected password", async () => {
    mockedApi.authLogin.mockRejectedValue(new Error("invalid password"));
    renderLogin();
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText("Invalid password.")).toBeInTheDocument();
  });

  it("shows a rate-limit message for a 429 ApiError", async () => {
    mockedApi.authLogin.mockRejectedValue(new ApiError(429, "rate limited"));
    renderLogin();
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText("Too many attempts. Try again shortly.")).toBeInTheDocument();
  });

  it("redirects home when auth is disabled", async () => {
    mockedApi.authStatus.mockResolvedValue({
      enabled: false,
      password_set: false,
      api_token_set: false,
      authenticated: true,
    });
    renderLogin();
    await waitFor(() => expect(screen.getByText("home page")).toBeInTheDocument());
  });
});
