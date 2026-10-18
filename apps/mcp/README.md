# Haggle MCP server (apps/mcp, owner: Yash)

mcp-use 2.10.0 server + MCP App. Agents call the tools headlessly (Claude Code); ChatGPT and Claude
also render the views in `views/` (Aarnav).

## Run

```bash
npm install                                              # repo root (npm workspaces)
npm run build -w @haggle/mcp                             # production build (views included)
cd apps/mcp && HAGGLE_MODE=mock npx mcp-use start        # http://localhost:3000/mcp
#   Inspector (with --with-inspector, or `mcp-use dev`): http://localhost:3000/mcp/inspector · health: /health
#   Faster demo replies: HAGGLE_SIM_DELAY_SCALE=0.2
npm test -w @haggle/mcp                                  # transport E2E against the built server, webhook route, view mapping
# Real MCP client: mcp-use client connect local http://localhost:3000/mcp && mcp-use client local tools call open_haggle '{}'
```

`HAGGLE_MODE=mock` (default) needs no credentials: simulated businesses (email + one simulated Voice AI
call), simulated approval and payment, and every response says `[DEMO]` / `mode: "mock"`.

`HAGGLE_MODE=live` needs `INKBOX_API_KEY`, `INKBOX_WEBHOOK_SECRET`, `SUPABASE_DB_URL` (see `/.env.example`;
migrations 100-103 applied), and refuses to start partially. `ANTHROPIC_API_KEY` is recommended: without it,
or when Claude fails, replies are read by a keyword fallback at low confidence (flagged `low_confidence`).
Live mode emails only `HAGGLE_DEMO_FLEET` +
`HAGGLE_ALLOWED_RECIPIENTS`; phone calls, A2A tasks and iMessage approvals stay off unless
`HAGGLE_ENABLE_CALLS` / `HAGGLE_ENABLE_A2A` / `HAGGLE_ENABLE_IMESSAGE` are `true`. After deploying a
server that handles them, add the channel events to the webhook subscription:
`node packages/engine/scripts/inkbox-channel-events.ts apps/mcp/.env --confirm`.
Point the buyer identity's Inkbox webhook subscription (`message.received`, `call.ended`) at
`POST <public url>/webhooks/inkbox`; after a redeploy to a new URL:
`node packages/engine/scripts/inkbox-webhook-move.ts apps/mcp/.env https://<new host> --confirm`.

With calls on, an email business that also has a phone and stays silent for
`HAGGLE_ESCALATION_WAIT_MINUTES` (or bounces) gets a Voice AI call; calls happen only within
`HAGGLE_CALL_HOURS` in the workspace's timezone and never twice to one number within 2 minutes; the
Voice AI's answering instructions list the open requests so callbacks are matched.

## Workspaces (multi-user)

Each MCP connection is bound to one workspace: jobs, settings (cap, approver, area) and
`client_request_id` are scoped to it, and another workspace's ids read as not found. Every workspace
shares the `haggle` Inkbox identity.

```bash
npm run workspace:create -w @haggle/mcp -- --name "Acme ops" --approver-phone +14155550123 --cap 1500 --base-url https://<host>
# prints a bearer token (Claude Code: --header "Authorization: Bearer <token>") and a connector URL
# https://<host>/c/<secret>/mcp (Claude / ChatGPT custom connectors); only SHA-256 hashes are stored
```

Set `HAGGLE_AUTH=required` on hosted servers: requests without a workspace credential get 401 (the
bare `initialize`/`ping` handshake stays open for health checks). Without it, requests without
credentials use the default workspace; a wrong credential is always refused.
`POST /internal/tick` with `Authorization: Bearer $HAGGLE_TICK_SECRET` advances every open deal
(for an external cron).

## Deploy (Manufact)

calm-spark-ck3qm is a managed upload (not GitHub): pushing `main` doesn't deploy it. Deploy from the repo
root of a clean checkout of the commit you want, holding the gitignored link file
`.mcp-use/cloud/link.json` (no `--new`/`--name`, so the same server is updated; `.env*` is never uploaded):

