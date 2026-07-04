import { test, expect } from "@playwright/test";

/**
 * Runs against a real stack (docker compose up with the bundled postgres), e.g.:
 *   E2E_BASE_URL=http://localhost:8080 npm run test:e2e
 * Assumes a FRESH database: the first test walks the first-run setup wizard.
 */

test.describe.configure({ mode: "serial" });

test("fresh install walks the setup wizard and lands in the shell", async ({ page, baseURL }) => {
  const root = baseURL ?? "http://localhost:8080";

  await page.goto(root);
  await expect(page.getByText("First-time setup")).toBeVisible();

  // Step 1: PostgreSQL — compose defaults are prefilled except the password.
  await page.getByPlaceholder("Password", { exact: true }).fill(process.env.E2E_POSTGRES_PASSWORD ?? "arradmin");
  await page.getByRole("button", { name: /wait for postgres/i }).click();
  await expect(page.getByText("Database is connected and migrations are ready.")).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Next" }).click();

  // Step 2 + 3: skip Sonarr and Radarr (no Arr instances in CI).
  await page.getByText("skip this for now").click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByText("skip this for now").click();
  await page.getByRole("button", { name: "Next" }).click();

  // Step 4: webhook + schedule — leave defaults.
  await page.getByRole("button", { name: "Next" }).click();

  // Step 5: security — set an admin password (exercises the auth path end-to-end).
  await page.getByPlaceholder("Admin password (min 8 characters)").fill("e2e-admin-password");
  await page.getByPlaceholder("Confirm password").fill("e2e-admin-password");
  await page.getByRole("button", { name: "Next" }).click();

  // Step 6: initial sync — nothing to sync; continue to review and complete.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Authentication: enabled")).toBeVisible();
  await page.getByRole("button", { name: "Complete setup" }).click();

  // The wizard auto-logs-in with the new password and lands in the app shell.
  await expect(page.getByText("Nebularr").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: /^home$/i })).toBeVisible();
});

test("authenticated navigation renders the key views", async ({ page, baseURL }) => {
  const root = baseURL ?? "http://localhost:8080";

  // A fresh browser context has no session; the API 401s and the SPA routes to /login.
  await page.goto(`${root}/dashboard`);
  await expect(page.getByLabel("Password")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Password").fill("e2e-admin-password");
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.goto(`${root}/library`);
  await expect(page.getByText("TV shows")).toBeVisible();

  await page.goto(`${root}/sync?tab=manual`);
  await expect(page.getByText("On-demand sync")).toBeVisible();

  await page.goto(`${root}/reporting`);
  await expect(page.getByText("Overview")).toBeVisible();
});

test("healthz reports ok with auth enabled", async ({ request, baseURL }) => {
  const root = baseURL ?? "http://localhost:8080";
  const response = await request.get(`${root}/healthz`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.status).toBe("ok");
  expect(body.auth).toBe("enabled");
});
