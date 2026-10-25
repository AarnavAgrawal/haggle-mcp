# Haggle web app (`apps/web`)

The web app is a signed-in website for people who want Haggle without an AI client. A user signs in, sets up a workspace, describes what they need in a chat, watches the deal live on a dashboard and approves and pays with their own clicks.

**The MCP server powers everything.** The web app holds no deal logic. Every deal action is a tool call to the same Haggle MCP server (`apps/mcp`) that Claude, ChatGPT and Claude Code use. The web backend (Next.js route handlers and server components) plays two roles:

- **An MCP client.** It calls tools over Streamable HTTP (`POST /mcp`) as the signed-in user's workspace (`lib/haggle.ts`).
- **A trusted MCP Apps host.** For the board-button tools (`choose_in_view`, `approve_in_view`, `call_back_in_view`), it declares the MCP Apps UI extension in the request envelope, as Claude or ChatGPT would when they render a view. The server then hands it one-time codes in `_meta`. The backend keeps those codes on the server and spends them only on the human's click.

The web app owns only three things: sign-in, which workspace a user belongs to, and the chat history. Supabase stores all three.

---

## Architecture

```
 Browser (React, Next.js App Router)
   │  pages · POST /api/chat (NDJSON) · GET /api/deals/<id>/stream (SSE) · POST /api/deals/<id>/*
   ▼
 ┌──────────────────────────── apps/web (Next.js 16, port 3200) ────────────────────────────┐
 │ proxy.ts           refreshes the Supabase session; signed-out pages → /login            │
 │ lib/workspace.ts   session user + workspace_members lookup (requireHaggle, onboard)     │
 │ lib/chat/*         Claude tool loop over the allowlisted MCP tools; threads in Supabase │
 │ lib/dashboard/*    deal pages, SSE over wait_for_update, answer/message/negotiate/cancel│
 │ lib/approval/*     approve / pay / callback from a human click (service routes)        │
 │ lib/haggle.ts      MCP client: x-haggle-service-token + x-haggle-workspace on every call│
 └───────┬──────────────────────────────┬───────────────────────────────┬────────────────────┘
         │ Supabase Auth + Postgres     │ Claude API (chat only)         │ POST /mcp, POST /internal/workspaces
         ▼                              ▼                                ▼
 Supabase project                  Anthropic                      apps/mcp (Haggle MCP server)
  auth.users                        WEB_CHAT_MODEL                  resolveWorkspace(service token, workspace)
  workspace_members (300)                                           engine → Inkbox · Stripe (test) · Claude
  chat_threads, chat_messages (301)                                 store: public.workspaces, jobs, … (1xx)
```

`workspace_members` and `chat_threads` reference `public.workspaces(id)`, the MCP server's own table. The web app and the MCP server therefore have to share one Postgres database (see [Running locally](#running-locally)).

---

## Pages and API routes

| Path | What it does | MCP tools used |
|---|---|---|
| `/` | Redirects: signed out → `/login`; no workspace → `/onboarding`; otherwise → `/deals`. | none |
| `/login` | Email magic link (`signInWithOtp`) or Google OAuth. Both return to `/auth/callback`. | none |
| `GET /auth/callback` | Exchanges the auth code for a session, then redirects to `/` (or to `/login?error=sign_in_failed`). | none |
| `POST /auth/sign-out` | Signs out and redirects to `/login`. It is POST only, so a link prefetch can't sign anyone out. | none |
| `/onboarding` | Creates the workspace: name, approver phone (E.164), spending cap per payment (default $1,500) and usual area. The approver email is the user's sign-in email. | `POST /internal/workspaces` |
| `/chat`, `/chat/<threadId>` | Starts a new conversation, or resumes one of your own. A sidebar lists your 30 most recent threads. | via `/api/chat` |
| `/deals` | Lists the workspace's 20 newest deals, each linking to its live page. | `list_deals` |
| `/deals/<jobId>` | The deal page: request, timeline, next step, setup notes, questions from businesses, ranked quotes with the approval panel, purchase status, suggested callbacks, negotiation history, businesses, and Cancel. | `get_quotes` |
| `/deals/<jobId>/businesses/<businessId>` | One business's full thread on the deal (email, text, call brief and transcript), with a message form. Business text is shown as plain text, never as links. | `get_conversation` |
| `/settings` | Read-only: how businesses see Haggle, channel readiness, call hours, approver, cap and mode. Only the operator can change the approver or raise the cap. | `get_identity` |

