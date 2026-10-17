# Buyer-side implementation plan (Yash)

Status as of 2026-10-16 (Friday, pre-event). See `docs/progress.md` for what is actually done.

## Event-rules gate

The official event page (https://events.ycombinator.com/MakeSomethingAgentsWant) has **no
rules section** and says nothing about pre-existing code. Its only timing text is
"10:30 AM - Hacking Begins" (Sat Oct 17) and "10:00 AM - Submissions Due + Live Demos"
(Sun Oct 18). Pre-event implementation is therefore **not established as permitted**.

Until that is confirmed with organizers, Friday work is limited to what the plan itself calls
the head start — accounts, contracts, schema, scaffold, integration spikes, fixtures — and
product logic (parsing, negotiation, tools, deal board, payment) waits for kickoff or explicit
confirmation. Organizer contacts listed on the event page include the track judges.

## Architecture

```
buyer agent ──MCP──▶ apps/mcp (mcp-use v2 on Manufact)
                      ├─ tools: deal, wait_for_update, get_quotes, answer_seller, approve, pay, cancel
                      ├─ views/deal-board (React MCP App bound to get_quotes)
                      ├─ POST /inbound  (Primitive webhook, HMAC verified on the raw body)
                      └─ GET /health
                     packages/core (pure, testable without a server)
                      ├─ schemas + state machine + protocol parts      [done]
                      ├─ parsing (quote.json deterministic; text/PDF via Claude structured output)
                      ├─ requirements evaluator, ranker, negotiation policy/engine
                      ├─ approval + payment gate (all invariants as pure functions)
                      └─ storage: Repository interface → InMemory + Postgres implementations
                     supabase/migrations                                [done, verified]
```

Ports with test doubles: `EmailTransport` (Primitive | InMemory), `QuoteExtractor`
(Anthropic | fixture), `PaymentGateway` (PrimitiveX402 | Fake), `HumanApprovalProvider`
(elicitation / verified email | Fake), `Repository` (Postgres | InMemory), `Clock`.

## Verified platform facts that shape the design

- **mcp-use 2.10.0** (Node ≥ 22.22.2; we use Node 24): stateless; views in
  `views/<name>/view.tsx`; tools bind with `view: { name }` and need `outputSchema`; views use
  `useToolContext` / `useCallTool`; `server.post('/inbound')` is a Hono route with raw body
  available, so **no Edge Function fallback is needed**; elicitation is an `inputRequired`
  round trip that re-runs the handler, so approval handlers must be idempotent; skills ship
  from `skills/<name>/SKILL.md`.
- **Primitive SDK `@primitivedotdev/sdk` 2.4.0**: `client.send(input, { idempotencyKey })`;
  `client.reply(email, { text, html, attachments })` (server sets threading); any local part on
  the managed `*.primitive.email` domain is accepted, so job inboxes need no provisioning;
  webhook `Primitive-Signature: t=…,v1=HMAC-SHA256("t.rawBody")` via `verifyWebhookSignature`;
  dedupe on top-level `id` (`evt_…`); sender trust from `email.analysis.sender.authenticated`
  (`sender_verified` is *not* a webhook field) and `isTrustedSender()`; attachments arrive as
  a tar.gz via `attachments_download_url`. Keyless identical sends within 5 minutes are
  silently deduped, so every logical send gets an explicit idempotency key.
- **x402 over email**: `parseEmailChallengeFromPart` → `x402.payEmailChallenge(challenge,
  { signer })` **only signs**; Haggle must reply in-thread with the `interaction.json`
  attachment. Amounts are 6-decimal base units. Receipt arrives as a `receipt` step with
  `settle_tx` plus a `payment.settled` webhook. Needs `x402_payments` +
  `interactions_enabled` (invite-only); 10 USDC per-settle ceiling.
- New Primitive accounts are **reply-only to known addresses** — outbound RFQs to new sellers
  fail with `recipient_not_allowed` until upgraded (`GET /v1/send-permissions`).

## Phases and critical path

| Phase | Content | Gate |
|---|---|---|
| A ✅ | schemas, state machine, protocol parts, migrations, contracts | setup (allowed either way) |
| B | Primitive adapter + `/inbound` + InMemory transport; spike with real creds | spike allowed |
| C | quote ingestion: quote.json, text, HTML, PDF; fixtures for six traps | after kickoff |
| D | requirements evaluator, ranker, negotiation engine | after kickoff |
| E | MCP tools over the core | after kickoff |
| F | deal board view | after kickoff |
| G | approval + x402 payer gate (fake gateway first) | after kickoff |
| H | one-command offline demo | after kickoff |
| I | Manufact deploy | after kickoff |

Critical path: B → C → E (deal/get_quotes) → G → H. The deal board (F) parallelizes after E.

## Credentials needed

Primitive API key + webhook secret (buyer org), x402 entitlements, Base Sepolia buyer wallet
with test USDC, Anthropic API key, Supabase project, Manufact login. None are present yet.

## Acceptance (overall)

Offline six-seller scenario passes from one command; every financial invariant has a test;
mock data is labelled as mock everywhere; real integrations are reported only when exercised.

## Risks / fallbacks

- x402 entitlement not granted → Fake gateway in demo clearly labelled; Stripe test mode only after the core path.
- Reply-only account → sellers email the job inbox first (plan's fallback), or request upgrade.
- Managed-subdomain DKIM alignment for x402 between two orgs is UNCONFIRMED → test on day one.
- Elicitation unsupported or unprovable in a host → verified email approval.
