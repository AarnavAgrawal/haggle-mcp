// Tier 1, offline: the waitlist form in a real browser. The public stack has no database, so the join
// request is answered here; tests/waitlist.route.test.ts covers the route itself.
import { expect, test, type Page } from "@playwright/test";
import { watchCsp } from "./csp";

const fill = async (page: Page) => {
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Full name").fill("Ada Lovelace");
  await page.getByLabel("Company, organization or school").fill("Analytical Engines");
};
const submit = (page: Page) => page.getByRole("button", { name: "Join the waitlist" }).click();

test("joining shows you're on the list, with no CSP violations", async ({ page }) => {
  const csp = await watchCsp(page);
  let sent: Record<string, unknown> | null = null;
  await page.route("**/api/waitlist", async (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { ok: true, next: "You're on the list." } });
  });
  await page.goto("/waitlist");
  await fill(page);
  await page.getByLabel(/What would you use Haggle for/).fill("Catering for offsites");
  await submit(page);
  await expect(page.getByRole("status")).toContainText("You're on the list");
  await expect(page.getByRole("status")).toContainText("ada@example.com");
  expect(sent).toMatchObject({ email: "ada@example.com", full_name: "Ada Lovelace", organization: "Analytical Engines", use_case: "Catering for offsites", hp_ref: "" });
  expect(await csp.violations()).toEqual([]);
  expect(csp.consoleErrors).toEqual([]);
});

test("a missing field is named next to it and takes focus, and nothing is sent", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/waitlist", async (route) => {
    requests++;
    await route.abort();
  });
  await page.goto("/waitlist");
  await page.getByLabel("Email").fill("ada@example.com");
  await submit(page);
  await expect(page.getByText("Enter your full name.")).toBeVisible();
  await expect(page.getByLabel("Full name")).toBeFocused();
  expect(requests).toBe(0);
});

test("a server refusal says what to do, and keeps what was typed", async ({ page }) => {
  await page.route("**/api/waitlist", (route) => route.fulfill({ status: 429, json: { ok: false, error: { code: "rate_limited", message: "Too many attempts.", fix: "Wait a few minutes, then try again." } } }));
  await page.goto("/waitlist");
  await fill(page);
  await submit(page);
  await expect(page.locator(".wl-form [role=alert]")).toContainText("Wait a few minutes");
  await expect(page.getByLabel("Full name")).toHaveValue("Ada Lovelace");
});

test("the trap field can't be reached by keyboard or seen", async ({ page }) => {
  await page.goto("/waitlist");
  const trap = page.locator('input[name="hp_ref"]');
  await expect(trap).toHaveAttribute("tabindex", "-1");
  await expect(page.locator(".wl-trap")).toHaveAttribute("inert", "");
  const box = await trap.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(0);
});

test("signing in with an unknown email asks for no new account, fails, and lands on the waitlist", async ({ page }) => {
  const csp = await watchCsp(page);
  let sent: Record<string, unknown> | null = null;
  await page.route("**/auth/v1/otp*", async (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 422, json: { code: 422, error_code: "otp_disabled", msg: "Signups not allowed for otp" } });
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill("new@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page).toHaveURL(/\/waitlist\?from=sign-in$/);
  await expect(page.getByRole("status")).toContainText("You don't have a Haggle account yet");
  await expect(page.getByRole("button", { name: "Join the waitlist" })).toBeVisible();
  expect(sent).toMatchObject({ email: "new@example.com", create_user: false });
  expect(await csp.violations()).toEqual([]);
});

test("any other sign-in failure stays on /login and says what went wrong", async ({ page }) => {
  await page.route("**/auth/v1/otp*", (route) => route.fulfill({ status: 429, json: { code: 429, error_code: "over_email_send_rate_limit", msg: "Email rate limit exceeded" } }));
  await page.goto("/login");
  await page.getByLabel("Email").fill("member@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.locator(".auth-error")).toContainText("Email rate limit exceeded");
  await expect(page).toHaveURL(/\/login$/);
});

test("Google sign-in refused for someone new lands on the waitlist too", async ({ page }) => {
  await page.goto("/auth/callback?error=server_error&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance");
  await expect(page).toHaveURL(/\/waitlist\?from=sign-in$/);
  await expect(page.getByRole("status")).toContainText("You don't have a Haggle account yet");
});

test("the form fits a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/waitlist");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
