// Reference-screenshot capture for the WebUI.
//
// Every API call is intercepted and answered from webui-capture-fixtures.mjs,
// so these are renders of the *real* React app against *mocked* data — not
// screenshots of a live instance. No request ever leaves the browser for a
// backend, which is what makes this safe to point at a dev server.
//
// Default run (what docs/reference/webui-pages holds): dark theme, 1720×1080,
// healthy scenario. The matrix knobs below widen it for design reviews:
//
//   WEBUI_CAPTURE_BASE_URL    dev server (default http://127.0.0.1:4173)
//   WEBUI_CAPTURE_OUTPUT_DIR  output root (default docs/reference/webui-pages)
//   WEBUI_CAPTURE_THEME       light | dark | light,dark       (default dark)
//   WEBUI_CAPTURE_VIEWPORTS   reference,desktop,large,tablet,mobile (default reference)
//   WEBUI_CAPTURE_SCENARIOS   healthy,degraded,empty          (default healthy)
//   WEBUI_CAPTURE_ONLY        comma list of capture names to restrict to
//   WEBUI_CAPTURE_DENSITY     compact to capture compact density
//
// With more than one theme/viewport/scenario, files land in
// <output>/<scenario>/<theme>/<viewport>/<name>.png; a single combination
// keeps the flat <output>/<name>.png layout the docs link to.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { routeResponse } from "./webui-capture-fixtures.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const outputDir = process.env.WEBUI_CAPTURE_OUTPUT_DIR ?? join(repoRoot, "docs", "reference", "webui-pages");
const baseUrl = process.env.WEBUI_CAPTURE_BASE_URL ?? "http://127.0.0.1:4173";

