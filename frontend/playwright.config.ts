import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against an already-running stack (see .github/workflows/ci.yml
 * smoke_optional job): `docker compose up -d --build`, then
 * `E2E_BASE_URL=http://localhost:8080 npm run test:e2e`.
 * There is deliberately no webServer block — the backend owns the server.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
