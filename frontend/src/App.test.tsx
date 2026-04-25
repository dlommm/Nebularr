import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    api: {
      ...actual.api,
      setupStatus: () =>
        Promise.resolve({
          completed: true,
          has_webhook_secret: false,
          integrations: {},
          schedules: [],
        } satisfies Awaited<ReturnType<typeof actual.api.setupStatus>>),
    },
  };
});

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

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nebularr shell with home in nav", async () => {
    renderApp();
    expect(await screen.findByText("Nebularr")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /home/i }).length).toBeGreaterThan(0);
  });
});
