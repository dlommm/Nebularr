import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs against a real stack (docker compose up with the bundled postgres), e.g.:
 *   E2E_BASE_URL=http://localhost:8080 npm run test:e2e
 * Assumes a FRESH database: the first test walks the first-run setup wizard.
 */

// This spec lives at frontend/tests/e2e; the compose project root is three up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * On a fresh install the backend issues a one-time X-Setup-Token (main.py logs a
 * startup WARNING "Setup bootstrap token: <token>") that gates every mutating
 * /api/setup/* call until setup completes. We recover it exactly as an operator
 * would — by reading the container's startup log — so the e2e enters the real
 * token and exercises the security gate honestly rather than bypassing it.
 * E2E_SETUP_TOKEN overrides when the log is not reachable from the test process.
 */
function readSetupBootstrapToken(): string {
  const override = process.env.E2E_SETUP_TOKEN?.trim();
  if (override) return override;
  const logs = execSync("docker compose logs app", {
    cwd: repoRoot,
    encoding: "utf8",
    // Ignore stderr so compose's profile warnings can't corrupt the captured logs.
    stdio: ["ignore", "pipe", "ignore"],
  });
  // token_urlsafe → [A-Za-z0-9_-]; take the last match in case the app restarted.
  const matches = [...logs.matchAll(/Setup bootstrap token:\s+([A-Za-z0-9_-]+)/g)];
  const token = matches.at(-1)?.[1];
  if (!token) {
    throw new Error(
      "Could not find the setup bootstrap token in `docker compose logs app`. " +
        "Run the stack from the repo root, or set E2E_SETUP_TOKEN.",
    );
  }
  return token;
}

test.describe.configure({ mode: "serial" });

test("fresh install walks the setup wizard and lands in the shell", async ({ page, baseURL }) => {
  const root = baseURL ?? "http://localhost:8080";

  await page.goto(root);
  await expect(page.getByText("First-time setup")).toBeVisible();

  // Fresh install: the server gates every mutating setup call behind a one-time
  // X-Setup-Token. Enter it (recovered from the container log) before anything
  // else so initialize-postgres carries the header instead of 403-ing.
  const tokenField = page.getByPlaceholder("Setup token from the container log");
  await expect(tokenField).toBeVisible({ timeout: 30_000 });
  await tokenField.fill(readSetupBootstrapToken());

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
  // Wait for the login response (which carries the session Set-Cookie) before the
  // next hard navigation — otherwise goto() races the cookie and the SPA, still
  // unauthenticated, bounces straight back to /login.
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);

  await page.goto(`${root}/library`);
  await expect(page.getByText("TV shows")).toBeVisible();

  await page.goto(`${root}/sync?tab=manual`);
  await expect(page.getByText("On-demand sync")).toBeVisible();

  await page.goto(`${root}/reporting`);
  await expect(page.getByText("Overview").first()).toBeVisible();
});

test("healthz reports ok with auth enabled", async ({ request, baseURL }) => {
  const root = baseURL ?? "http://localhost:8080";
  const response = await request.get(`${root}/healthz`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.status).toBe("ok");
  expect(body.auth).toBe("enabled");
});
