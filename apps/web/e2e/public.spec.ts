// Tier 1, offline: the public pages in a real browser under the per-request nonce CSP (proxy.ts,
// lib/csp.ts). Each page renders, the browser reports no CSP violation and no CSP console error, every
// <script> carries the response's nonce, two loads get different nonces, and a signed-out visit to a
// protected page is redirected to /login with a policy on the redirect too.
import { expect, test } from "@playwright/test";
import { NONCE_RE, watchCsp } from "./csp";

const PAGES: { path: string; heading: RegExp }[] = [
  { path: "/", heading: /real quotes from real businesses/i },
  { path: "/login", heading: /sign in/i },
  { path: "/terms", heading: /terms/i },
  { path: "/privacy", heading: /privacy/i },
  { path: "/acceptable-use", heading: /acceptable use/i },
];

for (const { path, heading } of PAGES) {
  test(`${path} renders under the nonce CSP with no violation`, async ({ page }) => {
    const csp = await watchCsp(page);
    const res = await page.goto(path, { waitUntil: "networkidle" });
    expect(res, "a response").not.toBeNull();
    expect(res!.status()).toBe(200);

    // Exactly one policy, nonce-based, no inline script allowance.
    const policies = (await res!.headersArray()).filter((h) => h.name.toLowerCase() === "content-security-policy");
    expect(policies).toHaveLength(1);
    const policy = policies[0]!.value;
    const nonce = policy.match(NONCE_RE)?.[1];
    expect(nonce, policy).toBeTruthy();
    const scriptSrc = policy.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src "))!;
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");

    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();

    // Every script tag in the served HTML carries this response's nonce (none is prerendered without it).
    const html = await res!.text();
    const tags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag, tag).toContain(`nonce="${nonce}"`);

    // The app hydrated: Next's runtime ran (blocked scripts would leave it undefined).
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { next?: unknown }).next)).toBe("object");

    expect(await csp.violations()).toEqual([]);
    expect(csp.consoleErrors).toEqual([]);
  });
}

test("two loads of the same page get different nonces", async ({ request }) => {
  const nonces = new Set<string | undefined>();
  for (let i = 0; i < 3; i++) {
    const res = await request.get("/terms");
    expect(res.ok()).toBe(true);
    nonces.add(res.headers()["content-security-policy"]?.match(NONCE_RE)?.[1]);
  }
  expect(nonces.has(undefined)).toBe(false);
  expect(nonces.size).toBe(3);
});

test("a signed-out visit to /chat is redirected to /login, with a CSP on the redirect", async ({ page, request }) => {
  const redirect = await request.get("/chat", { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(redirect.status());
  expect(new URL(redirect.headers()["location"]!, "http://x").pathname).toBe("/login");
  expect(redirect.headers()["content-security-policy"]).toMatch(NONCE_RE);

  const csp = await watchCsp(page);
  await page.goto("/chat", { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: /sign in/i })).toBeVisible();
  expect(await csp.violations()).toEqual([]);
  expect(csp.consoleErrors).toEqual([]);
});

test("an injected inline script is blocked and reported (the policy works, and so does the detector)", async ({ page }) => {
  // A reflected/stored XSS: the server's real response and headers (its CSP), plus a nonce-less inline
  // <script> in the HTML. Next's own nonced scripts still run; the injected one must not.
  await page.route("**/terms", async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace("</body>", "<script>window.__pwned = 1</script></body>");
    await route.fulfill({ response: res, body: html });
  });
  const csp = await watchCsp(page);
  await page.goto("/terms", { waitUntil: "networkidle" });
  await expect.poll(async () => (await csp.violations()).map((v) => v.directive)).toContain("script-src-elem");
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { next?: unknown }).next)).toBe("object");
});

test("static security headers ride along, once each", async ({ request }) => {
  const res = await request.get("/privacy");
  const names = res.headersArray().map((h) => h.name.toLowerCase());
  for (const h of ["strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy", "content-security-policy"]) {
    expect(names.filter((n) => n === h), h).toHaveLength(1);
  }
});
