import { test, expect } from "@playwright/test";

test("loads shell, navigates by URL, and key views render", async ({ page, baseURL }) => {
  const root = baseURL ?? "http://localhost:8080";
  await page.goto(root);
  await expect(page.getByText("Nebularr")).toBeVisible();
  await expect(page.getByRole("link", { name: /^home$/i })).toBeVisible();

  await page.goto(`${root}/library`);
  await expect(page.getByText("Drilldown")).toBeVisible();

  await page.goto(`${root}/actions`);
  await expect(page.getByText("Run sync", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("Run sync", { exact: true })).toBeVisible();
});
