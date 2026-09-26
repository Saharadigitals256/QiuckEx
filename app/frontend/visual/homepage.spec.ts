import { expect, test, type Page } from "@playwright/test";

async function openHome(page: Page, theme: "light" | "dark") {
  await page.addInitScript((selectedTheme: string) => {
    window.localStorage.setItem("quickex-theme", selectedTheme);
  }, theme);
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("html")).toHaveClass(new RegExp(theme));
}

test("homepage renders in light theme", async ({ page }, testInfo) => {
  await openHome(page, "light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(246, 247, 249)");
  await expect(page.getByText(/STAGING environment/)).toBeVisible();

  const screenshot = await page.screenshot({ fullPage: true, animations: "disabled" });
  expect(screenshot.byteLength).toBeGreaterThan(10_000);
  await testInfo.attach("homepage-light.png", { body: screenshot, contentType: "image/png" });
});

test("homepage renders in dark theme", async ({ page }, testInfo) => {
  await openHome(page, "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(10, 10, 10)");
  await expect(page.getByText(/STAGING environment/)).toBeVisible();

  const screenshot = await page.screenshot({ fullPage: true, animations: "disabled" });
  expect(screenshot.byteLength).toBeGreaterThan(10_000);
  await testInfo.attach("homepage-dark.png", { body: screenshot, contentType: "image/png" });
});

test("staging environment banner is visually present", async ({ page }, testInfo) => {
  await openHome(page, "dark");
  const banner = page.getByText(/STAGING environment/);
  await expect(banner).toBeVisible();
  await expect(banner).toHaveCSS("background-color", "rgb(245, 158, 11)");

  const screenshot = await page.screenshot({ fullPage: true, animations: "disabled" });
  expect(screenshot.byteLength).toBeGreaterThan(10_000);
  await testInfo.attach("homepage-staging.png", { body: screenshot, contentType: "image/png" });
});