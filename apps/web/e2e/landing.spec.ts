// Tier 1, offline: the landing page's presentation in a real browser. The wordmark leads the page,
// scrolling the log marks up the example quote sheet step by step, the page holds up on a phone, and
// with reduced motion everything is simply there. public.spec.ts covers the CSP on a plain load.
import { expect, test, type Page } from "@playwright/test";
import { watchCsp } from "./csp";

const LAST_STEP = 8;

/** Scroll one log entry to the middle of the window and wait for the sheet to reach its step. */
async function scrollToStep(page: Page, step: number) {
  await page.locator(".log-row").nth(step).evaluate((row) => {
    window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2, behavior: "instant" });
  });
  await expect(page.locator(".deal")).toHaveAttribute("data-step", String(step));
}

test("Haggle is the first and largest thing on the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "networkidle" });
  const box = (await page.locator(".lp-wordmark").boundingBox())!;
  expect(box.width).toBeGreaterThan(1440 * 0.5);
  expect(box.y + box.height).toBeLessThan(900);
  await expect(page.getByRole("heading", { level: 1, name: /haggle.*real quotes from real businesses/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Get started" }).first()).toHaveAttribute("href", "/login");
});

test("the top bar links to each section and marks where you are", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "networkidle" });
  const nav = page.getByRole("navigation", { name: "Sections" });
  for (const name of ["How it works", "Channels", "Promises"]) {
    const link = nav.getByRole("link", { name });
    await link.click();
    await expect(link).toHaveAttribute("aria-current", "true");
  }
});

test("scrolling the log marks up the sheet, and scrolling back undoes it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const csp = await watchCsp(page);
  await page.goto("/", { waitUntil: "networkidle" });
  const deal = page.locator(".deal");
  await expect(deal).toHaveAttribute("data-step", "0");

  const strike = page.locator(".qs-was .pen-struck-svg");
  const circle = page.locator(".qs-best .pen-circled-svg");

  await scrollToStep(page, 5);
  await expect(strike).toHaveCSS("opacity", "0");

  await scrollToStep(page, 6);
  await expect(strike).toHaveCSS("opacity", "1");
  await expect(circle).toHaveCSS("opacity", "0");

  await scrollToStep(page, LAST_STEP);
  await expect(circle).toHaveCSS("opacity", "1");
  await expect(page.locator(".qs-approved")).toHaveCSS("opacity", "1");

  // The sheet stayed in the window for the whole log.
  const sheet = (await page.locator(".qs").boundingBox())!;
  expect(sheet.y).toBeGreaterThanOrEqual(0);
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(900);

  await scrollToStep(page, 2);
  await expect(strike).toHaveCSS("opacity", "0");

  expect(await csp.violations()).toEqual([]);
  expect(csp.consoleErrors).toEqual([]);
});

test("with reduced motion the sheet is already marked up and nothing waits for a scroll", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator(".qs-was .pen-struck-svg")).toHaveCSS("opacity", "1");
  await expect(page.locator(".qs-best .pen-circled-svg")).toHaveCSS("opacity", "1");
  await expect(page.locator(".qs-approved")).toHaveCSS("opacity", "1");
  for (const el of await page.locator("[data-reveal]").all()) await expect(el).toHaveCSS("opacity", "1");
  expect(await page.locator(".qs").evaluate((el) => getComputedStyle(el).transform)).toBe("none");
});

for (const width of [360, 768, 1024]) {
  test(`nothing runs off the side at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.goto("/", { waitUntil: "networkidle" });
    for (const fraction of [0, 0.35, 0.7, 1]) {
      await page.evaluate((f) => window.scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) * f, behavior: "instant" }), fraction);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });
}
