import { test, expect } from "@playwright/test";

test("loads shell and key views", async ({ page, baseURL }) => {
  await page.goto(baseURL ?? "http://localhost:8080");
  await expect(page.getByText("Nebularr")).toBeVisible();
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.getByText("Drilldown")).toBeVisible();
  await page.getByRole("button", { name: "Manual Actions" }).click();
  await expect(page.getByText("Run Sync")).toBeVisible();
});
