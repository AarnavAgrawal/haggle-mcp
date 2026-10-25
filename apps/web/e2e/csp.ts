// Shared by the browser specs: watch a page for Content-Security-Policy violations.
import type { Page } from "@playwright/test";

export const NONCE_RE = /'nonce-([A-Za-z0-9+/_-]+={0,2})'/;

export type Violation = { directive: string; blocked: string; sample: string; url: string };

/**
 * Collects securitypolicyviolation events from the first byte of every document the page loads, and
 * console/page errors that mention a Content Security Policy. Call before the first navigation.
 */
export async function watchCsp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: unknown[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample, url: location.pathname });
    });
  });
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (/content security policy/i.test(e.message)) consoleErrors.push(e.message);
  });
  return {
    consoleErrors,
    /** Violations on the current document (each navigation starts a fresh list). */
    violations: () => page.evaluate(() => (window as unknown as { __csp?: Violation[] }).__csp ?? []),
  };
}
