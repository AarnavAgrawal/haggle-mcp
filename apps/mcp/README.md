# Haggle MCP server (apps/mcp, owner: Yash)

mcp-use 2.10.0 server + MCP App. Agents call the tools headlessly (Claude Code); ChatGPT and Claude
also render the views in `views/` (Aarnav).

## Run

```bash
corepack pnpm install
corepack pnpm --filter @haggle/mcp build                 # production build (views included)
cd apps/mcp && HAGGLE_MODE=mock ./node_modules/.bin/mcp-use start   # http://localhost:3000/mcp
#   Inspector (with --with-inspector, or `mcp-use dev`): http://localhost:3000/mcp/inspector · health: /health
#   Faster demo replies: HAGGLE_SIM_DELAY_SCALE=0.2
corepack pnpm --filter @haggle/mcp test                  # transport E2E against the built server + webhook route
# Real MCP client: mcp-use client connect local http://localhost:3000/mcp && mcp-use client local tools call open_haggle '{}'
```

`HAGGLE_MODE=mock` (default) needs no credentials: simulated businesses (email + one simulated Voice AI
call), simulated approval and payment, and every response says `[DEMO]` / `mode: "mock"`.

`HAGGLE_MODE=live` needs `INKBOX_API_KEY`, `INKBOX_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `SUPABASE_DB_URL`
(see `/.env.example`), and refuses to start partially. Live mode emails only `HAGGLE_DEMO_FLEET` +
`HAGGLE_ALLOWED_RECIPIENTS`; phone calls stay off unless `HAGGLE_ENABLE_CALLS=true`.
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
| `ask` | estimates* | brain.estimate |
| `discover` | | brain.discover |
| `check_price` | | brain.checkPrice |
| `deal` | | engine (Inkbox email; phone when enabled) |
| `wait_for_update` | | engine (≤ 60 s long-poll, cursor) |
| `get_quotes` | deal-board | engine (deal board read model) |
| `answer_business` | | engine |
| `approve` | approval* | engine (human: client form or approval card; NO_HUMAN_CHANNEL otherwise; DEMO sim in mock) |
| `pay` | | engine: Stripe TEST MODE deposit (opt-in `HAGGLE_ENABLE_PAYMENTS=true`); exact approved quote + amount, cap, quoting payee, one charge per approval; simulated in mock |
| `business_profile` | business-profile* | brain (optional `getProfile`) |
| `open_haggle` `{}` | haggle-home* (global + thread entrypoints) | engine |
| `settings.read` / `settings.update` | native | engine (cap ≤ operator ceiling) |
| `mention_businesses` + `business://{slug}` | native | engine |
| `approve_in_view`, `answer_seller` | app-only | approval card button; v3 view alias |

\* Bound automatically as soon as `views/<name>/view.tsx` exists. mcp-use refuses to start when a
tool names a missing view, and allows one tool per view.

## Requests (shared / partner-owned files; not edited here)

1. **`packages/core/views.ts` (shared):** move `src/schemas/views.ts` there verbatim (DealBoard,
   Approval, Estimates, BusinessProfile). Additions over CLAUDE.md §5 are marked; one needs agreement:
   business status `unavailable` (business whose only channel isn't enabled; never contacted).
2. **`packages/core/contracts.ts` (shared):** v5 `Business` (`phone?`, `a2a_card_url?`, `best_channel`),
   `Quote.channel`, `ReplyMeta.channel` + `"call"`, `ApprovalRecord.channel` + `"view" | "imessage"`, and
   `Brain.getProfile(businessId): Promise<Profile | null>` (the engine already calls it when present).
3. **Aarnav, views:** `views/deal-board` should call `answer_business` (then `answer_seller` goes) and poll
   `wait_for_update`; add `views/haggle-home/view.tsx` (`export { default } from "../deal-board/view";`) so
   the launcher binds; the approval card reads `_meta["haggle/approval"] = { approval_id, code }` and calls
   `approve_in_view` on the human's tap.
4. **Aarnav, brain:** export a class implementing `Brain` (+ `getProfile`); swap it for `StubBrain` in
   `src/live.ts` and `@haggle/engine` mock wiring.
