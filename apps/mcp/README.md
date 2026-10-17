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

`HAGGLE_MODE=live` needs `INKBOX_API_KEY`, `INKBOX_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `SUPABASE_DB_URL`
(see `/.env.example`), and refuses to start partially. Live mode emails only `HAGGLE_DEMO_FLEET` +
`HAGGLE_ALLOWED_RECIPIENTS`; phone calls, A2A tasks and iMessage approvals stay off unless
`HAGGLE_ENABLE_CALLS` / `HAGGLE_ENABLE_A2A` / `HAGGLE_ENABLE_IMESSAGE` are `true`. After deploying a
server that handles them, add the channel events to the webhook subscription:
`node packages/engine/scripts/inkbox-channel-events.ts apps/mcp/.env --confirm`.
Point the buyer identity's Inkbox webhook subscription (`message.received`, `call.ended`) at
`POST <public url>/webhooks/inkbox`.

## Deploy (Manufact)

```bash
npx mcp-use login
npx mcp-use deploy --name haggle --root-dir apps/mcp     # GitHub App installed on the repo
# or: npx -y mcp-use@latest deploy --no-github -y
```
Set the live env vars in the Manufact dashboard and copy the MCP URL from it (don't guess it).

## Tools

| Tool | View | Backed by |
| --- | --- | --- |
| `ask` | estimates | brain.estimate (real `@haggle/brain`, seeded) |
| `discover` | | brain.discover (mock mode: the simulated fleet only) |
| `check_price` | | brain.checkPrice |
| `deal` | | engine (Inkbox email; phone when enabled) |
| `wait_for_update` | | engine (≤ 60 s long-poll, cursor) |
| `get_quotes` | deal-board | engine (deal board read model → shared `DealBoard`, `src/views.ts`) |
| `answer_business` | | engine |
| `approve` | approval | engine (human: client form, iMessage "YES <code>" to the settings approver, or the approval card; NO_HUMAN_CHANNEL otherwise; DEMO sim in mock) |
| `pay` | payment (same card) | engine: Stripe TEST MODE deposit (opt-in `HAGGLE_ENABLE_PAYMENTS=true`); exact approved quote + amount, cap, quoting payee, one charge per approval; simulated in mock |
| `business_profile` | business-profile | brain.getProfile |
| `open_haggle` `{}` | launcher (global + thread entrypoints) | engine |
| `settings.read` / `settings.update` | native | engine (cap ≤ operator ceiling) |
| `mention_businesses` + `business://{slug}` | native | engine |
| `approve_in_view` | app-only | the human's tap on the approval card / deal board (one-time code in `_meta`, never model-visible) |

Views bind only when `views/<name>/view.tsx` exists (mcp-use refuses to start when a tool names a
missing view, and allows one tool per view).

## Brain and view schemas

View-bound tools return the shared `@haggle/core` view schemas (`packages/core/views.ts`); the engine's
read models are mapped in `src/views.ts`. The engine teaches the real brain through
`@haggle/engine` `BrainAdapter` (directory business ids, one flat reply per item, trusted senders only);
`src/brain.ts` builds it. Mock mode keeps the brain in memory.