| API route | Body / query | Returns |
|---|---|---|
| `POST /api/chat` | `{ message (1–4,000 chars), thread_id? }` | A newline-delimited JSON stream of `ChatEvent`s (`text`, `tool`, `deal`, `error`), ending with `{ type: "done", thread_id }`. |
| `GET /api/deals/<jobId>/stream` | `?cursor=<digits>` (optional) | Server-sent events: `ready`, `update`, `end` and `problem`, plus heartbeat comments. |
| `POST /api/deals/<jobId>/actions` | `answer_business` / `send_message` / `negotiate` / `cancel_deal` (with `confirm: true`) | `{ ok, action, next, data }` or `{ ok: false, error: { code, message, fix } }`. |
| `POST /api/deals/<jobId>/approve` | `{ quote_id, action?: "pay" \| "confirm" }` | `{ ok, status: approved \| confirmed \| paid \| refused \| pending_text, amount_usd?, next }` |
| `POST /api/deals/<jobId>/pay` | `{ quote_id }` (never an amount) | `{ ok, status, amount_usd, receipt_url? (https only), simulated?, next }` |
| `POST /api/deals/<jobId>/callback` | `{ business_id }` | `{ ok, status: placed \| scheduled \| pending_text \| declined, next }` |

API routes never redirect: they answer with JSON (`401` signed out, `403` no workspace). To make that possible, `proxy.ts` treats `/api/*` as public and leaves each route to check the user itself. The proxy check is optimistic; pages and routes still verify the session through `lib/workspace.ts`.

`proxy.ts` also sends the Content-Security-Policy (`lib/csp.ts`), one per response, with a fresh nonce per request: `script-src 'self' 'nonce-…' 'strict-dynamic'` (no `'unsafe-inline'`; `'unsafe-eval'` only under `next dev`). It puts the policy on the request headers too, which is where Next reads the nonce for its own scripts, and on redirects. Every page therefore renders per request: the root layout awaits `connection()`, so the build prerenders no page. The one exception is Next's own `/_global-error`, which Next always prerenders into the last-resort `500.html` (served only when a request fails outside rendering). Its scripts carry no nonce and are blocked there, but its message and plain "Home" link still work. `style-src` keeps `'unsafe-inline'` for React `style` attributes (a style nonce would block them). The other security headers (HSTS, nosniff, `X-Frame-Options`, Referrer-Policy, Permissions-Policy) are static, in `next.config.ts`.

---

## Auth and tenancy

1. **Sign-in: Supabase Auth.** Users sign in with an email magic link or Google. `proxy.ts` refreshes the session cookie on every request.
2. **Membership: the `workspace_members` table** (migration `300_web_accounts.sql`). Each row is `(user_id, workspace_id, role)`. With row-level security, a user can read only their own memberships, and only the service role writes them. `requireHaggle()` looks up the user's first membership and builds a Haggle client for that workspace.
3. **Onboarding: `POST /internal/workspaces`** on the MCP server, authenticated with `x-haggle-service-token`. The server derives the workspace id from the user's account id (`ws_u_<hash>`; `planServiceWorkspace` in `apps/mcp/src/workspace.ts`), so a retried signup finds the same workspace. The call returns `201` when it creates the workspace and `200` when it already exists. The server applies the approver phone, approver email, cap and area. The workspace also gets a random bearer token and connector secret, which are never shown to anyone. The web backend then upserts the membership with the service-role key.
4. **Every MCP call** carries two headers:
   - `x-haggle-service-token: <HAGGLE_SERVICE_TOKEN>`
   - `x-haggle-workspace: <workspace id>`

   The server compares the token as a fixed-length digest. It accepts only tokens of at least 32 characters; when `HAGGLE_SERVICE_TOKEN` is unset on the server, both the service token and `/internal/workspaces` are off. The workspace must exist and must not be revoked. **The web app is what checks membership; the server trusts the service token's choice of workspace.** Treat the token like a root credential for every web workspace.

