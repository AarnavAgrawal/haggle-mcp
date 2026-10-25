// Browser tests (Playwright, Chromium). Specs live in e2e/, not tests/: the root vitest config collects
// apps/*/tests/**/*.test.ts, and these are *.spec.ts run by `npm run e2e -w @haggle/web`.
//
// Tier 1, offline (e2e/public.spec.ts, also in CI): the public pages render under the nonce CSP with no
// violation. It needs a production build first, with placeholder Supabase values and demo off:
//   NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder-anon-key \
//   NEXT_PUBLIC_HAGGLE_DEMO=false npm run build -w @haggle/web
// Nothing is contacted: signed-out pages never reach Supabase.
//
// Tier 2 (e2e/guest-deal.spec.ts, local only, needs Docker): see docs/web-app.md "Browser tests". It
// starts its own servers and skips itself unless HAGGLE_E2E_TIER2=1.
//
// E2E_PORT picks the port (default 3210); E2E_BASE_URL points at an already running server instead.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3210);
const external = process.env.E2E_BASE_URL;
const tier2 = process.env.HAGGLE_E2E_TIER2 === "1";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: external ?? `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Tier 2 builds and starts its own web server (demo on, local Supabase); see e2e/guest-deal.spec.ts.
  webServer: external || tier2
    ? undefined
    : {
        command: `npx next start --port ${PORT} --hostname 127.0.0.1`,
        url: `http://127.0.0.1:${PORT}/terms`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://ci-placeholder.supabase.co",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "ci-placeholder-anon-key",
        },
      },
});
