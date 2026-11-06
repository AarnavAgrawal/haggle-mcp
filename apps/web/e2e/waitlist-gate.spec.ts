// The waitlist against real Supabase Auth: the gate's redirects, the operator's admit email finishing a
// sign-in in a browser that never started one, and the account-takeover case. Local only, never a real
// project; skipped unless WAITLIST_E2E_SUPABASE_URL is set. Needs a local stack set up like production:
//
//   supabase/config.toml: [auth.email] enable_confirmations = true, a [auth.email.template.magic_link]
//   content_path whose link is {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email, and
//   site_url set to the web app; `npx supabase start`, then apply supabase/migrations/*.sql.
//   Build with demo off and NEXT_PUBLIC_SUPABASE_* pointing at it; `next start` with the service key.
//
//   E2E_BASE_URL=<web> WAITLIST_E2E_SUPABASE_URL=<api> WAITLIST_E2E_ANON_KEY=<anon> WAITLIST_E2E_SERVICE_KEY=<service>
//   WAITLIST_E2E_MAIL_URL=<mailpit> WAITLIST_E2E_DB_CONTAINER=<db container> npx playwright test e2e/waitlist-gate.spec.ts
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";

const SB = process.env.WAITLIST_E2E_SUPABASE_URL ?? "";
const ANON = process.env.WAITLIST_E2E_ANON_KEY ?? "";
const SERVICE = process.env.WAITLIST_E2E_SERVICE_KEY ?? "";
const MAIL = process.env.WAITLIST_E2E_MAIL_URL ?? "";
const DB = process.env.WAITLIST_E2E_DB_CONTAINER ?? "";
const BASE = process.env.E2E_BASE_URL ?? "";
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "waitlist-admin.ts");

test.skip(!SB, "needs a local Supabase stack: see the top of this file");
test.describe.configure({ mode: "serial" });

