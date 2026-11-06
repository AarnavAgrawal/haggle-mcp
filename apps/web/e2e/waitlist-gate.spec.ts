// The waitlist against real Supabase Auth: the gate's redirects, the operator's admit email finishing a
// sign-in in a browser that never started one, and the account-takeover case. Local only, never a real
// project; skipped unless WAITLIST_E2E_SUPABASE_URL is set. Needs a local stack set up like production:
//
//   supabase/config.toml: [auth.email] enable_confirmations = true, a [auth.email.template.magic_link]
//   content_path whose link is {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email, and
//   site_url set to the web app, with the same host as E2E_BASE_URL (next start redirects to localhost, so use
//   localhost throughout); `npx supabase start`, then apply supabase/migrations/*.sql.
//   Build with demo off and NEXT_PUBLIC_SUPABASE_* pointing at it; `next start` with the service key.
//
//   E2E_BASE_URL=<web> WAITLIST_E2E_SUPABASE_URL=<api> WAITLIST_E2E_ANON_KEY=<anon> WAITLIST_E2E_SERVICE_KEY=<service>
//   WAITLIST_E2E_MAIL_URL=<mailpit> WAITLIST_E2E_DB_CONTAINER=<db container> npx playwright test e2e/waitlist-gate.spec.ts
//
// Run it twice: with sign-ups on, then with enable_signup = false in [auth] and WAITLIST_E2E_SIGNUPS=off, which is
// how production runs (docs/production-deploy.md §3.4). Leave it true in [auth.email]: that one is the whole email
// provider, and turning it off stops email sign-in for everyone.
//
// To prove the Google path too: Supabase can't point Google at a fake, so stand in its Keycloak provider, which takes
// the same route back. In config.toml set [auth.external.keycloak] enabled = true, any client_id and secret, and
// url = "http://host.docker.internal:<port>/realms/haggle"; then set WAITLIST_E2E_OIDC_PORT=<port>.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";

const SB = process.env.WAITLIST_E2E_SUPABASE_URL ?? "";
const ANON = process.env.WAITLIST_E2E_ANON_KEY ?? "";
const SERVICE = process.env.WAITLIST_E2E_SERVICE_KEY ?? "";
const MAIL = process.env.WAITLIST_E2E_MAIL_URL ?? "";
const DB = process.env.WAITLIST_E2E_DB_CONTAINER ?? "";
const BASE = process.env.E2E_BASE_URL ?? "";
const SIGNUPS_OFF = process.env.WAITLIST_E2E_SIGNUPS === "off";
const OIDC_PORT = Number(process.env.WAITLIST_E2E_OIDC_PORT ?? 0);
const AUTH_HEADERS = { apikey: ANON, "content-type": "application/json" };
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "waitlist-admin.ts");

test.skip(!SB, "needs a local Supabase stack: see the top of this file");
test.describe.configure({ mode: "serial" });
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP host.docker.internal 127.0.0.1"] } }); // the stand-in provider, from the browser's side

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
/** Opens an emailed link and, if it lands on the confirm page, presses its button, as a person would. */
const follow = async (page: Page, link: string) => {
  await page.goto(link);
  if (link.includes("/auth/confirm")) await page.getByRole("button", { name: "Continue to Haggle" }).click();
};
const inFreshBrowser = async (browser: Browser) => (await browser.newContext({ baseURL: BASE })).newPage();
const joinBody = (email: string) => ({ email, full_name: "Grace Hopper", organization: "Navy", use_case: null });
const accounts = (email: string) => sql(`select count(*) from auth.users where email = '${email}';`);
/** An account from before the waitlist: the login form can't make one any more. */
const existingAccount = async (email: string) => {
  const r = await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" }, body: JSON.stringify({ email, email_confirm: true }) });
  expect(r.ok).toBe(true);
};

const person = `ada-${Date.now()}@example.com`;
const victim = `victim-${Date.now()}@example.com`;

test.beforeAll(() => {
  sql("delete from public.rate_limit_slots where bucket like 'web_waitlist%';");
});

test("signing in with no account fails, makes none, and lands on the waitlist, where joining works", async ({ page }) => {
  const email = `new-${Date.now()}@example.com`;
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page).toHaveURL(/\/waitlist\?from=sign-in$/);
  await expect(page.getByRole("status")).toContainText("You don't have a Haggle account yet");
  expect(accounts(email), "the attempt must not make an account").toBe("0");
  expect(await mailCount(email), "and must not send a link").toBe(0);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Full name").fill("Katherine Johnson");
  await page.getByLabel("Company, organization or school").fill("NASA");
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.locator(".wl-joined")).toContainText("You're on the list");
  expect(sql(`select full_name, organization, admitted_at is null from public.web_waitlist where email = '${email}';`)).toBe("Katherine Johnson|NASA|t");
  expect(accounts(email), "joining doesn't make an account either").toBe("0");
});

