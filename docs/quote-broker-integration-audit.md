# quote-broker integration audit

Audited 2026-10-17 09:11–09:30 PDT. Source: `/Users/yashnilmohanty/Desktop/quote-broker-main`
(read-only), upstream `https://github.com/AarnavAgrawal/quote-broker` **`8a68559`** (`main`,
from `git ls-remote`). The local folder isn't its own git repo (see Security), so `8a68559` is
the provenance SHA for every port. Nothing in the source folder was modified. Verification ran
on a copy in the session scratchpad (`.env*` excluded).

## 1. Source MVP architecture

A single-package mcp-use 2.10 server (Manufact), about 6.3k lines of TypeScript, with
`DESIGN.md` as its spec.

- **Tools (8):** `create_quote_request`, `wait_for_job` (DB long-poll, ≤ 50 s),
  `list_quotes` (+ `quote-board` view), `request_approval`, `pay`, `get_job`, `cancel_job`,
  `list_demo_vendors`.
- **Job engine:** a pure state machine (`collecting → negotiating → ready → awaiting_approval →
  approved → paid`, plus expired/cancelled/payment_failed). `advanceJob` applies due events
  with compare-and-swap on `jobs.version`. Effects run after commit, and every send is
  idempotent.
- **Email:** one global From address (`PRIMITIVE_FROM_ADDRESS`), `[QB-XXXX]` subject tags,
  `client.send` / `replyToEmail` with idempotency keys, a signed webhook at `/webhooks/primitive`,
  and a backup `/internal/tick`.
- **Parsing:** Claude structured outputs (`messages.parse` + `zodOutputFormat`) with no tools,
  PDFs as document blocks extracted from Primitive's attachment tar, and deterministic
  validation.
- **Negotiation:** one template round citing the best per-head price; competitors are never named.
- **Approval:** email `APPROVE <code>` from the registered approver, checked with `isTrustedSender`.
- **Payment:** Stripe **test mode** PaymentIntent (live keys refuse to boot), behind a pure guard.
- **Extras:** a read-only `/live` demo page, an OAuth "public mode" (Supabase OAuth server),
  a simulator fleet (`sim/`, 4 restaurants as Primitive agent inboxes), and an AX eval
  harness (`eval/`).
- **Persistence:** Supabase via `supabase-js` (`src/db/schema.sql`: jobs, vendors, messages,
  quotes, approvals, payments, job_events, webhook_events, app_users, sim_state).

## 2. Verification results (copy in scratchpad, `npm ci --ignore-scripts`)