const sql = (query: string) => {
  const r = spawnSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-tA"], { input: query, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** The operator's CLI, for real, against the local stack. */
const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", NEXT_PUBLIC_SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE } as unknown as NodeJS.ProcessEnv });
const admit = (email: string) => {
  const r = cli("admit", email, "--by", "e2e", "--target", new URL(SB).hostname.split(".")[0]!);
  expect(r.stdout + r.stderr).toContain("sign-in email sent");
  expect(r.status).toBe(0);
};

type Mail = { html: string; subject: string };
/** The newest message to this address after `after` messages had already arrived. */
async function mail(email: string, after = 0): Promise<Mail> {
  for (let i = 0; i < 40; i++) {
    const list = (await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages?: { ID: string; Subject: string }[] };
    const messages = list.messages ?? [];
    if (messages.length > after) {
      const m = (await (await fetch(`${MAIL}/api/v1/message/${messages[0]!.ID}`)).json()) as { HTML: string };
      return { html: m.HTML, subject: messages[0]!.Subject };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email for ${email}`);
}
const mailCount = async (email: string) => ((await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages?: unknown[] }).messages?.length ?? 0;
const linkIn = (m: Mail) => m.html.match(/href="([^"]+)"/)![1]!.replace(/&amp;/g, "&");

const askForLink = async (page: Page, email: string) => {
  await page.waitForTimeout(1500); // Supabase refuses a second link to one address too soon (max_frequency)
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
};
const inFreshBrowser = async (browser: Browser) => (await browser.newContext({ baseURL: BASE })).newPage();
const joinBody = (email: string) => ({ email, full_name: "Grace Hopper", organization: "Navy", use_case: null });

const person = `ada-${Date.now()}@example.com`;
const victim = `victim-${Date.now()}@example.com`;

test.beforeAll(() => {
  sql("delete from public.rate_limit_slots where bucket like 'web_waitlist%';");
});

test("someone signed in but not let in is held at the waitlist, and can join from there", async ({ page }) => {
  await askForLink(page, person);
  await page.goto(linkIn(await mail(person)));
  await expect(page).toHaveURL(/\/waitlist$/);
  await expect(page.getByLabel("Email")).toHaveValue(person);
  await expect(page.getByLabel("Email")).not.toBeEditable();
  await page.getByLabel("Full name").fill("Ada Lovelace");
  await page.getByLabel("Company, organization or school").fill("Analytical Engines");
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.getByRole("status")).toContainText("You're on the list");

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "You're on the list" })).toBeVisible();
  for (const path of ["/", "/chat", "/deals", "/onboarding"]) {
    await page.goto(path);
    await expect(page, `${path} must not get past the gate`).toHaveURL(/\/waitlist$/);
  }
  const listed = cli("list");
  expect(listed.stdout).toContain(person);
  expect(listed.stdout).toContain("Ada Lovelace");
});

test("the admit email finishes sign-in in a browser that never started one", async ({ browser }) => {
  const before = await mailCount(person);
  admit(person);
  const m = await mail(person, before);
  expect(m.subject).toBe("Your Haggle sign-in link");
  expect(m.html).toContain("you're in");
  expect(linkIn(m)).toContain("/auth/callback?token_hash=");

  const page = await inFreshBrowser(browser);
  await page.goto(linkIn(m));
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
});

test("an ordinary sign-in link still works with the same template", async ({ browser }) => {
  const page = await inFreshBrowser(browser);
  const before = await mailCount(person);
  await askForLink(page, person);
  await page.goto(linkIn(await mail(person, before)));
  await expect(page).toHaveURL(/\/onboarding$/);
});

test("the server refuses a workspace to someone whose admission is gone, even from the open form", async ({ browser }) => {
  const page = await inFreshBrowser(browser);
  const before = await mailCount(person);
  await askForLink(page, person);
  await page.goto(linkIn(await mail(person, before)));
  await expect(page).toHaveURL(/\/onboarding$/);

  sql(`update public.web_waitlist set admitted_at = null, admitted_by = null, notified_at = null where email = '${person}';`);
  await page.getByLabel("Workspace name").fill("Should not exist");
  await page.locator("#accept_terms").check();
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/waitlist$/);
  expect(sql(`select count(*) from public.workspace_members m join auth.users u on u.id = m.user_id where u.email = '${person}';`)).toBe("0");
  expect(sql(`select count(*) from public.web_profiles p join auth.users u on u.id = p.user_id where u.email = '${person}' and p.accepted_terms_at is not null;`)).toBe("0");
});

test("a password set before admission doesn't survive it", async ({ page, request }) => {
  const password = "attacker-chose-this-1";
  const headers = { apikey: ANON, "content-type": "application/json" };
  const signup = await request.post(`${SB}/auth/v1/signup`, { headers, data: { email: victim, password } });
  expect(signup.ok()).toBe(true);
  expect(sql(`select email_confirmed_at is null from auth.users where email = '${victim}';`)).toBe("t");

  const joined = await request.post("/api/waitlist", { headers: { origin: BASE }, data: joinBody(victim) });
  expect(joined.status()).toBe(200);
  const before = await mailCount(victim);
  await page.waitForTimeout(1500); // the sign-up above sent a mail; see askForLink
  admit(victim);
  await page.goto(linkIn(await mail(victim, before)));

  // The real person has clicked their link, so the address is confirmed: the attacker's password must not work.
  const stolen = await request.post(`${SB}/auth/v1/token?grant_type=password`, { headers, data: { email: victim, password } });
  expect(stolen.status(), "a password chosen before admission must not sign in").toBe(400);
  await expect(page).toHaveURL(/\/onboarding$/);
});

test("the public can join, but can't read the list or tell who is on it", async ({ request }) => {
  const email = `grace-${Date.now()}@example.com`;
  const first = await request.post("/api/waitlist", { headers: { origin: BASE }, data: joinBody(email) });
  const again = await request.post("/api/waitlist", { headers: { origin: BASE }, data: { ...joinBody(email), full_name: "Impostor" } });
  expect(first.status()).toBe(200);
  expect(await again.json()).toEqual(await first.json());
  expect(sql(`select full_name from public.web_waitlist where email = '${email}';`)).toBe("Grace Hopper");
  expect(await mailCount(email), "joining never mails the address given").toBe(0);

  const crossSite = await request.post("/api/waitlist", { headers: { origin: "https://evil.example" }, data: joinBody(`x-${email}`) });
  expect(crossSite.status()).toBe(403);

  const read = await request.get(`${SB}/rest/v1/web_waitlist?select=email`, { headers: { apikey: ANON, authorization: `Bearer ${ANON}` } });
  expect([401, 403]).toContain(read.status());
});