test("a new person refused at the end of a Google-style sign-in lands on the waitlist with no account", async ({ page }) => {
  test.skip(!SIGNUPS_OFF || !OIDC_PORT, "needs sign-ups off and the stand-in provider: see the top of this file");
  const email = `oauth-${Date.now()}@example.com`;
  const provider = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://provider");
    if (url.pathname.endsWith("/auth")) {
      res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=stand-in&state=${url.searchParams.get("state")}` }).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(url.pathname.endsWith("/token") ? { access_token: "stand-in", token_type: "bearer", expires_in: 3600 } : { sub: `stand-in-${email}`, name: "New Person", email, email_verified: true }));
  }).listen(OIDC_PORT);
  try {
    const pkce = `code_challenge=${"a".repeat(43)}&code_challenge_method=s256`; // as the browser client signs in
    await page.goto(`${SB}/auth/v1/authorize?provider=keycloak&redirect_to=${encodeURIComponent(`${BASE}/auth/callback`)}&${pkce}`);
    await expect(page).toHaveURL(/\/waitlist\?from=sign-in/);
    await expect(page.getByRole("status")).toContainText("You don't have a Haggle account yet");
    expect(accounts(email)).toBe("0");
  } finally {
    provider.close();
  }
});

test("someone with an account but not let in is held at the waitlist, and can join from there", async ({ page }) => {
  await existingAccount(person);
  await askForLink(page, person);
  await follow(page, linkIn(await mail(person)));
  await expect(page).toHaveURL(/\/waitlist$/);
  await expect(page.getByText("Your data")).toBeVisible();
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
  const link = linkIn(m);
  expect(link).toContain("/auth/confirm?token_hash=");

  // Merely opening the link, as a mail scanner does, signs nobody in and doesn't use it up.
  const scanner = await inFreshBrowser(browser);
  await scanner.goto(link);
  await expect(scanner.getByRole("button", { name: "Continue to Haggle" })).toBeVisible();
  await scanner.goto("/chat");
  await expect(scanner).toHaveURL(/\/login/);
  // Nor does a GET to the callback: a link someone sends you can't sign you in by being opened.
  await scanner.goto(link.replace("/auth/confirm", "/auth/callback"));
  await expect(scanner).toHaveURL(/\/login\?error=sign_in_failed/);

  const page = await inFreshBrowser(browser);
  await follow(page, link);
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "Set up your workspace" })).toBeVisible();
});

test("an ordinary sign-in link still works with the same template", async ({ browser }) => {
  const page = await inFreshBrowser(browser);
  const before = await mailCount(person);
  await askForLink(page, person);
  await follow(page, linkIn(await mail(person, before)));
  await expect(page).toHaveURL(/\/onboarding$/);
});

test("the server refuses a workspace to someone whose admission is gone, even from the open form", async ({ browser }) => {
  const page = await inFreshBrowser(browser);
  const before = await mailCount(person);
  await askForLink(page, person);
  await follow(page, linkIn(await mail(person, before)));
  await expect(page).toHaveURL(/\/onboarding$/);

  sql(`update public.web_waitlist set admitted_at = null, admitted_by = null, notified_at = null where email = '${person}';`);
  await page.getByLabel("Workspace name").fill("Should not exist");
  await page.locator("#accept_terms").check();
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/waitlist$/);
  expect(sql(`select count(*) from public.workspace_members m join auth.users u on u.id = m.user_id where u.email = '${person}';`)).toBe("0");
  expect(sql(`select count(*) from public.web_profiles p join auth.users u on u.id = p.user_id where u.email = '${person}' and p.accepted_terms_at is not null;`)).toBe("0");
});

test("with sign-ups closed, only someone let in can get an account", async ({ page, request }) => {
  test.skip(!SIGNUPS_OFF, "for a stack with sign-ups off");
  const email = `closed-${Date.now()}@example.com`;
  const signup = await request.post(`${SB}/auth/v1/signup`, { headers: AUTH_HEADERS, data: { email, password: "attacker-chose-this-1" } });
  expect(signup.ok(), "nobody can pre-register an address").toBe(false);
  expect(accounts(email)).toBe("0");

  expect((await request.post("/api/waitlist", { headers: { origin: BASE }, data: joinBody(email) })).status()).toBe(200);
  const before = await mailCount(email);
  admit(email);
  await follow(page, linkIn(await mail(email, before)));
  await expect(page).toHaveURL(/\/onboarding$/);
});

test("removing someone takes their sign-in too", async ({ request }) => {
  const email = `leaving-${Date.now()}@example.com`;
  expect((await request.post("/api/waitlist", { headers: { origin: BASE }, data: joinBody(email) })).status()).toBe(200);
  admit(email);
  expect(sql(`select count(*) from auth.users where email = '${email}';`)).toBe("1");
  const r = cli("remove", email, "--by", "e2e", "--target", new URL(SB).hostname.split(".")[0]!);
  expect(r.stdout).toContain("and their sign-in");
  expect(sql(`select count(*) from auth.users where email = '${email}';`)).toBe("0");
  expect(sql(`select count(*) from public.web_waitlist where email = '${email}';`)).toBe("0");
});

test("a password set before admission doesn't survive it", async ({ page, request }) => {
  test.skip(SIGNUPS_OFF, "sign-ups are closed: nobody can pre-register");
  const password = "attacker-chose-this-1";
  const headers = AUTH_HEADERS;
  const signup = await request.post(`${SB}/auth/v1/signup`, { headers, data: { email: victim, password } });
  expect(signup.ok()).toBe(true);
  expect(sql(`select email_confirmed_at is null from auth.users where email = '${victim}';`)).toBe("t");

  const joined = await request.post("/api/waitlist", { headers: { origin: BASE }, data: joinBody(victim) });
  expect(joined.status()).toBe(200);
  const before = await mailCount(victim);
  await page.waitForTimeout(1500); // the sign-up above sent a mail; see askForLink
  admit(victim);
  await follow(page, linkIn(await mail(victim, before)));

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
