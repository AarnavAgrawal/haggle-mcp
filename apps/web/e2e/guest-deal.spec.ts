// Tier 2 (local only, needs Docker): a demo guest's whole deal in a real browser. Landing -> "Try the
// demo" (Supabase anonymous sign-in on a local stack) -> chat (scripted fake Claude: dry-run preview,
// then the real deal) -> deal board -> Approve -> booking handoff, against the built MCP server in mock mode.
// No CSP violation on any page. Run it with `node apps/web/e2e/tier2.ts`, which starts every server
// and sets HAGGLE_E2E_TIER2=1 and E2E_BASE_URL; without them this spec skips itself.
import { expect, test } from "@playwright/test";
import { watchCsp, type Violation } from "./csp";

test.skip(process.env.HAGGLE_E2E_TIER2 !== "1", "tier 2 runs through `node apps/web/e2e/tier2.ts` (Docker + local Supabase)");

test("a demo guest starts a deal in chat, approves the recommended quote and reaches the booking step (simulated)", async ({ page }) => {
  test.setTimeout(180_000);
  const csp = await watchCsp(page);
  const seen: Violation[] = [];
  const checkCsp = async () => {
    seen.push(...(await csp.violations()));
    expect(seen, JSON.stringify(seen)).toEqual([]);
    expect(csp.consoleErrors).toEqual([]);
  };

  // 1. Landing on a demo site: the banner and the guest button.
  await page.goto("/");
  await expect(page.getByRole("note").filter({ hasText: /demo/i }).first()).toBeVisible();
  await checkCsp();
  // The hero and the closing section both offer it; the hero's comes first.
  await page.getByRole("button", { name: "Try the demo", exact: true }).first().click();

  // 2. The chat (the guest's workspace is provisioned on the way in).
  await expect(page).toHaveURL(/\/chat/, { timeout: 30_000 });
  const chat = page.getByRole("region", { name: "Chat with Haggle" });
  await expect(chat).toBeVisible();
  await checkCsp();

  // 3. Ask; the fake Claude previews (dry run), then the guest confirms and the deal starts.
  const box = page.getByRole("textbox", { name: "Message Haggle" });
  await box.fill("Cater lunch for 40 people next Thursday in San Francisco, at least 12 vegetarian, under $1,200");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByText(/Reply yes to start/)).toBeVisible({ timeout: 30_000 });
  await expect(box).toBeEnabled();
  await box.fill("Yes, go ahead");
  await page.getByRole("button", { name: "Send" }).click();

  // 4. The deal card's link to the live board. The reply's "DEMO:" shows as the Demo marker (a badge
  // before the sentence), and the board is linked by name, never by its job id.
  const open = page.getByRole("link", { name: "Open deal board" });
  await expect(open).toBeVisible({ timeout: 30_000 });
  const started = chat.locator("p").filter({ hasText: /the deal has started/i });
  await expect(started).toBeVisible({ timeout: 30_000 });
  await expect(started.getByText("Demo", { exact: true })).toBeVisible();
  await expect(chat.getByRole("link", { name: "the deal board" })).toBeVisible();
  await expect(chat.getByText(/job_/)).toHaveCount(0);
  await checkCsp();
  await open.click();

  // 5. The deal page: wait for final quotes, answering any business's question on the way. The mock's
  // simulated sellers move on each server request; the page's 25 s long-poll alone is slow to drive
  // them, so reload while waiting (as a person refreshing would), checking the CSP on every load.
  await expect(page).toHaveURL(/\/deals\/[^/]+$/);
  const quotesHead = page.getByRole("region", { name: "Quotes" });
  let polls = 0;
  await expect(async () => {
    if (polls++) {
      seen.push(...(await csp.violations()));
      await page.reload();
    }
    // The board streams in after its loading skeleton; wait for it before looking for a question.
    await expect(quotesHead).toBeVisible({ timeout: 10_000 });
    const answer = page.getByRole("button", { name: "Send answer" }).first();
    if (await answer.isVisible().catch(() => false)) {
      // Typing before hydration is reset by React (the box is controlled), so retype until Send enables.
      const box = page.locator("form", { has: answer }).locator("textarea");
      await expect(async () => {
        await box.fill("Yes, plates and cutlery for 40 please.");
        await expect(answer).toBeEnabled({ timeout: 500 });
      }).toPass({ timeout: 10_000 });
      await answer.click();
    }
    await expect(quotesHead.getByText("Ready to approve", { exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await checkCsp();

  // 6. Approve the recommended quote (Bay Catering, $5 in mock), then confirm.
  const approve = page.getByRole("button", { name: /^Approve \$/ }).first();
  await expect(approve).toBeVisible({ timeout: 30_000 });
  const amount = (await approve.textContent())!.replace(/^Approve /, "").trim();
  await approve.click();
  await page.getByRole("button", { name: `Yes, approve ${amount}` }).click();
  expect(amount).toBe("$5");

  // 7. Booking before payment (engine since 2026-10-30): approving asks the business to confirm the
  // booking first, so the card shows the handoff steps and no Pay button yet.
  const card = page.getByRole("region", { name: "Bay Catering, approved" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/confirm the booking; don't pay yet/)).toBeVisible();
  await expect(card.getByRole("list", { name: "Purchase progress" })).toBeVisible();
  await expect(card.getByRole("button", { name: "The booking is confirmed" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pay \$/ })).toHaveCount(0);
  await checkCsp();
});