const VIEWPORTS = {
  reference: { width: 1720, height: 1080 },
  desktop: { width: 1440, height: 900 },
  large: { width: 1920, height: 1080 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

const list = (value, fallback) =>
  (value ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const themes = list(process.env.WEBUI_CAPTURE_THEME, "dark");
const viewports = list(process.env.WEBUI_CAPTURE_VIEWPORTS, "reference");
const scenarios = list(process.env.WEBUI_CAPTURE_SCENARIOS, "healthy");
const only = process.env.WEBUI_CAPTURE_ONLY ? new Set(list(process.env.WEBUI_CAPTURE_ONLY, "")) : null;
const density = process.env.WEBUI_CAPTURE_DENSITY === "compact" ? "compact" : "comfortable";

/** `name` is the PNG basename; `ctx` flags flip fixture behavior per capture;
    `needsData` captures are skipped in the empty scenario. */
const captures = [
  { name: "home", path: "/", waitFor: "main h1, main h2" },
  { name: "library", path: "/library", waitFor: "#main-content [role=tablist]" },
  {
    name: "library-episodes",
    path: "/library?show=501%7Cprimary%7CNova%20Academy",
    waitFor: "#main-content [role=tablist]",
  },
  { name: "library-all-episodes", path: "/library?mode=all-episodes", waitFor: "#main-content [role=tablist]" },
  { name: "library-movies", path: "/library?mode=movies", waitFor: "#main-content [role=tablist]" },
  {
    name: "library-detail",
    needsData: true,
    path: "/library?mode=movies",
    waitFor: "text=The Last Orbit",
    act: async (page) => {
      await page.getByText("The Last Orbit", { exact: true }).first().click();
      await page.waitForSelector('[aria-label="Media details"]');
    },
  },
  {
    name: "library-compare",
    needsData: true,
    path: "/library?mode=all-episodes",
    waitFor: "text=Welcome Cadets",
    act: async (page) => {
      const toggle = page.getByRole("checkbox", { name: /compare/i });
      if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
      // A picked row's button flips to "Remove", so the second pick is the
      // next remaining "Compare" after skipping one row.
      const buttons = page.getByRole("button", { name: /^compare$/i });
      await buttons.nth(0).click();
      await buttons.nth(1).click();
      await page.waitForTimeout(300);
    },
  },
  { name: "reporting", path: "/reporting", waitFor: "main h1" },
  { name: "reporting-storage", path: "/reporting?dash=storage-growth", waitFor: "text=Library Size Over Time" },
  { name: "sync-overview", path: "/sync", waitFor: "text=The last 24 hours" },
  { name: "sync-runs", path: "/sync?tab=runs", waitFor: "text=Run history" },
  { name: "sync-webhooks", path: "/sync?tab=webhooks", waitFor: "text=Webhook jobs" },
  { name: "sync-manual", path: "/sync?tab=manual", waitFor: "text=On-demand sync" },
  { name: "automations", path: "/automations", waitFor: "#main-content [data-slot=card]" },
  {
    name: "automations-editor",
    needsData: true,
    path: "/automations",
    waitFor: "text=Resolution floor — 1080p",
    act: async (page) => {
      await page.getByRole("button", { name: "Resolution floor — 1080p" }).first().click();
      await page.waitForSelector('[aria-label="Automation"]');
      await page.waitForTimeout(700);
    },
  },
  {
    name: "automations-run-detail",
    needsData: true,
    path: "/automations",
    waitFor: "text=Anime English-dub enforcer",
    act: async (page) => {
      await page.getByRole("button", { name: /more actions for anime english-dub enforcer/i }).click();
      await page.getByRole("menuitem", { name: /run history/i }).click();
      await page.waitForSelector('[aria-label="Automation"]');
      await page.getByRole("button", { name: /^detail$/i }).first().click();
      await page.waitForTimeout(500);
    },
  },
  { name: "mal", path: "/mal", waitFor: "#main-content [data-slot=card]" },
  { name: "integrations", path: "/integrations", waitFor: "#main-content [data-slot=card], #main-content section" },
  { name: "schedules", path: "/schedules", waitFor: "#main-content [data-slot=card], #main-content section" },
  { name: "logs", path: "/logs", waitFor: "#main-content [data-slot=card], #main-content section" },
  { name: "setup", path: "/setup", waitFor: "text=Setup", ctx: { setupIncomplete: true } },
  { name: "login", path: "/login", waitFor: "input[type=password]", ctx: { loggedOut: true } },
  { name: "artwork", path: "/artwork", waitFor: "text=How to load it" },
  { name: "not-found", path: "/does-not-exist", waitFor: "text=Not here" },
];

function outPath(scenario, theme, viewport, name) {
  const matrix = themes.length > 1 || viewports.length > 1 || scenarios.length > 1;
  return matrix ? join(outputDir, scenario, theme, viewport, `${name}.png`) : join(outputDir, `${name}.png`);
}

async function captureOne(browser, { scenario, theme, viewport, capture }) {
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport], reducedMotion: "reduce" });
  await context.addInitScript(
    ({ t, d }) => {
      window.localStorage.setItem("nebularr-ui-theme", t);
      window.localStorage.setItem("nebularr.ui.density", JSON.stringify(d));
      window.localStorage.setItem("nebularr.onboarding.dismissed", "false");
    },
    { t: theme, d: density },
  );
  const ctx = { scenario, ...(capture.ctx ?? {}) };
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const response = routeResponse(url.pathname, url.search, ctx);
    if (response) await route.fulfill(response);
    else await route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}${capture.path}`, { waitUntil: "networkidle" });
    await page.waitForSelector(capture.waitFor, { timeout: 15_000 });
    if (capture.act) await capture.act(page);
    await page.waitForTimeout(400);
    const file = outPath(scenario, theme, viewport, capture.name);
    await mkdir(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
    return null;
  } catch (err) {
    return `${scenario}/${theme}/${viewport}/${capture.name}: ${err instanceof Error ? err.message.split("\n")[0] : err}`;
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch();
  const failures = [];
  let saved = 0;
  for (const scenario of scenarios) {
    for (const theme of themes) {
      for (const viewport of viewports) {
        for (const capture of captures) {
          if (only && !only.has(capture.name)) continue;
          // Interactions that open a row cannot run against an empty library.
          if (capture.needsData && scenario === "empty") continue;
          const failure = await captureOne(browser, { scenario, theme, viewport, capture });
          if (failure) failures.push(failure);
          else saved += 1;
        }
      }
    }
  }
  await browser.close();
  console.log(`Saved ${saved} screenshots to ${outputDir}`);
  if (failures.length) {
    console.error(`${failures.length} capture(s) failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