---

## The chat

`/api/chat` runs one turn at a time (`lib/chat/agent.ts`). Each turn is a manual streaming tool loop against Claude.

- **Model.** The default is `claude-opus-5-5`, which `WEB_CHAT_MODEL` overrides. Each call uses adaptive thinking, effort `medium`, `max_tokens` 16,000 and server-side fallbacks (`server-side-fallback-2026-07-01`).
- **Turn limits.** A turn makes at most 12 model calls. Tool results sent to the model are capped at 6,000 characters. `wait_for_update` is capped at 20 s inside the chat. If the step cap is reached, tool calls that would act on the world are not run.
- **Tool allowlist** (`lib/tools.ts`). The model sees only these MCP tools: `deal`, `wait_for_update`, `get_quotes`, `list_deals`, `get_conversation`, `answer_business`, `send_message`, `negotiate`, `cancel_deal`, `ask`, `discover`, `business_profile`, `check_price` and `get_identity`. Any other tool name gets an `is_error` result that points the user to the dashboard, and the call never reaches the server.
- **Why `approve`, `pay` and `call_back` are human-only.** The other human-only tools are `choose_in_view`, `approve_in_view` and `call_back_in_view`. CLAUDE.md §7 says the model never approves, pays or rings a business on its own. There is also a concrete risk: on a demo server, a client that shows no approval form gets a *simulated* human's yes from `approve`, and `call_back` can place the call itself. Letting the chat model call either would bypass the human. In the web app, these actions are buttons that hit their own routes.
- **`_meta` never reaches the model or the browser.** Tool results passed to Claude contain only the tool's text and `structuredContent`. `_meta` can hold one-time approval codes.
- **Dry run first.** The system prompt (`lib/chat/prompt.ts`) has the model gather what's missing, in at most two short rounds. It then calls `deal` with `dry_run: true`, summarizes who would be contacted and on which channel, and starts the real deal only after the user confirms. A dry run produces no `deal` event. A real start emits `{ type: "deal", job_id }`, which shows a card linking to `/deals/<job_id>`.
- **Caching.** The system prompt has no dates, ids or user facts in it, and is marked `cache_control: ephemeral`. Tool definitions come in a fixed order, and the last one carries a cache breakpoint. Today's date goes into each user turn as a hidden `[Haggle context]` block, so the cached prefix stays the same.
- **Rate limit.** Each user gets 20 turns per 10 minutes (sliding window). Past that, the route answers `429` with `retry-after`.
- **Stored threads** (migration `301_web_chat.sql`). `chat_threads` belongs to a user in a workspace, and its `job_id` is set once a deal starts. `chat_messages` holds the Anthropic turns verbatim (thinking and tool blocks included). It is append-only and read back in id order. The backend writes with the service role after checking membership, and every read filters by `user_id` and `workspace_id`. Row-level security also lets users read their own rows. The model sees the last 80 messages, and that window always starts at a typed user turn. Without `ANTHROPIC_API_KEY`, the stream reports that the chat isn't configured, and no new thread is created.

---

## The dashboard

- **Live updates.** `LiveRefresh` opens an `EventSource` on `/api/deals/<jobId>/stream`. On each `update`, it calls `router.refresh()` (debounced by 400 ms), so the server re-renders the page from a fresh `get_quotes`.
- **The stream** (`lib/dashboard/stream.ts`) long-polls `wait_for_update`, 25 s per poll:
  - **Fresh page:** a `timeout_s: 0` call learns the current cursor, then the stream sends `ready`.
  - **Change:** each one sends `update { cursor, state, updates }`.
  - **End:** a terminal state (`paid`, `confirmed`, `cancelled`, `failed`) sends `end`. So does the 5-minute limit; the client then reconnects with `?cursor=`.
  - **Refusal:** a server refusal is a `problem { code, message, fix }` frame.

  Heartbeat comments go out every 15 s. Failed connections retry after 1 s, 2 s, 4 s and so on, up to 30 s. Pages of deals that are already over don't open a stream.
