# v3 kickoff prep (Yash)

Written 2026-10-17 ~07:50 PDT from the updated `CLAUDE.md` and the v3 PDF plan. Docs only;
nothing below is implemented yet. `CLAUDE.md` is the source of truth; where Pass 1 work
disagrees with it, Pass 1 work changes.

## What v3 changes for the buyer side

| Area | Pass 1 (v2) state in repo | v3 rule | Consequence |
|---|---|---|---|
| Ownership | Buyer logic lives in `packages/core/src` | `packages/core` = **shared** types + `contracts.ts` only; Yash owns `packages/engine/` | Move state machine, entities, money, protocol parsing into `packages/engine` after the contracts hour; core keeps only agreed types |
| Fixtures | `fixtures/buyer/` (15 emails, 2 PDFs, scenario) written by Yash | `fixtures/` is **Partner's** ("real replies from the fleet") | Ask Partner to adopt `fixtures/buyer/` as-is or tell me where they should live; don't edit `fixtures/` after 10:30 without agreement |
| Migrations | `20261016000000_buyer_core.sql`, 14 tables incl. `sellers` | `supabase/migrations/1xx_engine_*.sql`; brain owns businesses/profiles in `2xx_brain_*.sql` | Re-cut as `100_engine_*.sql` with `jobs, job_businesses, messages, quotes, approvals, payments`; keep the DB-level money/payment invariants and RLS lockdown. **FK problem**: 1xx runs before 2xx, so `job_businesses.business_id` can't reference `businesses` unless brain's table comes first or the FK is added in a 2xx file |
| Tools | Pass 2 brief: 7 tools incl. `answer_seller`, `cancel` | 8 tools: `ask, discover, check_price, deal, wait_for_update, get_quotes, approve, pay` | No `answer_seller` / `cancel` in v3. Item 12 (question routing back in-thread) still needs an input path; decide at 10:30 (see Q3) |
| Seller fleet | v2 names (Golden Gate Kitchen, Fog City Deli, Sunset Bistro, Hayes Valley Kitchen) | Bay Catering, Harbor Table, Mission Eats, Golden Grill, Sunset Kitchen, QuickQuote Deli | Demo story is now: Harbor Table negotiated ~10% on a real competing quote; Bay Catering wins at $995 (`negotiated_from` 1150, round 2) and issues the 5 USDC x402 invoice. Old "$1,016 Golden Gate" numbers are v2 and should not be used |
| Brain | n/a | Engine calls `packages/brain` only through `contracts.ts` (`learnFromReply`, `estimate`, `checkPrice`, `negotiationHints`, `discover`) | Engine code depends on the `Brain` interface; Partner's stub (item 19, due 11:30) unblocks `ask`/`discover`/`check_price` |

## Questions to settle in the 10:30 contracts hour

1. **Money type.** The `Quote` contract uses `total_usd: number` (float dollars). Pass 1 rule was
   integer cents everywhere. Proposal: contract fields stay `*_usd` as the plan shows (2-decimal
   numbers, agent-friendly), the engine and DB store integer cents, conversion happens at one
   boundary function with rounding tests. USDC stays integer base units.
2. **Missing vs zero + provenance.** `deposit_usd?` is optional, good: absent means unknown,
   never 0. Proposal: add optional `missing: string[]` (required facts not stated) and keep the
   single `source` string; engine keeps per-field provenance internally.
3. **Question routing input.** v3 has no `answer_seller`. Options: (a) add `answer(job_id,
   question_id, text)` as a ninth engine tool; (b) accept answers via `wait_for_update`'s
   response cycle. Recommend (a): explicit side effect, easy to describe "when to use".
4. **Cancel.** Jobs outlive sessions; without `cancel` a mistaken deal keeps emailing. Recommend
   adding `cancel(job_id)` (idempotent; never reverses a settled payment), or agree it's cut.
5. **`business_id` ownership.** Who creates a business row when the agent passes raw emails to
   `deal`: engine calls `brain.discover`/an upsert in the contract, or engine writes a 1xx table?