| Check | Result |
|---|---|
| `vitest run` | **13 files, 144/144 passed** |
| `mcp-use typecheck` | no type errors |
| `mcp-use build` | built `index.ts` + `quote-board` view |
| Real Primitive / Anthropic / Supabase / Stripe calls | **Not exercised.** Running them would send email, write data or need the partner's credentials. NOT VERIFIED here |
| End-to-end on Manufact | NOT VERIFIED (README names `wild-cloud-utpra.run.mcp-use.com`; I didn't call it) |

The tests are unit and in-memory tests. They include an in-memory `advanceJob` lifecycle test
and signed-webhook safety tests through the real SDK signature check. **Passing them doesn't
prove the live loop works.** The partner's claim of a working end-to-end MVP is plausible
from code quality but wasn't independently demonstrated.

## 3. Feature-by-feature

| Feature | Implemented? | Evidence | Mock / assumption |
|---|---|---|---|
| Email send / reply | Yes | `src/channels/email.ts` (SDK `send`, `replyToEmail`, idempotency keys) | Message-ID looked up after send; attachment URL auth marked `TODO(verify)` |
| Inbound webhook | Yes | `src/webhooks/primitive.ts`, 222-line test | DB is an in-memory stand-in in tests |
| Thread matching | Yes | `src/channels/matching.ts` (thread → Message-ID → tag + sender) | Business matches by thread/Message-ID don't check From |
| Quote extraction | Yes | `src/parser/*` | LLM call is mocked in tests |
| PDF ingestion | Yes | `attachments.ts` (tar), document blocks | Real archive format from Primitive not exercised |
| Persistence | Yes | `src/db/queries.ts`, `schema.sql` | Only in-memory in tests |
| Seller interactions | Yes (sim) | `sim/*` | Simulated fleet; Claude phrases, code decides numbers |
| Negotiation | Yes (1 round) | `counteroffer.ts` | Per-head only |
| MCP tools | Yes | `src/tools/*`, `index.ts` | Tool set differs from v3 |
| Human approval | Yes (email) | `verifyApproval.ts` + webhook | No elicitation |
| Payment | Yes (Stripe test) | `payments/*` | No x402 |
| Deployment | Configured | README, `doctor.ts` | Not verified by me |

## 4. Component classification

| Source path | What it does | v3 requirement | Decision | Destination / notes |
|---|---|---|---|---|
| `src/channels/matching.ts` | Pure inbound matcher | Inbound H, P0 | **ADAPT (done)** | `packages/engine/src/inbound/matching.ts`: per-job inbox routing; From-anchored business matches (quarantine on mismatch) |
| `src/parser/attachments.ts` | tar.gz → PDFs | PDF ingestion | **ADAPT (done)** | `engine/src/inbound/attachments.ts`: also JSON parts (`quote.json`, `interaction.json`) with size caps |
| `src/approvals/verifyApproval.ts` | Email approval verdict | Approval B | **REUSE DIRECTLY (done)** | `engine/src/approvals/verifyApproval.ts` |
| `src/parser/quoteSchema.ts`, `parseReply.ts`, `validate.ts` | LLM extraction + checks | Parsing, P0 | **ADAPT (done)** | `engine/src/parsing/*`: exact cents, sourced figures only, dietary counts, flags, requirement evaluator, injected client + workspace header |
| `src/negotiator/counteroffer.ts` | Honest template counter | Negotiation, P1 | **ADAPT (done)** | `engine/src/negotiation/counteroffer.ts`: totals, compliant + trusted basis only, basis quote id, round cap |
| `src/payments/guard.ts` | Pure payment gate | Payment G | **ADAPT (done)** | `engine/src/payments/guard.ts`: x402 rules added |
| `src/webhooks/primitive.ts` (verify, map, trust) | Webhook edge | Inbound H | **ADAPT (done, pure part)** | `engine/src/inbound/primitive.ts`: strict From via `parseHeaderAddress`, one `senderTrust` verdict. Routing/DB half waits for the engine schema |
| `tests/fixtures/primitiveEvent.ts` | Signed event builder | Tests | **REUSE (done)** | `engine/tests/helpers/primitiveEvent.ts` (test code, not reply data) |
| `src/channels/outreach.ts` | RFQ text, AI disclosure | `deal` RFQ | **ADAPT (done)** | `engine/src/outbound/rfq.ts` (`rfq.json` part waits for contract D8) |
| `src/tools/best.ts` (`pickBest`) | Best-quote pick | Ranking | **ADAPT (done)** | `engine/src/ranking/rank.ts` with rejection reasons |
| `src/channels/email.ts` | Primitive send/reply | P0 | **ADAPT (next)** | Needs per-job From and the outbound ledger table; wait for `100_engine` schema |
| `src/jobs/advanceJob.ts`, `effects.ts` | CAS job driver, after-commit effects | Engine loop | **REFERENCE ONLY → re-implement** | The pattern is right (CAS + effects after commit + idempotent sends); states and tables differ from v3 |
| `src/jobs/stateMachine.ts` | Pure FSM | Job states | **REFERENCE ONLY** | v3 has 9 contract states (D7); reuse its "pure transition + effects" shape |
| `src/db/schema.sql`, `queries.ts` | Supabase schema/queries | Migrations C | **REFERENCE ONLY** | v3 `100_engine_*.sql` + Pass 1 DB invariants; `quotes_source_message_idx` and `approvals_one_pending_idx` ideas carried over |
| `src/tools/waitForJob.ts` | DB long-poll tool | `wait_for_update` | **REFERENCE ONLY** | Loop + advance-on-poll pattern for `wait_for_update` |
| `src/tools/*` (others), `index.ts` | 8 MCP tools | Tools A | **REFERENCE ONLY** | v3's 9 tools differ in names/inputs; error/`next` style worth copying |
| `views/quote-board/view.tsx` | MCP App table | Deal board | **REFERENCE ONLY** | Starting point for `views/deal-board` (Yash) |
| `src/live/*` | Read-only demo page | Demo | **REFERENCE ONLY** | Useful for the stage screen; port after the 2 PM gate if time allows |
| `src/payments/stripe.ts`, `customers.ts`, `tools/pay.ts` | Stripe test charge | Fallback rail | **REFERENCE ONLY (2 PM decision)** | Port behind `checkX402PaymentAllowed`'s sibling if x402 isn't granted |
| `src/webhooks/tick.ts` | Backup cron tick | Reliability | **REFERENCE ONLY** | Same idea for follow-up autopilot |
| `src/config.ts` | Env schema; live-Stripe refusal | Config | **REFERENCE ONLY** | Copy the "missing env → CONFIG_MISSING, live key → refuse boot" rule into apps/mcp |
| `scripts/doctor.ts` | Service preflight | Ops | **REFERENCE ONLY** | Haggle has `scripts/spikes/preflight.ts` |
| `src/oauth/*`, `src/caller.ts`, `src/tools/access.ts`, `listDemoVendors.ts` | OAuth public mode | Not in v3 | **DO NOT IMPORT (now)** | Scope; adds Supabase OAuth server config |
| `sim/*`, `scripts/createSimInboxes.ts`, `src/sim/hosted.ts` | Simulated fleet | `apps/sellers` | **DO NOT IMPORT (Partner lane)** | Partner ports into `apps/sellers` with the v3 personas |
| `eval/*` | AX eval harness | `apps/bench` | **DO NOT IMPORT (Partner lane)** | v3 uses Manufact test suites; reuse the task/expected-answer idea |
| `.agents/`, `.claude/`, `.cursor/` skills | mcp-apps-builder copies | — | **DO NOT IMPORT** | Haggle already has `skills-lock.json` for the same skill |

## 5. Incompatible implementations (v2/quote-broker vs v3)

- One global From address vs **per-job inbox** (v3 §Features 1).
- Per-head pricing and negotiation vs **order totals** with deposits (`Quote.total_usd`).
- `Math.round(usd*100)` vs exact cents (> 2 decimals rejected).
- Boolean dietary coverage vs **counts** (Golden Grill 6 of 12).
- Stripe-first vs **x402 over email** first (Stripe as the 2 PM fallback).
- No brain: the source has no learning, estimates, price checks or discovery (Partner's
  `packages/brain` in v3).
- No elicitation approval; email only.
- Its state machine and tool names don't match the proposed contract (D1, D7).

## 6. Security review

- **No tracked secrets** in the source (pattern scan for Primitive, Anthropic, Stripe,
  webhook, JWT, `sb_secret_` keys and private keys: 0 hits). No `.env` present. Haggle: 0 hits
  for any `.env` value across 108 tracked/untracked files.
- **Home directory is a git repo.** `git` in the source folder resolves to `~` (remote
  `yashnil/agent-university`), where `quote-broker-main` is untracked. A careless `git add` /
  push from Desktop could stage the home directory. Recommendation: never run git in
  `~/Desktop` outside a project; consider removing or moving `~/.git`.
- Source strengths kept: raw-body signature check, endpoint pinning, idempotent message
  inserts, `isTrustedSender` for approvers, quoted-text-proof approval parsing, an LLM with no
  tools, template counteroffers, live-key refusal.
- Source gaps fixed in the ports: business replies weren't anchored to the business address
  (now `quarantine: sender_mismatch` + `senderTrust`); From was regex-parsed (now
  `parseHeaderAddress`); money rounding (now exact); unsourced figures were accepted (now
  rejected).
- **License:** no LICENSE file. `package.json` says `"license": "MIT"`, `"author": "mcp-use"`,
  which is the scaffold default rather than a deliberate grant. The partner wrote the code, so
  **please get their explicit OK** to reuse it in Haggle (commit messages and file headers
  credit `AarnavAgrawal/quote-broker@8a68559`).

## 7. What remains to build (buyer lane)

After the contract freeze: `100_engine_*.sql`; the repository layer; `ingestInbound` (H)
using the ported matcher, trust and attachments; Primitive send/reply with per-job From and
the outbound ledger (adapt `email.ts`); the job driver (CAS + effects after commit, after the
source's `advanceJob`); `quote.json` deterministic parser (Pass 1 `quote-protocol.ts` → engine);
the 9 MCP tools; `wait_for_update` (after `waitForJob`); approval via elicitation + the ported
email verifier; the x402 payer (`parseEmailChallengeFromPart` → guard → `payEmailChallenge` →
in-thread reply → receipt); brain calls through `contracts.ts`; the deal board (after
`quote-board`); follow-up autopilot (after `tick`).