- **Actions** (`POST /api/deals/<jobId>/actions`, `lib/dashboard/actions.ts`):
  - **Answer:** answer a business's question.
  - **Message:** message a business, as free text and/or "ask for what its quote is missing", with an optional channel.
  - **Counteroffer round:** shown when at least two current quotes are priced, before anything is approved, and only once. The server still decides whether it may run.
  - **Cancel:** the body must include `confirm: true`.

  Tool refusals come back as `422` with the server's `fix`. Transport failures come back as `502`.

---

## Approval and payment

Only a signed-in human's click approves, pays or authorizes a callback (`lib/approval/flow.ts`, `components/approval/ApprovalPanel.tsx`). Approving charges nothing. Pay charges the approved amount: the deposit, or the full total when the business stated no deposit. The amount is never an input.

**One path for demo and live servers** (`lib/approval/flow.ts` → the MCP server's service routes, `apps/mcp/src/service/approvals.ts`). Approve opens or reuses an approval on the "web" channel (`POST /internal/approvals/request`), shows the server's terms (business, amount paid now, total, caveats) in a confirm step, and the confirming click decides it (`POST /internal/approvals/decide`, recorded as `web:<the signed-in user>`). No code ever leaves the server. On the charging rail Pay then calls `pay`; on the manual rail (`HAGGLE_PAYMENTS=manual`, production) the panel shows the purchase stages: the vendor's written confirmation, its payment instructions as untrusted text (verify before paying), "I've paid the vendor" (`/internal/purchases/paid`), the vendor's receipt; plus "booking confirmed" (`/internal/purchases/booked`) and cancel (`/internal/purchases/cancel`). Callbacks go through `/internal/callbacks/authorize` and still need a justified callback and the business's recorded consent. `HAGGLE_WEB_APPROVALS=false` turns these routes off (text approval by `YES <code>` keeps working either way). MCP tools are unchanged: no agent can approve through them.

**Route guards** (`lib/approval/route.ts`):
- At most 30 actions per user per minute.
- A double click joins the request already running for the same user, action, deal and target.
- Ids are validated.
- Errors use these statuses: `401`, `403`, `400`, `429`, `422` (tool refusal, with the fix) and `502` (server unreachable or service credential refused).

---

## Environment variables

Next.js reads env files from `apps/web/`, so put the web app's variables in `apps/web/.env.local` (gitignored). The MCP server reads `apps/mcp/.env`. [`.env.example`](../.env.example) documents them under "Web app".

| Variable | Where | Purpose |
|---|---|---|
| `HAGGLE_SERVICE_TOKEN` | **both** (same value) | Shared secret, at least 32 characters. Unset on the server means the web app's access is off. |
| `HAGGLE_MCP_URL` | web | Base URL of the MCP server, without `/mcp`. Default `http://localhost:3000`. |
| `NEXT_PUBLIC_SUPABASE_URL` | web | The Supabase project URL. It is inlined into the browser bundle. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | The anon key, public by design and inlined into the browser bundle. |
| `SUPABASE_SERVICE_ROLE_KEY` | web (server only) | Writes memberships and chat threads, bypassing row-level security. |
| `ANTHROPIC_API_KEY` | web (server only) | The chat. Without it, the chat says it isn't configured and the rest of the app still works. |
| `WEB_CHAT_MODEL` | web (optional) | Overrides the chat model (default `claude-opus-5-5`). |

Generate a token with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

---

## Running locally

Prerequisites: `npm install` at the repo root, and a **development** Supabase project. Never use a production database.

1. **Prepare the database.** In the Supabase project, apply the engine migrations (`supabase/migrations/1xx_*`, in order) to the `public` schema, then `300_web_accounts.sql` and `301_web_chat.sql`. Migration 300 references `public.workspaces`, which comes from `103_engine_parity.sql`. Both web migrations are idempotent.
2. **Configure the MCP server** in `apps/mcp/.env`:
   ```
   HAGGLE_MODE=mock
   HAGGLE_AUTH=required
   HAGGLE_SERVICE_TOKEN=<the token>
   HAGGLE_MOCK_DATABASE_URL=<the dev project's postgres:// connection string>
   ```
   The last line matters. By default, a mock server keeps workspaces in memory, so the web app's membership write fails: `workspace_members.workspace_id` is a foreign key to `public.workspaces`. A restart would also lose every workspace. `HAGGLE_MOCK_DATABASE_URL` makes the mock server store them in the same database. This writes DEMO data, which is one more reason to use a dev-only project. In live mode, `SUPABASE_DB_URL` plays the same role.
3. **Start the MCP server:** `npm run dev:mcp`. It listens on `http://localhost:3000/mcp`.
4. **Enable auth** in the Supabase dashboard:
   - Under Authentication → Providers, turn on Email, and Google if you want it (Google needs an OAuth client).
   - Under Authentication → URL Configuration, add `http://localhost:3200/auth/callback` to the Redirect URLs.
5. **Configure the web app** in `apps/web/.env.local`: `HAGGLE_SERVICE_TOKEN` (the same value), `HAGGLE_MCP_URL=http://localhost:3000`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY`.
6. **Run the web app:** `npm run dev -w @haggle/web`. Open `http://localhost:3200`, sign in, create the workspace, and try "Lunch for 40 next Thursday in SoMa, under $1,500". Everything is labelled DEMO in mock mode.

Type checking runs with `npm run typecheck -w @haggle/web` (TypeScript 7). `next build` skips its own checker (`ignoreBuildErrors`), so run typecheck separately.

---

## Testing

Run the web tests from the repo root with `npx vitest run apps/web/tests`. They are also part of `npm test`.

| File | Covers |
|---|---|
| `tests/haggle.test.ts` | The MCP client: service headers on every call, JSON and SSE answers, tool error envelopes and HTTP refusals as `HaggleError` with the server's fix, `_meta` kept apart, and provisioning. |
| `tests/chat.agent.test.ts` | The chat loop, with a fake Anthropic stream and a fake Haggle client. Covers the allowlist (`approve` and `pay` never reach the server), `meta` never reaching the model, result capping, errors with their fix, the `deal` event (none for a dry run), the 20 s `wait_for_update` cap, the 12-call cap, refusal, `pause_turn` and the request shape (cache breakpoints, date in the user turn). |
| `tests/chat.store.test.ts` | Thread titles and ownership, the history window, what the browser shows, the streamed-event reducer and the 20-turn limit. |
| `tests/dashboard.test.ts` | State words, the timeline, money and time formatting, quote ordering against `fixtures/views/deal-board.json`, SSE frames, the stream loop and the actions handler. |
| `tests/approval.flow.test.ts` | Approve (ticket path and text path), pay, and callbacks (code path and text path), with refusals. No result carries a code. |
| `tests/approval.routes.test.ts` | Route logic: `401`/`403` JSON, body and id validation, the per-user rate limit, double-click joining, and error statuses. |
| `tests/approval.e2e.test.ts` | Approve then pay against the **real built** MCP server, in mock mode with auth required and a service token: provision, start a deal, approve, pay, and check that the deal ends paid (simulated) with no code in any response. **Build the server first** (`npm run build -w @haggle/mcp`, which runs `mcp-use build`); otherwise this test fails, including inside `npm test`. |

All of these tests call no external service. The e2e test starts a local server on a random port.

### Browser tests (Playwright)

Specs live in `apps/web/e2e/` (`*.spec.ts`, run by Playwright 1.64.1 in Chromium), not in `tests/`, so vitest never collects them. Install the browser once: `npx playwright install chromium` (in `apps/web`).

| Spec | Covers | Needs |
|---|---|---|
| `e2e/public.spec.ts` (tier 1, also in CI as `web-e2e`) | `/`, `/login`, `/terms`, `/privacy`, `/acceptable-use` render with no CSP violation and no CSP console error. Each response has exactly one CSP, with a nonce, `'strict-dynamic'` and no `'unsafe-inline'` in `script-src`, and every `<script>` carries that nonce. Three loads get three nonces. A signed-out `/chat` redirects to `/login` with a CSP on the redirect. A nonce-less inline `<script>` injected into the real response is blocked and reported. The static security headers appear once each. | A production build with placeholder values and demo off. Nothing is contacted. |
| `e2e/guest-deal.spec.ts` (tier 2, local only) | A demo guest end to end: the landing banner and "Try the demo, no sign-up" (Supabase anonymous sign-in), the chat (a scripted fake Claude previews with a dry run, then starts the deal once the guest says yes), "Open deal board", final quotes, "Approve $5", "Yes, approve $5", "Pay $5", and "Paid $5 to Bay Catering (simulated)." No CSP violation on any page. | Docker Desktop running, and the MCP server built (`npm run build -w @haggle/mcp`). |

```bash
# Tier 1, from the repo root
NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder-anon-key \
  NEXT_PUBLIC_HAGGLE_DEMO=false npm run build -w @haggle/web
npm run e2e -w @haggle/web -- e2e/public.spec.ts    # next start on 127.0.0.1:3210 (E2E_PORT to change it)

# Tier 2, from the repo root (Docker running; rebuilds apps/web/.next as a demo build)
node apps/web/e2e/tier2.ts           # add --keep to leave the local Supabase stack up
```

`e2e/tier2.ts` does the whole setup and teardown:

1. It starts a local Supabase stack with the pinned CLI (`npx supabase@2.122.0 start --workdir apps/web/e2e`; `apps/web/e2e/supabase/config.toml` turns on anonymous sign-ins and moves the ports to 554xx).
2. It applies `supabase/migrations/*.sql` itself with `psql` in the database container, because the CLI expects timestamped migration names.
3. It starts `e2e/fakeAnthropic.ts` and points the web app at it with `ANTHROPIC_BASE_URL`.
4. It starts the built MCP server in mock mode (auth required, a random service token, `HAGGLE_MOCK_DATABASE_URL` set to the local database, so `workspace_members` can reference the workspace row).
5. It builds and starts the web app with `NEXT_PUBLIC_HAGGLE_DEMO=true`, then runs the spec.

Keys and tokens are local throwaways, passed only through process environments. Server logs go to `<os tmp>/haggle-tier2/`. After a tier-2 run, rebuild with the placeholder values before running tier 1 again.

---

## Deployment notes

- **Web app.** Deploy to Vercel or any Node host (`npm run build -w @haggle/web`, then `npm run start -w @haggle/web`).
  - Set the variables above on the host.
  - Add the production `<origin>/auth/callback` to Supabase's Redirect URLs.
  - The chat and stream routes run on the Node runtime with `maxDuration = 300`, so the host must allow 5-minute streaming responses. The SSE client reconnects after the 5-minute cut either way.
- **MCP server.** Deploy to Manufact as described in [README §10](../README.md#10-deployment). Set `HAGGLE_SERVICE_TOKEN` with `npx mcp-use servers env set …`, using the same value as the web app, and point the web app's `HAGGLE_MCP_URL` at the server's base URL (copy it from the Manufact dashboard).
- **Never deploy or push without the operator's go-ahead.** Builds cost money.

---

## Known limitations

- **Browser tests cover the public pages and the demo guest path only.** CI runs tier 1 (public pages and the CSP). Tier 2 (a demo guest's deal → approve → pay) runs locally against a local Supabase and a scripted fake Claude. Signed-in email/Google flows, the vendors, settings and account pages, and real Claude replies are still checked by hand ([Browser tests](#browser-tests-playwright)).
- **Rate limits are shared, except double-click joining.** The chat's 20 turns per 10 minutes and daily cap, the approval routes' 30 actions per minute, the vendor routes' and the account routes' limits are counted in the database (`take_rate_slot`, migration 124; `lib/limiters.ts` over `lib/rateLimit.ts`, with the service-role client on the server only), so every instance counts together. If the database can't answer, an instance falls back to its own memory count and logs `rate_limit_fallback` once per outage. Double-click joining stays in each instance's memory; a repeat that reaches another instance is still safe (the server's approval transitions are compare-and-set).
- **The MCP tool-call limiter is per process too.** The limiter (`apps/mcp/src/limits.ts`, on by default in live mode) gives web traffic one bucket per workspace: service-token requests are keyed on the token plus `x-haggle-workspace` (tested in `apps/mcp/tests/limits.test.ts`). Unlike the web caps, those buckets live in each MCP replica's memory.
- **Workspace settings are read-only in the app.** Changing the approver or raising the cap is the operator's job.
- **One workspace per user.** `requireHaggle` uses the user's first membership, and there is no workspace switcher or invite flow.
