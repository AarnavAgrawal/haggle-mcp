# Quote Broker

MCP server (mcp-use v2, Manufact Cloud) that gets catering quotes from restaurants by email, has them compete, and pays a deposit after a human approves.

**DESIGN.md is the source of truth.** Read it before changing anything. Build in the milestone order of §19, and follow the working agreement in §25:

- Plan before code at each milestone; wait for a go-ahead.
- `src/jobs/stateMachine.ts` and `src/payments/guard.ts` are pair-written: tests first, the human reviews the implementation line by line.
- Verify vendor APIs against installed SDK types or docs; mark anything unconfirmed `TODO(verify)`.
- Safety lines in §16 are fixed. Stripe test mode only, simulated vendors only, no secrets in outputs or logs.
- Never ask for or read API keys. They live in `.env` (local) and Manufact env vars (deployed), set by the human.

## Commands

- `npm run dev`: dev server and Inspector (`/mcp/inspector`)
- `npm test`: Vitest (unit tests + an in-memory lifecycle test of advanceJob)
- `npm run typecheck`, `npm run build`
- `npm run sim`: restaurant simulators (separate process)
- `npm run setup:sim`, `npm run setup:stripe`: one-time setup; secrets go straight into `.env`
- `npm run eval -- --runs 5`: AX eval (baseline vs treatment)
- `npm run doctor` (`-- --remote` for the deployed server): preflight of every outside service; prints pass/fail only, never values

## Deviations from DESIGN.md (with reasons)

- Parser uses Claude structured outputs (`messages.parse` + `zodOutputFormat`), not forced `tool_choice`, and no `temperature`. Current models reject forced tool choice and non-default temperature.
- Sender authentication uses the SDK's `validateEmailAuth` / `isTrustedSender`. The webhook payload has no `email.analysis.sender.authenticated` field.
- Primitive's send response has no Message-ID or thread id. The Message-ID is looked up via `getSentEmail`; the thread id is learned from the vendor's first reply.
- Counteroffers, receipts, and cancel notes go out with `POST /emails/{id}/reply` on the vendor's latest inbound email, so Primitive handles threading.
- `messages` has extra columns (`kind`, `round`, `rfc_message_id`, `attachments_download_url`); `approvals` has `outbound_message_id` and a one-pending-per-job unique index.
- "All vendors replied" also closes a negotiation round (when every countered vendor has answered), so demos don't wait for the deadline. It only counts once `counteroffers_sent` is recorded for that round.
- Missing env vars don't crash startup; tools return `CONFIG_MISSING` naming them. A live Stripe key still refuses to boot.
- `pay` uses Stripe idempotency key `pay:{approval_id}:v{job.version}`: concurrent or retried calls share a key, and a deliberate retry after a recorded failure gets a fresh one.
- `list_quotes` has an MCP App view (`views/quote-board`). Its button only sends a follow-up prompt; approval still requires the email reply.
- S2 live page is built: `GET /live` and `/live/:jobId`, gated by `LIVE_PAGE_TOKEN` (404 when unset or wrong). `src/live/render.ts` is pure and escapes everything; approval codes and the approver's address are redacted. Strict CSP with a per-request nonce.
- A reply-only Primitive account can still email the simulators (Primitive's managed zone is always allowed); the approval email to `BUYER_EMAIL` needs `any_recipient` or that address having emailed the broker first. `npm run doctor` checks both.
- Public mode (`AUTH_MODE=oauth`, not in DESIGN.md): Supabase OAuth 2.1 sign-in via `oauthSupabaseProvider`; `src/caller.ts` turns `ctx.auth` into a `Caller`, and every job-taking tool goes through `loadOwnedJob` (`src/tools/access.ts`). Approver = the signed-in email (never tool input); per-user Stripe test customers (`src/payments/customers.ts`); vendors limited to `DEMO_VENDORS`; `list_demo_vendors` is an 8th tool; `client_request_id` is stored as `<user>:<id>`. In oauth mode a request without a verified user throws, never falls back to the operator. `guard.ts` and `stateMachine.ts` are unchanged.
- `/oauth/consent` is our sign-in page for Supabase's OAuth server (supabase-js 2.118.0 from jsdelivr, built with textContent only, strict CSP).
- Simulators live in `sim/simulator.ts` with a pluggable store: file (`npm run sim`) or the `sim_state` table (`SIM_ON_SERVER=true`, `src/sim/hosted.ts`). Personas are `sim/personas.ts` (a module, so it bundles).
- `ConfigError` uses a plain field (not a parameter property) so `node` can run scripts that import `src/config.ts` directly.
