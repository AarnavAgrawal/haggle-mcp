# Kickoff baseline, quote-broker parity, team handoff

Verified 2026-10-17 09:25–09:30 PDT on a fresh look at the checkout (earlier reports weren't
trusted). Local clock was 09:25 while the recorded schedule says hacking begins at 10:30; the
user declared the event started, and this pass stayed in Yash's lane either way.

## A. Git status

- Branch `yash/integrate-quote-broker` @ `0d647e0`, based on `yash/buyer-foundation` @ `93e2fc2`.
  Linear history, no merges, no conflicts.
- Uncommitted: **root `CLAUDE.md` only** (Yash's v3 rewrite, +166/−21, shared file). Preserved, not staged.
- `main` = `3dce56d` (init commit only). **No contract has been merged.**
- Remote `origin` = `github.com/yashnil/haggle` (private, Yash ADMIN). Remote has **only**
  `yash/buyer-foundation` @ `2a5909f`; no `main`; default branch = `yash/buyer-foundation`;
  partner isn't a collaborator. Local is 10+ commits ahead. Nothing pushed by me.
- Integration commits present: `1d68f7c 8ae9f8c 02bc8ac 1a327d1 8953454 9810474`, plus this
  session's `65362ed e0d8724 0d647e0`.
- Secrets: full-history scan (all commits, all branches) found 0 real-secret patterns and 0 of
  the 7 real `.env` values; only `.env.example` was ever committed. The only `whsec_` string is the
  test constant `whsec_test_secret`.
- Source `quote-broker-main`: unmodified (no file newer than its original timestamp).
- **`~/.git`:** an empty repo (0 commits, 0 tracked files, 848 KB, remote
  `yashnil/agent-university`, branch `master`). Any `git` command run outside a project under `~`
  silently uses it. Safe, reversible fix (not done):
  `mv ~/.git ~/.git.accidental-20261017` (restore with `mv` back if it turns out to matter).

## B. Parity matrix (quote-broker → Haggle, honest)

Legend: **WORKING** = runs in Haggle end to end today; **IMPLEMENTED, NOT INTEGRATED** = code + unit
tests in `packages/engine`, not wired into a running workflow; **MISSING**; **OUT OF SCOPE (v3)**;
**BLOCKED** (external).

| # | Workflow capability | quote-broker | Haggle today |
|---|---|---|---|
| 1 | Create a procurement job (tool + persistence) | yes (`create_quote_request`, Supabase) | **MISSING**: no tools, no engine schema (waits for contract) |
| 2 | Contact sellers by email | yes (global From) | **IMPLEMENTED, NOT INTEGRATED**: `outbound/primitiveSender.ts` (per-job From, idempotency, pinned-recipient replies), `outbound/rfq.ts`; no job driver calls it; `rfq.json` waits for D8 |
| 3 | Receive and match replies securely | yes (webhook + matcher) | **IMPLEMENTED, NOT INTEGRATED**: `inbound/primitive.ts` (signature, endpoint pin, strict From, `senderTrust`), `inbound/matching.ts` (job inbox, quarantine); no `/inbound` route, no persistence, no long-poll loop |
| 4 | Extract quotes incl. PDFs | yes | **IMPLEMENTED, NOT INTEGRATED**: `parsing/*` (Claude structured output, PDFs, exact cents, sourced figures); real model call NOT exercised; `quote.json` deterministic path MISSING (D8) |
| 5 | Reject non-compliant / suspicious offers | partial (dietary bool) | **IMPLEMENTED, NOT INTEGRATED**: requirements with counts, flags, `rankQuotes` rejections |
| 6 | Negotiate with real evidence | yes (1 round, per-head) | **IMPLEMENTED, NOT INTEGRATED**: totals, basis quote id, round cap, shared eligibility with ranking (scam-citation bug fixed this pass) |
| 7 | Route seller questions / follow-ups | no (questions not modelled; follow-ups via tick) | **MISSING** as workflow (`answer_seller` tool D1, follow-up autopilot); questions are extracted + flagged |
| 8 | Select a compliant winner | yes (`pickBest`) | **IMPLEMENTED, NOT INTEGRATED** (`rankQuotes`) |
| 9 | Authenticated human approval | yes (email APPROVE code) | **IMPLEMENTED, NOT INTEGRATED**: `verifyApproval` + `senderTrust`; elicitation MISSING |
| 10 | Safe test payment | yes (Stripe test) | **IMPLEMENTED, NOT INTEGRATED**: x402 guard + challenge parse + local signed step; send/receipt/persistence MISSING; real settlement **BLOCKED** (no `x402_payments`, 0 test USDC). Stripe fallback MISSING (no key) |
| 11 | Show progress/results to an MCP client | yes (tools + quote-board view + /live) | **MISSING**: server answers `initialize` + `/health` with zero tools (template demo tools removed this pass) |
| — | Seven agent tools | yes | **MISSING** (v3: nine tools, D1) |
| — | Read-only live page `/live` | yes | **MISSING** (reference only; optional after 2 PM) |
| — | OAuth public mode | yes | **OUT OF SCOPE (v3)** |
| — | Four-restaurant simulator | yes | **Partner lane** (`apps/sellers`, six v3 personas); not in this repo yet |
| — | Eval harness | yes | **Partner lane** (`apps/bench`, Manufact suites) |
| — | Business learning, warm `ask`, `check_price`, `discover` | no | **MISSING** (Partner's `packages/brain`; engine calls through `contracts.ts`) |

**Verdict: Haggle does not have quote-broker parity.** It has stronger, tested building blocks
for 2–6, 8–10, but none of the 11 workflow steps runs end to end in Haggle today.

## C. Completed fixes (this pass)

| Commit | Change | Tests |
|---|---|---|
| `65362ed` | `apps/mcp`: removed scaffold `show-app` / `say-hello` tools and `my-view` (they were visible to agents); server named Haggle; depends on `@haggle/engine`; zod aligned. Verified over real MCP `initialize` + `/health` on `mcp-use start` | typecheck + build |
| `e0d8724` | `outbound/primitiveSender.ts` (from quote-broker `email.ts`): per-job From, mandatory deterministic idempotency keys, inline JSON parts, **in-thread replies to the pinned address with explicit threading**. The SDK's `reply()` and quote-broker's `replyToEmail` address Reply-To first, which seller content controls. `payments/x402Challenge.ts`: SDK `parseEmailChallengeFromPart`, guard before `payEmailChallenge`; verified the real SDK builds the step with a `fetch` that throws (no network); nothing sent or settled | +8 |
| `0d647e0` | **Safety bug fixed:** `planCounteroffers` would have cited QuickQuote Deli's $700 scam quote (compliant + authenticated, but with an external payment link) to Bay and Harbor. Negotiation now uses the ranker's `rejectReason`. New `goldenChain.test.ts` runs six signed webhook replies through every engine module | +8 |

## Verification layers (kept separate on purpose)

| Layer | Status | Evidence |
|---|---|---|
| Pure unit tests | **154 pass** (core 40, engine 114 in 12 files) | `corepack pnpm test` |
| Module-chain integration (local, fakes) | **Pass** | `goldenChain.test.ts`: real SDK signature/trust/x402 parse + build, fixed LLM output, no DB, no job driver, no tools |
| Integrated local E2E (job → tools → DB → email fake → board) | **Not possible yet** | no schema, driver or tools until the contract freezes |
| External services | Read-only checks only | preflight (Primitive auth/domain/outbound, Anthropic Models API, Supabase read-only, Manufact login). No email sent, no LLM generation, no DB write, no deploy |
| Real MCP client | `initialize` over HTTP only | zero tools registered; no Claude/ChatGPT session |

## D. Outstanding blockers

**First real cold deal:** contract freeze → `100_engine` migration + repository → job driver → `/inbound`
+ long-poll → `deal` / `wait_for_update` / `get_quotes` → Manufact preview + Primitive webhook endpoint →
Partner's six live seller addresses. Plus one approved live round trip (below).

**Warm ask:** Partner's brain stub (11:30) then real `learnFromReply` / `estimate`; engine must call
`learnFromReply` after each parse; `ask` tool.

**Safe test payment:** `x402_payments` entitlement (both orgs), ≥ 5 test USDC in `0x81E8…2AB9`, Bay
Catering's `createEmailChallenge` (Partner item 29), engine payer send + receipt processing. Or, by
2 PM, a Stripe `sk_test_` key and a Stripe path behind the same approval gate.

## Live tests that need your approval (exact commands + safety conditions)

| Test | Command | Safety |
|---|---|---|
| Primitive round trip (1 email) | `SPIKE_TO=<inbox you own> SPIKE_CONFIRM_RECIPIENT_IS_MINE=yes corepack pnpm --filter @haggle/spikes primitive-roundtrip` | one email to your own address; reply manually |
| Claude extraction on a real PDF | (script to add after freeze) `parseReply` on `fixtures/buyer/attachments/golden-gate-quote-hidden-deposit.pdf` with `ANTHROPIC_MODEL` | ~1–2 cents; no seller contact |
| Hosted DB migration | `PGURL="$(node --env-file=.env -p process.env.SUPABASE_DB_URL)" docker run --rm -i -e PGURL postgres:17-alpine sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 -q' < supabase/migrations/100_engine_core.sql` | only after `100_engine_core.sql` exists and passes `verify-migrations.sh` |
| Manufact preview | `cd apps/mcp && ./node_modules/.bin/mcp-use deploy --root-dir apps/mcp --branch yash/engine` | needs `git push` first (GitHub mode); preview branch only |
| Webhook endpoint | create in Primitive → `https://<preview>/inbound`, then set `PRIMITIVE_WEBHOOK_ENDPOINT_ID` | 1 endpoint allowed per org |

## E. Decisions to make together (10:30)

1. **Contract** (`docs/v3-contract-freeze-proposal.md` D1–D12), especially: `answer_seller(job_id,
   question_id, answer)`; `ParsedReply.items` discriminated union and `ReplyMeta` (incl.
   `sender_trusted` + reason, `rfq_sent_at`); `Quote.total_usd` (all-in) vs `deposit_usd` (part of
   total, paid now); `PaymentStatus` incl. `awaiting_invoice`; the five brain signatures; email parts
   `rfq/1`, `quote/1`, `counter/1`, `accept/1`; deterministic `business_id`.
2. **Migrations:** `100_engine_*` (Yash) / `2xx_brain_*` (Partner); no FK from engine to brain; brain
   never alters engine tables; who owns `businesses` rows for agent-supplied emails (D5).
3. **Seller fleet:** separate Primitive agent inboxes (quote-broker's `sim/`) vs one Function on the
   seller org (v3). Six personas and the PROPOSED numbers (Harbor $1,120 / $300 deposit p.2 / ~10% off;
   Mission $1,070; Golden Grill $860 with 6 veg; Sunset $1,180 after plates; QuickQuote $700 + link).
   Bay must emit `quote.json` and issue the 5 USDC x402 challenge after `accept.json`.
4. **Brain:** stub by 11:30 returning fixed data for all five functions; `learnFromReply` inputs are
   the engine's validated record mapped to `ParsedReply`.
5. **Benchmark:** Manufact suites task text (v3 p.10) must mention `answer_seller` if D1 passes.
6. **Reuse permission** for quote-broker code (no LICENSE file).
7. **GitHub:** push `main`, set default branch `main`, invite Partner, and agree that `main` only takes
   merges at gates.

## F. Next parallel tasks (non-overlapping)

**By 2 PM gate**

| Yash (`packages/engine`, `apps/mcp`, `supabase/migrations/1xx_engine_*`) | Partner (`packages/brain`, `apps/sellers`, `apps/bench`, `fixtures/`, `2xx_brain_*`) |
|---|---|
| Write `contracts.ts` from the agreed proposal (Partner reviews) → merge to `main` | Review/approve contract; brain stub (5 functions, fixed data) |
| `100_engine_core.sql` + `verify-migrations.sh` assertions | `2xx_brain_core.sql` (businesses, profiles, price_observations) |
| Repository (Postgres + in-memory), job driver (CAS + after-commit effects) | Seller fleet: six personas live on `*.primitive.email`, fast-delay flag |
| `POST /inbound` + long-poll → `ingestInbound`; parse worker → `learnFromReply` | Real reply fixtures (text, PDF p.2 deposit, `quote.json`) into `fixtures/` |
| `deal`, `wait_for_update`, `get_quotes` tools; preview deploy; webhook endpoint | Hand Yash the six live addresses |

**By 8 PM gate**

| Yash | Partner |
|---|---|
| `answer_seller`, counteroffer effect, follow-up autopilot | Real `learnFromReply`, `estimate`, `checkPrice` |
| `approve` (elicitation + email via `verifyApproval`), `accept.json` | `negotiationHints`, `discover` (fleet first) |
| x402 payer: challenge → guard → sign → in-thread send → receipt (or Stripe test) | Bay Catering `createEmailChallenge` 5 USDC on `accept.json` |
| Deal board view (from quote-board); `ask` / `discover` / `check_price` wiring | `business://` resource data; Manufact suites, baseline server |

## G. Readiness verdict

| Milestone | Verdict | Evidence |
|---|---|---|
| CODE CLEAN | **YES** | typecheck clean, 154 tests, build, migrations, no secrets in history; only your `CLAUDE.md` uncommitted |
| CONTRACT READY | **NO** | proposal only; `packages/core/contracts.ts` doesn't exist and isn't approved |
| LOCAL E2E READY | **NO** | module-chain test passes, but there is no job, persistence or tool workflow |
| LIVE EMAIL READY | **NO** | read-only checks pass; no send, no webhook endpoint, no deployed `/inbound` |
| MCP CLIENT READY | **NO** | `initialize` works; zero tools |
| PAYMENT READY | **NO** | guard + local step building tested; x402 entitlement and test USDC missing; no Stripe key |
| QUOTE-BROKER PARITY ACHIEVED | **NO** | see §B |
