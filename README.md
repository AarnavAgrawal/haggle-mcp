# Quote Broker

An MCP server that lets AI agents get catering quotes from restaurants by email, make them compete, and pay a deposit after a human approves. Built with [mcp-use](https://mcp-use.com) and hosted on Manufact Cloud. Full design: [DESIGN.md](DESIGN.md).

> Agents can plan your event, but they can't get a quote from a caterer. This is the tool that lets them.

## The agent's whole job: seven tools

| Tool | What it does |
|---|---|
| `create_quote_request` | Emails up to 5 vendors and returns a `job_id` immediately |
| `wait_for_job` | Long-polls (up to 50 s) until the job changes; replaces polling |
| `list_quotes` | Every vendor's current quote in one format, best one flagged (renders as a table in MCP Apps hosts) |
| `request_approval` | Emails the human the chosen quote with a one-time code |
| `pay` | Charges the approved deposit (Stripe test mode); refuses anything not approved |
| `get_job` | Status, vendor progress, approval, optional timeline |
| `cancel_job` | Cancels and politely tells vendors who replied |

The server does the rest: outreach, waiting, parsing sloppy replies and PDF menus, an honest negotiation round, verifying the human's email approval, and payment.

## Safety, enforced in code

- **No payment without a verified human approval** for that exact job, vendor, and amount (`src/payments/guard.ts`). The charge amount comes from the database, never from tool input or email.
- **Approvals** need the registered approver's address, DKIM/DMARC-authenticated mail, and `APPROVE <code>` in the first line they wrote; quoted text is ignored (`src/approvals/verifyApproval.ts`).
- **Vendor email is data, not instructions.** The parser has no tools and a fixed output schema.
- **Honest negotiation.** Counteroffers are a template filled only with real stored prices and never name the competitor (`src/negotiator/counteroffer.ts`).
- **Hard spend cap**, Stripe **test mode only** (a live key refuses to boot), signed and deduped webhooks, idempotent sends and payments, and the outreach discloses that it comes from an AI agent.

## Setup

Keys never go in code or chat: they live in `.env` locally and in Manufact Cloud's environment variables.

1. **Install:** `npm install`, then `cp .env.example .env`.
2. **Supabase:** create a project, run `src/db/schema.sql` in the SQL editor, and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. **Anthropic:** set `ANTHROPIC_API_KEY`.
4. **Primitive (the broker's inbox):** set `PRIMITIVE_API_KEY` and `PRIMITIVE_FROM_ADDRESS`. A full (not reply-only) account can email anyone. A reply-only account can still email the simulated restaurants, because their inboxes are on Primitive's managed zone. It can only email your approver address after that address has emailed the broker once. `npm run doctor` tells you which case you're in. Create a webhook endpoint pointing at `https://<server>/webhooks/primitive` for `email.received` and `email.bounced`, then set `PRIMITIVE_WEBHOOK_SECRET` and `PRIMITIVE_ENDPOINT_ID`.
5. **Simulated restaurants:** `npm run setup:sim` creates four Primitive agent inboxes, writes their keys into `.env`, and prints the vendor list.
6. **Stripe (test mode):** set `STRIPE_SECRET_KEY=sk_test_...`, then run `npm run setup:stripe`. It writes `STRIPE_CUSTOMER_ID` and `STRIPE_PAYMENT_METHOD_ID` into `.env`.
7. **Approver and server:** set `BUYER_EMAIL` (the inbox that will reply `APPROVE`), `MCP_AUTH_TOKEN` (any long random string), `INTERNAL_TICK_SECRET`, `LIVE_PAGE_TOKEN` (for the demo page), and `DEMO_MODE=true` for short timers.
8. **Check:** `npm run doctor` checks every service (tables, send permissions, webhook endpoint, models, Stripe customer) and prints only pass/fail plus what to fix.
9. **Deploy:** copy every non-`SIM_` variable into Manufact Cloud (`npx mcp-use servers env set <server> KEY=value`, or the dashboard), then push to `main`. `npm run doctor -- --remote` confirms the deployed server picked them up.

## Run

```bash
npm run dev                                     # MCP server + Inspector at /mcp/inspector
SIM_DELAY_SCALE=0.3 npm run sim                 # restaurants (separate terminal)
claude mcp add --transport http quote-broker https://wild-cloud-utpra.run.mcp-use.com/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

Then ask Claude Code: *"Get catering for 40 people next Saturday at 6:30pm, about $25 a head, 6 vegetarian, from these restaurants: …"*

**Live page (for the demo screen):** open `https://wild-cloud-utpra.run.mcp-use.com/live?token=$LIVE_PAGE_TOKEN` to see recent jobs, then click one. It refreshes every 3 seconds and shows the quotes table, the approval, the payment, and every email in and out. It is read-only, escapes all vendor text, and never shows the approval code or the approver's full address. It is off when `LIVE_PAGE_TOKEN` is unset.

Optional backup tick (advances jobs even when no agent is calling): `POST /internal/tick` with `Authorization: Bearer $INTERNAL_TICK_SECRET` every minute from any cron.

## Public mode: anyone can use it

Set `AUTH_MODE=oauth` and the server stops using the shared `MCP_AUTH_TOKEN`. Anyone adds it with just the URL:

```bash
claude mcp add --transport http quote-broker https://wild-cloud-utpra.run.mcp-use.com/mcp
```

Claude Code then opens a browser, the person signs in (GitHub or an email link), and clicks Allow. From then on:

- **Their jobs are theirs.** Every job records its owner, and every tool refuses other people's jobs (they look like they don't exist).
- **They approve their own deposits.** Approval emails go to the address they signed in with; the agent can't pick a different one. If the broker's Primitive account can only email known addresses, the agent tells the person to send the broker one email first.
- **Their own Stripe test customer.** It's created on their first payment, with Stripe's test Visa. No real money ever moves.
- **Demo restaurants only.** `create_quote_request` accepts only `DEMO_VENDORS`, and the agent can call `list_demo_vendors` to get them. Each user can start `JOBS_PER_USER_PER_DAY` jobs a day.
- **No laptop needed.** With `SIM_ON_SERVER=true` the restaurants run inside the server (state in the `sim_state` table). Don't also run `npm run sim`.
- **Their own live page.** `create_quote_request` and `get_job` return a `live_url` that opens only that job.

One-time setup:
1. Re-run `src/db/schema.sql` (adds `jobs.owner_id`, `app_users`, `sim_state`).
2. In Supabase:
   - **Authentication → OAuth Server:** turn it on, set Authorization Path to `/oauth/consent`, and allow dynamic client registration.
   - **Authentication → URL Configuration:** set Site URL to `https://wild-cloud-utpra.run.mcp-use.com` and add `https://wild-cloud-utpra.run.mcp-use.com/**` to Redirect URLs.
   - **Authentication → Sign In / Providers:** enable GitHub (create a GitHub OAuth app whose callback is `https://<project>.supabase.co/auth/v1/callback`). Supabase's built-in email sender only reaches your own team, so for email links from strangers either add custom SMTP or set `LOGIN_METHODS=github`.
   - **Project Settings → JWT Keys:** the project must sign with asymmetric ES256 keys (the default for new projects).
   - **Keep sign-up honest:** leave **Confirm email** on, and turn off **anonymous sign-ins** and the plain email+password provider. Approval emails go to the sign-in address, so it must be one the person proved they own, and throwaway accounts would get around the daily job limit.
3. Set `AUTH_MODE=oauth`, `SUPABASE_PUBLISHABLE_KEY`, `DEMO_VENDORS`, `SIM_ON_SERVER=true`, and the `SIM_*_API_KEY` values in Manufact, then redeploy.
4. Check with `npm run doctor -- --remote` (run it with `AUTH_MODE=oauth` in your local `.env`).

The eval and `npm run sim` still work in token mode for local testing.

## Test and evaluate

```bash
npm test             # unit tests, signed-webhook safety tests, an in-memory lifecycle test
npm run typecheck
SIM_DETERMINISTIC=true SIM_DELAY_SCALE=0.3 npm run sim   # in another terminal
npm run eval -- --runs 5    # Claude Code + Primitive MCP (baseline) vs Claude Code + Quote Broker
```

The eval prints a table of turns, tokens, wall time, cost, and correctness for the demo slide.
