# Haggle rc1 acceptance matrix (Agent E, independent)

Build: `release/rc1` @ aa688b7, run 2026-10-18 in an isolated worktree. Nothing hosted, no Inkbox, no Stripe, no
vendor and no production database was touched. Real-provider calls were Anthropic only.

**Evidence levels.**
- **SIM**: simulated. Mock server or unit/e2e tests; memory or a throwaway Postgres 17 with every migration applied.
- **REAL-LLM**: real provider. Real Anthropic model; the vendors stay simulated.
- **HOSTED-RO**: read-only on the hosted server.
- **PROD-DB**: production persisted.
- **LIVE-COMMS**: live comms witnessed.
- **LIVE-CONCESSION**: live concession witnessed.
- **STRIPE-TEST**: Stripe test charge witnessed.

Agent E produced SIM and REAL-LLM evidence only. Higher levels are claimed in `docs/traceability.md` and are
marked *(claimed, not re-verified)*.

**Status.**
- **PASS**: all checks in this run passed.
- **FAIL**: a product defect, pinned by a test (see "Defects").
- **PARTIAL**: some checks pass, and the rest fail or are not covered.
- **BLOCKED**: needs a person, a credential or an authorization.

## Matrix

| # | Check | How verified (command / test) | Evidence | Status |
|---|---|---|---|---|
| 1 | One sentence with no vendors or budget ("I need catering for 50 people in San Francisco next Saturday. Find me the best deal.") → one `deal` call, nothing invented, new job | `local-journey.mjs`, chat 1 (3 runs: memory ×2, Postgres ×1); `acceptance.release` "one-sentence request"; `journey.e2e` | REAL-LLM + SIM | PASS (qty 50, next Saturday, no budget, time, requirements or vendors in 3/3 runs). Cosmetic: text says "budget ?." (D5) |
| 2 | Google Places discovery: "Google Maps" attribution, availability unknown, found ≠ authorized | `discovery.e2e.test.ts` (recorded Places fixture), `discovery.test.ts`, `businesses.test.ts` | SIM | PASS. Live: BLOCKED (no `GOOGLE_PLACES_API_KEY`, *claimed*) |
| 3 | Demo routing and authorization: names resolve server-side; unknown, ambiguous or not-ready names start nothing; allowlist | `journey.e2e` (named vendors), `vendors.test.ts`, `agent-scenarios.mjs` 7/7 (real Claude, local mock, dry_run forced) | REAL-LLM + SIM | PASS |
| 3b | Category gate: demo caterers aren't contacted for non-catering work | `acceptance.release` "non-catering …" (plumbing passes; 3 food-adjacent phrasings fail) | SIM | **FAIL** (D2) |
| 4 | Real Anthropic extraction schema compatibility (two-schema split under the grammar limit) | `npx tsx scripts/acceptance/extract-eval.mts apps/mcp/.env`: 3 live reply formats | REAL-LLM | PASS 3/3 |
| 5 | Clear, vague, approximate, malformed and partial offers | `extract-eval.mts` adversarial set, 8/8 through the engine pipeline (parse → safety filters → `validateQuote`): per-person → labelled computed $1,460; two options → null + question; refusal → available=false; question only → no total, `question_pending`; injection + pay link → both flagged, $500 not a total; all-caps/garbled → $1,350/$300; "+ tax" → `tax_excluded`, no tax invented; "50% deposit" → $700; every stated figure's excerpt is in the reply. Also `parseReply`/`validate`/`liveReplies` tests | REAL-LLM + SIM | PASS 8/8 (notes O1–O3) |
| 6 | Quotes created from async inbound with no buyer tool call | Live path: `channels.webhook.test.ts` (signed webhook → ingest → `advanceJob`), `webhook.test.ts`. Mock: the simulator is pull-driven; with no poll, `list_deals` stays at 1/6 quotes after 6 s (O5) | SIM | PASS (live path, with fakes). LIVE-COMMS *claimed* (job_dec51a…) |
| 7 | Grounded negotiation: counters cite only real quotes, never an unstated target | `acceptance.release` (every counter's cited `q_…` exists on the job; no "target" without a budget; vendor_revised totals drop); `strategy-eval.mts` 4/4; `counteroffer.test.ts` | REAL-LLM + SIM | PASS. LIVE-CONCESSION: BLOCKED / not witnessed |
| 8 | A higher-value winner above the budget (target vs hard limit) | `valueRanking.test.ts` ("more expensive, well-reviewed … beats a cheaper, vague one"); `quoteIntegrity.test.ts` (hard limit vs target); `strategy-eval` "promising above-budget vendor is pursued" | REAL-LLM + SIM | PASS |
| 9 | No-budget behaviour: none assumed or claimed to vendors; spending cap separate | `acceptance.release` + `local-journey` (budget null; counters cite quotes only; warning text) | REAL-LLM + SIM | PASS |
| 9b | The recommended quote is actually approvable / the next hint is truthful | `acceptance.release` "the recommended quote can be approved" | SIM | **FAIL** (D1) |
| 10 | Refusal, silence, deadline | `roughDeal.test.ts` (finishes on deadline; no substitutes; nothing invented); `extract-eval` refusal | REAL-LLM + SIM | PASS |
| 11 | Revisions, fees, deposits (all-in gate, hidden deposit, fee merge) | `quoteIntegrity.test.ts`, `approvalCaveats.test.ts`; `extract-eval` tax/percent; `acceptance.release` vendor_revised | REAL-LLM + SIM | PASS |
| 12 | Approval invalidation and quote-version binding | `acceptance.release`: superseded round-1 quote → `quote_not_eligible: not_current`; pay without approval → `no_approval`; injected quote unapprovable; second approval while one is open refused. `quoteIntegrity`/`stripe.test` (a revision voids the approval) | SIM | PASS |
| 13 | Stripe test-only controls, idempotency, receipt | `stripe.test.ts` (test mode only), `paymentSafety.test.ts` (5 concurrent → 1 charge); `acceptance.release` (3 pays incl. 2 concurrent → one intent id; no receipt link for a simulated charge; paid job refuses a second quote) | SIM | PASS. STRIPE-TEST charge: BLOCKED (fresh human approval + Pay, *claimed*) |
| 14 | Job isolation (no unrelated board) | `acceptance.release`: `get_quotes()` without an id → `job_id_required`, no board; deal board = the new job; paying one job leaves the other untouched. `local-journey` chat 2: 3/3 runs also opened the seeded 200-person deal to disambiguate "my catering order" (it never presented it as this order) | REAL-LLM + SIM | PARTIAL (O4) |
| 15 | Fresh-chat resumption and learned memory | `local-journey` chat 2: list_deals → get_quotes(new job), recommendation and total reported truthfully, 3/3 runs; `simJourney.e2e` on Postgres (2 restarts, warm `ask` estimate) via `release-pg.sh` | REAL-LLM + SIM | PASS (see O4 for ordering). PROD-DB memory *claimed* |
| 15b | Model-visible text attributes quotes to the right business | `acceptance.release` "model-visible text names the business …"; `local-journey` chat 1 traces | REAL-LLM + SIM | **FAIL** (D3) |
| 16 | Non-catering requests | `acceptance.release` (plumbing → `no_vendors_for_category`, no job); `generalPurpose.test.ts` (licensed roofer wins); agent-scenarios "real-world-plumber" | REAL-LLM + SIM | PARTIAL (D2) |
| 17 | Embedded app rendering (board, approval card, launcher) | `views.test.ts` (schema conformance), built view bundle (`mcp-use build` lists 7 views) | SIM | PARTIAL: schema only. Not visually re-checked by Agent E; screenshots in `docs/screenshots` *claimed* |
| 18 | Production DB schema compatibility (rounds, states, channels, payments) | `release-pg.sh`: PG17 + all migrations; release + sim journeys pass. Manual diff of engine unions (`store/types.ts`) against SQL check lists: business status, message kind, approval channel, payment status/rail and `max_rounds` 1–2 / `round` 1–3 all match; `liveRounds.test.ts` | SIM (migration replica) | PASS for the migrations; the live schema wasn't read (O6) |
| 19 | Fresh real-Claude MCP interaction | `agent-scenarios.mjs` 7/7; `local-journey.mjs` 17/18 ×3; never attempted approve/pay | REAL-LLM | PASS (except 14/15b) |

**Counts** (22 rows).
- **By status:** PASS 16, PARTIAL 3, FAIL 3, BLOCKED 0 as the primary status. Live sub-items are BLOCKED or claimed in rows 2, 7 and 13.
- **By evidence:** SIM-only 8; REAL-LLM + SIM 12; REAL-LLM only 2. Agent E produced no HOSTED-RO, PROD-DB, LIVE-COMMS, LIVE-CONCESSION or STRIPE-TEST evidence.

## Defects (D1–D3, D5 pinned by `defect(...)` in `apps/mcp/tests/acceptance.release.test.ts`; `ACCEPTANCE_STRICT=1` makes them fail)

- **D1 (P1) The recommended quote can't be approved, but the board says to approve it.**
  - Repro: the one-sentence request, with no budget, on the mock server.
  - The recommendation is Golden Grill at $860 with no deposit, so the payment would be the full $860. That is over the $500 per-payment ceiling.
  - `approve` returns `over_cap`, yet `get_quotes.next` says "approve(job_id, quote_id) for the recommended quote".
  - Code: `packages/engine/src/workflow/engine.ts:1712` (`nextHint`). Ranking and recommendation ignore the ceiling enforced at `engine.ts:1940`.
  - Real Claude told the user "You can also go ahead with Golden Grill now. I'd request your approval".
- **D2 (P2) Non-catering work that mentions food contacts the demo caterers.**
  - These requests all route to the 6 caterers:
    - "post-event cleaning crew for our catered dinner"
    - "repair of a commercial pizza oven"
    - "photographer for a dinner party"
  - Code: `apps/mcp/src/businesses.ts:17`. The `CATEGORIES` list is checked in order, the first match wins, and catering is first.
- **D3 (P2) The text the model sees doesn't say whose quote is whose.**
  - `wait_for_update` renders `quote q_…: $1,070 (round 1)` with no business name (`apps/mcp/index.ts:315`).
  - `get_quotes` text names only the best quote (`index.ts:89`).
  - Real Claude reported "Harbor Table $1,070" (that was Mission Eats). It also wrote "Bay Catering $1,070 or $1,120 … my update feed didn't label which is which".
- **D4 (P3) After payment, an approve attempt gets a misleading fix: "Wait until quotes are in."**
  - Code: `engine.ts` `requestApproval`, the `not_approvable` fix for terminal states.
- **D5 (P3) The `deal` text for a no-budget request ends "budget ?."**
  - Code: `apps/mcp/index.ts` deal summary, `usd(null)`.

## Observations (not failures)

- **O1** "$28 per person, delivery $60": the model set `headcount: 50`, which came from the request, not the reply. The total is labelled "computed from stated price per head x headcount". It is accepted as all-in although tax is unstated, because only an explicit "plus tax" blocks the all-in gate.
- **O2** "50% deposit" → $700, labelled `email body` rather than "computed".
- **O3** Two options ("$1,100 buffet or $1,450 plated"): both prices are dropped. The board keeps only the question, and Haggle has no field for options.
- **O4** `list_deals` puts open deals first and its text omits `created_at`. With two catering deals, Claude opened both and asked which one the user meant. After the newer deal is paid, `list_deals.next` points at the older open deal as "the most relevant".
- **O5** Mock mode only: the simulated vendors advance only when someone polls. A fresh chat's `list_deals` shows stale counts until `get_quotes` or `wait_for_update` runs. The live path is webhook-driven.
- **O6** Production schema drift wasn't checked against the live database. A read-only `information_schema` diff is the remaining step.
- **O7** The simulated vendors ignore headcount: Golden Grill quotes $860 for both 50 and 200 people. Real Claude noticed this ("check that its quote covers 200 people").

## How to rerun

```sh
npm ci --no-audit --no-fund && npm run build -w @haggle/mcp
node_modules/.bin/vitest run apps/mcp/tests/acceptance.release.test.ts          # memory
scripts/acceptance/release-pg.sh                                                # Postgres (port 55434)
npx tsx scripts/acceptance/extract-eval.mts apps/mcp/.env                       # real Anthropic
(cd apps/mcp && PORT=3712 HAGGLE_MODE=mock HAGGLE_SIM_DELAY_SCALE=0 ../../node_modules/.bin/mcp-use start) &
node scripts/acceptance/local-journey.mjs http://127.0.0.1:3712 apps/mcp/.env    # real Claude, local only
node scripts/acceptance/agent-scenarios.mjs http://127.0.0.1:3712 apps/mcp/.env
```
