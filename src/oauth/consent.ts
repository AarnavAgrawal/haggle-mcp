// GET /oauth/consent: sign-in and consent page for public mode (AUTH_MODE=oauth).
//
// Flow: an MCP client (Claude Code, claude.ai, ...) starts OAuth with Supabase;
// Supabase sends the person here with ?authorization_id=...; they sign in
// (GitHub or an email link) and click Allow; Supabase then returns them to the
// MCP client with an authorization code. All of this runs in the browser with
// supabase-js and the PUBLIC publishable key. The server only serves the page.
//
// Supabase setup this page needs: Authentication > OAuth Server enabled, with
// Authorization Path "/oauth/consent"; Site URL = PUBLIC_BASE_URL.
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { esc } from "../live/render.js";

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js";
// Subresource integrity: the browser refuses the file if the CDN ever serves
// anything else. Matches node_modules/@supabase/supabase-js@2.118.0 byte for byte.
const SUPABASE_JS_SRI = "sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK";

export interface ConsentPageConfig {
  supabaseUrl: string;
  publishableKey: string;
  loginMethods: string[]; // "github", "email"
  brokerAddress: string | null; // where a user sends the one-time "hello" email
}

/** JSON for an inline <script type="application/json">, safe against </script>. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function renderConsentPage(cfg: ConsentPageConfig, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · Quote Broker</title>
<style nonce="${esc(nonce)}">${CSS}</style>
</head>
<body>
<main class="card" aria-live="polite">
  <p class="brand">Quote Broker</p>
  <div id="app"><p class="muted">Loading…</p></div>
  <p class="foot">Demo service: simulated restaurants only, payments in Stripe test mode. No real money moves.</p>
</main>
<script type="application/json" id="cfg">${inlineJson(cfg)}</script>
<script nonce="${esc(nonce)}" src="${SUPABASE_JS}" integrity="${SUPABASE_JS_SRI}" crossorigin="anonymous"></script>
<script nonce="${esc(nonce)}">${CLIENT}</script>
</body>
</html>`;
}

export function handleConsent(c: Context): Response {
  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (process.env.AUTH_MODE !== "oauth" || !supabaseUrl || !publishableKey) {
    return c.text("Sign-in is not enabled on this server.", 404);
  }
  const nonce = randomBytes(16).toString("base64");
  const loginMethods = (process.env.LOGIN_METHODS ?? "github,email")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m === "github" || m === "email");
  const page = renderConsentPage(
    { supabaseUrl, publishableKey, loginMethods, brokerAddress: process.env.PRIMITIVE_FROM_ADDRESS ?? null },
    nonce,
  );
  const supabaseOrigin = new URL(supabaseUrl).origin;
  return c.html(page, 200, {
    "Content-Security-Policy": [
      "default-src 'none'",
      // Nonce only (it also covers the supabase-js <script src>): no whole-CDN allowance.
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      `connect-src ${supabaseOrigin}`,
      "img-src data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

// Browser code. Builds the page with textContent only (no innerHTML), so
// nothing from Supabase or the URL can inject markup.
const CLIENT = `
const cfg = JSON.parse(document.getElementById("cfg").textContent);
const app = document.getElementById("app");
const params = new URLSearchParams(location.search);
const authorizationId = params.get("authorization_id");
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.publishableKey, {
  auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
});

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") node.className = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}
function show(...nodes) { app.replaceChildren(...nodes); }
function fail(message) { show(el("h1", {}, "Something went wrong"), el("p", { class: "error" }, message)); }

// Return here after GitHub or the email link, keeping authorization_id.
const returnTo = location.origin + location.pathname + "?authorization_id=" + encodeURIComponent(authorizationId || "");

function signInView() {
  const parts = [el("h1", {}, "Sign in to Quote Broker"), el("p", { class: "muted" }, "Your AI agent wants to get catering quotes for you. Sign in so your jobs and approvals are yours alone.")];
  if (cfg.loginMethods.includes("github")) {
    parts.push(el("button", { class: "primary", onclick: async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: "github", options: { redirectTo: returnTo } });
      if (error) fail(error.message);
    } }, "Continue with GitHub"));
  }
  if (cfg.loginMethods.includes("email")) {
    const input = el("input", { type: "email", placeholder: "you@example.com", autocomplete: "email", "aria-label": "Email address" });
    parts.push(el("div", { class: "row" }, input, el("button", { onclick: async () => {
      const email = input.value.trim();
      if (!email) return input.focus();
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: returnTo } });
      if (error) return fail(error.message);
      show(el("h1", {}, "Check your email"), el("p", {}, "We sent a sign-in link to " + email + ". Open it in this same browser to continue."));
    } }, "Email me a link")));
  }
  show(...parts);
}

async function consentView(session) {
  const { data, error } = await sb.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error) return fail(error.message);
  if (!data.authorization_id) return location.assign(data.redirect_url); // already allowed earlier

  const email = (session.user && session.user.email) || "your account";
  const clientName = (data.client && data.client.name) || "An MCP client";
  // Any app can register itself under any name, so show where the grant really
  // goes. Claude Code and other local clients return to localhost / 127.0.0.1.
  let destination = "an unknown address";
  try { destination = new URL(data.redirect_uri).host; } catch {}
  const decide = async (approve) => {
    const fn = approve ? sb.auth.oauth.approveAuthorization : sb.auth.oauth.denyAuthorization;
    const res = await fn.call(sb.auth.oauth, authorizationId, { skipBrowserRedirect: true });
    if (res.error) return fail(res.error.message);
    show(el("h1", {}, approve ? "You're signed in" : "Request denied"), el("p", { class: "muted" }, "Returning you to your app…"));
    location.assign(res.data.redirect_url);
  };
  const items = [
    "Email the demo restaurants for catering quotes on your behalf",
    "See and manage only your own quote requests",
    "Email approval requests to " + email + " before any deposit is paid",
    "Pay approved deposits with a Stripe TEST card (no real money)",
  ];
  const parts = [
    el("h1", {}, "Allow " + clientName + "?"),
    el("p", { class: "muted" }, "Signed in as " + email),
    el("p", { class: "dest" }, "Allowing sends you, and access to your account, to: ", el("strong", {}, destination)),
    el("p", { class: "muted small" }, "Only continue if you just started this from your own app (for example Claude Code, which returns to localhost)."),
    el("ul", {}, ...items.map((t) => el("li", {}, t))),
  ];
  if (cfg.brokerAddress) {
    parts.push(el("p", { class: "tip" }, "One-time step so approval emails reach you: send any short email from " + email + " to " + cfg.brokerAddress + "."));
  }
  parts.push(
    el("div", { class: "row" },
      el("button", { class: "primary", onclick: () => decide(true) }, "Allow"),
      el("button", { onclick: () => decide(false) }, "Deny")),
    el("button", { class: "link", onclick: async () => { await sb.auth.signOut(); signInView(); } }, "Use a different account"),
  );
  show(...parts);
}

(async () => {
  if (!authorizationId) return fail("This page opens during sign-in from an MCP client such as Claude Code. Start there.");
  const { data, error } = await sb.auth.getSession();
  if (error) return fail(error.message);
  if (!data.session) return signInView();
  await consentView(data.session);
})().catch((e) => fail(String(e && e.message || e)));
`;

const CSS = `
:root { --bg: #f6f5f1; --panel: #fff; --ink: #1d1d1b; --muted: #6b6a64; --line: #e3e1da; --accent: #1f6f4a; --warn: #a1432b; --tip: #f6efd8; }
@media (prefers-color-scheme: dark) { :root { --bg: #141413; --panel: #1d1d1b; --ink: #ecebe6; --muted: #9c9a92; --line: #33322e; --accent: #6cc79a; --warn: #ef9a82; --tip: #3a3220; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
.card { width: 100%; max-width: 440px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
.brand { font-weight: 700; margin: 0 0 16px; }
h1 { font-size: 22px; margin: 0 0 8px; }
.muted { color: var(--muted); }
.error { color: var(--warn); }
.tip { background: var(--tip); border-radius: 8px; padding: 10px 12px; font-size: 14px; }
ul { padding-left: 20px; }
li { margin: 4px 0; }
.row { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
input { flex: 1 1 200px; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; font: inherit; background: var(--bg); color: var(--ink); }
button { padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); font: inherit; font-weight: 600; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--panel); width: 100%; margin: 8px 0; }
.row button.primary { width: auto; flex: 1; margin: 0; }
button.link { border: 0; background: none; color: var(--muted); font-weight: 400; padding: 4px 0; text-decoration: underline; }
.foot { color: var(--muted); font-size: 13px; margin: 20px 0 0; }
.dest { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-wrap: anywhere; }
.small { font-size: 13px; }
`;