6. **Email JSON parts.** Freeze `rfq.json` / `quote.json` / `counter.json` field lists and the
   attachment filenames; the fleet must emit `quote.json` with `valid_until`.
7. **Fixtures location** (see table) and whether Partner's fleet fixtures replace `fixtures/buyer/`.
8. **One project, several tracks** — confirm with organizers (plan says confirm at kickoff).

## Facts checked this morning that affect the plan

- **`sender_verified` isn't in the Primitive API.** It appears nowhere in the OpenAPI document
  shipped with `@primitivedotdev/sdk` 2.4.0 (latest on npm). Inbound emails expose `auth.dmarc*`,
  `auth.dkimSignatures` and `sender_connected_agent_verified`; webhooks carry
  `email.analysis.sender.authenticated`, and the SDK has `isTrustedSender()`. CLAUDE.md §3/§7
  say "`sender_verified` true". Proposal: read that as "Primitive says the sender is
  authenticated (`isTrustedSender` / DMARC-aligned pass)" and note it in CLAUDE.md by agreement.
- **Long-poll exists:** `GET /v1/emails?since=<cursor>&wait=<s>` (also `recipient=` filter). Good
  fallback for inbound if webhooks misbehave; webhooks are capped at **1 per org**.
- **Webhook route on Manufact:** mcp-use 2.10 serves custom Hono routes (`server.get/post`)
  under `mcp-use start` (verified locally with `/health`), so the "Supabase Edge Function"
  fallback should be unnecessary. Confirm on the first preview deploy.
- **Reply-only is not a blocker for the fleet:** our org has `send_to_primitive_managed_domains`,
  so RFQs to `*.primitive.email` seller addresses are allowed today. Only arbitrary external
  addresses are restricted (matters for real `discover` results, not the demo).
- **x402:** still `feature_disabled` on our org. The plan says to email
  `dev@agent.primitive.dev` from **both** orgs for `x402_payments` (+ `interactions_enabled`,
  which we already have). Stripe fallback decision at **2 PM**; no Stripe test key is configured yet.
- Versions: mcp-use 2.10.0 and Primitive SDK 2.4.0 are the latest published.

## My build order after the contracts hour (CLAUDE.md §8 items 4–18)

1. 11:30 — `packages/engine` skeleton consuming frozen `contracts.ts`; move Pass 1 logic in;
   40 tests stay green (paths change, assertions don't).
2. Item 4 — all 8 tools registered with real schemas and `next` hints, backed by the brain stub
   / engine; deploy a Manufact preview; connect Claude Code.
3. Item 5 — `100_engine_*.sql` re-cut + `verify-migrations.sh`; apply to hosted Supabase.
4. Items 6–7 — `deal` (job inbox, RFQ text + `rfq.json`, idempotency keys), `POST /inbound`
   (signature verify, dedupe, match to job + business), long-poll fallback.
5. Items 8–10 — parser (quote.json deterministic; text/PDF via Claude structured output with the
   workspace header), `learnFromReply` after each parse, `wait_for_update`, `get_quotes`.
6. **GATE 2 PM** — cold deal end to end in Claude Code against the 6 live sellers.
7. Items 11–16 — follow-ups, question routing, negotiation with `negotiationHints` + real
   competing quotes only, brain-backed tools, `approve` (elicitation → verified email
   fallback), `pay` (gate checks → `payEmailChallenge` → in-thread reply → receipt; Stripe if
   no x402).
8. Item 17 — deal board view. **GATE 8 PM**. Item 18 — errors, Skill, `llms.txt`, publish checks.

## Needed from you before / at 10:30

- Commit (or tell me to commit) the updated `CLAUDE.md`; it's currently an uncommitted change.
- Email `dev@agent.primitive.dev` for x402 from the buyer org (and Partner from the seller org).
- Create the shared GitHub repo and add Partner (needed for Manufact GitHub deploys and merges).
- Optional: Stripe test-mode secret key for the 2 PM fallback.