```bash
npx mcp-use login
./node_modules/.bin/mcp-use deploy --json            # then follow the "building" deployment:
./node_modules/.bin/mcp-use deployments logs <id> --build --follow
```
Server config (npm workspaces hoist the CLI to the repo root): start command
`cd apps/mcp && ../../node_modules/.bin/mcp-use start --host 0.0.0.0`, port 3000. Env vars persist across
deploys; `servers env` commands take the server id, not the slug. Copy the MCP URL from the dashboard.

## Tools

| Tool | View | Backed by |
| --- | --- | --- |
| `ask` | estimates | brain.estimate (real `@haggle/brain`, seeded) |
| `discover` | | brain.discover (mock mode: the simulated fleet only) |
| `check_price` | | brain.checkPrice |
| `get_identity` | identity-card | engine (name, email, phone, channel readiness, masked approver, cap, workspace) |
| `deal` | deal-live (the deal board, drawn once per deal; it refreshes itself) | engine (Inkbox email; phone when enabled; email→call escalation). Catering default, or any request via `ask[]` + `compare_by` + `payable_field` |
| `wait_for_update` | | engine (≤ 60 s long-poll, cursor, `until`: any_change / ready / approval_decided / done) |
| `get_quotes` | none (data only; the board polls it) | engine (deal board read model → `DealBoardPlus`, `src/views.ts`; custom answers in `fields`; an unknown total is null, never $0; no job_id lists recent deals) |
| `list_deals` | | engine: recent deals in this workspace (open first) |
| `answer_business` | | engine (message guard) |
| `send_message` | | engine: free text or `ask_missing`, email thread / short call / A2A; message guard (real amounts only, no other names, no commitments) |
| `negotiate` | | engine: the honest counteroffer round once quotes are final, if it hasn't run (2 rounds at most: `no_rounds_left`) |
| `call_back` / `call_back_in_view` | | engine: one human-authorized Voice AI callback citing a real cheaper quote, only while a negotiation round is left |
| `get_conversation` | conversation | engine: one business's messages and calls |
| `cancel_deal` | | engine: voids the approval, polite cancel notes |
| `approve` | approval | engine (`action`: pay (default) / confirm; human: client form, a text "YES <code>", an email "APPROVE <code>", or the approval card / board; 5 wrong codes lock it; NO_HUMAN_CHANNEL otherwise; DEMO sim in mock). Approving records the human's OK and charges nothing (approve, then pay) |
| `pay` | payment (same card) | engine: the charge. Stripe TEST MODE (opt-in `HAGGLE_ENABLE_PAYMENTS=true`) of the approved amount (the deposit, or the full total when none was stated); exact approved quote + amount, cap, quoting payee, one charge per approval; refuses confirm-only approvals; simulated in mock; the business then gets a confirmation with the payment reference |
| `business_profile` | business-profile | brain.getProfile |
| `open_haggle` `{}` / `{job_id}` | deal-board (global + thread entrypoints; re-opens the board only when asked) | engine |
| `settings.read` / `settings.update` | native | engine (cap ≤ operator ceiling) |
| `mention_businesses` + `business://{slug}` | native | engine |
| `approve_in_view` | app-only | the human's tap on the approval card / deal board (one-time code in `_meta`, never model-visible); records the approval, then the card calls `pay` |
| `choose_in_view` | app-only | the board's "Choose this" on any safe quote: starts a board-only approval and hands the code to the board |

Views bind only when `views/<name>/view.tsx` exists (mcp-use refuses to start when a tool names a
missing view, and allows one tool per view).

## Brain and view schemas

View-bound tools return the shared `@haggle/core` view schemas (`packages/core/views.ts`); the engine's
read models are mapped in `src/views.ts`. The engine teaches the real brain through
`@haggle/engine` `BrainAdapter` (directory business ids, one flat reply per item, trusted senders only);
`src/brain.ts` builds it. Mock mode keeps the brain in memory.
