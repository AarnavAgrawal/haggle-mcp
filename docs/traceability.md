# Haggle MVP: requirement traceability (calm-spark `0.5.0+ac3095a`, 2026-10-18)

Hosted: https://calm-spark-ck3qm.run.mcp-use.com/mcp (Manufact deployment `3ff49544`; rollback `047e0785` = c1d4516).
Automated evidence: 372 unit/e2e tests (+1 skipped), 253 on Postgres, simulated purchase over MCP HTTP with two
restarts (`scripts/acceptance/sim-journey.sh`) 1/1, real-Claude strategist eval 4/4
(`scripts/acceptance/strategy-eval.mts`), hosted read-only acceptance 26/26 (`scripts/acceptance/live-readonly.mjs`;
no outreach, 0 Stripe PaymentIntents, no new calls or texts).

Status key: **DONE** = built, tested, and seen working on the hosted server with real channels.
**BUILT, NOT LIVE** = built and tested (mock/Postgres/real-Claude), not yet witnessed live.
**BLOCKED** = code done; waiting on a person, an authorization or a credential. **NOT IMPLEMENTED** = no code.

## 1. Discovery, identity, channel routing and learning

| Requirement | Implementation | Tests | Hosted evidence | Status / gap |
|---|---|---|---|---|
| Discover the demo vendor roster with readiness | `apps/mcp/src/vendors.ts`, `discover` tool | `apps/mcp/tests/discovery.test.ts`, `vendors.test.ts` | live-readonly "discover reports the demo roster" (3/6 ready) | DONE |
| Public discovery of real businesses (found ≠ authorized) | `placesDiscover`/`resolveListings` (`packages/engine/src/reputation/places.ts`); `discover` returns `found` separately from the contactable roster | `valueRanking.test.ts` "public discovery" (dedupe, relevance, area, closed, no key → null) | `public_discovery: off (no GOOGLE_PLACES_API_KEY)` | BLOCKED: Google Places key. Contacting found businesses is unauthorized by design |
| Stable business identity (personas on one phone stay distinct; spelling variants merge) | `businessIdForContact(contact, name)`, `normalizeBusinessName` (`ids.ts`); adapter `sameName` | `identity.test.ts` | live job `job_dec51a…` three vendors, distinct memory | DONE |
| Channel routing (A2A → email → Voice AI; call when email is silent) | `engine.route`, `chooseChannel` | `channels.test.ts`, `workflow.e2e.test.ts` | email, Voice AI, RCS in `job_dec51a…` | DONE (A2A: BUILT, NOT LIVE; no same-org A2A vendor) |
| Learned contact preferences (stated preference > observed reply rate, min 2 samples) | `routing/channelStats.ts` `learnContact`/`chooseChannel`; `preferred_contact` extraction | `channelLearning.test.ts` (4 cases incl. "please text me instead") | `contact_learning` on the board | BUILT, NOT LIVE (needs ≥2 deals per vendor) |
| Recipient allowlist kept | live runtime `allowed_recipients` | live-readonly "deal refuses a business outside the allowlist" | 26/26 | DONE |

## 2. Negotiation intelligence, soft budget, best value

| Requirement | Implementation | Tests | Hosted evidence | Status / gap |
|---|---|---|---|---|
| Budget is a target by default; hard limit only when stated | `budget_is_hard_limit`, `targetCents`/`hardLimitCents`, `over_limit` | `quoteIntegrity.test.ts` "hard spending limit…"; `approvalCaveats.test.ts` | board shows over-target as a warning | DONE (config); see negotiation row |
| Counteroffers cite only real competing quotes or the buyer's target; ≤3 rounds | `planCounteroffers` (`basis: competing_quote | buyer_target`), `maxRounds: 3` | `counteroffer.test.ts`, `goldenChain.test.ts` | counters sent in the live demo flow (mock) | BUILT, NOT LIVE |
| Claude strategist decides who to pursue; can't invent figures | `claudeStrategist`, `applyStrategy`, `unsafeAsk` | `strategist.test.ts`; real Claude eval 4/4 | strategist wired in `live.ts` | BUILT, NOT LIVE |
| A real negotiated concession accepted live | same | sim journey: negotiated $1,150 → $995 | not yet witnessed | BLOCKED: needs a live vendor reply to a counter in the authorized demo |
| Phone vendor renegotiation | `callbackProposals`, `call_back` / `call_back_in_view` (one-time code, human only) | `strategist.test.ts`, live-readonly "call_back can't be authorized headless" | refused headless | BLOCKED: human authorization per callback |
| Best value, explained (price, reputation, reliability, completeness, terms; missing = neutral; demo vendors never rated) | `ranking/value.ts` `scoreQuotes` | `valueRanking.test.ts` (premium beats cheap, deposit tradeoff, determinism) | board "Best value (0.83): …" + factor list | DONE (reputation input BLOCKED on the Places key) |

## 3. Quote integrity, approval, Stripe sandbox

| Requirement | Implementation | Tests | Hosted evidence | Status / gap |
|---|---|---|---|---|
| All-in total gate (tax, fees, delivery when needed) | `allInKnown`, `all_in_unknown` reject | `quoteIntegrity.test.ts` | Sunset Kitchen $4,500 held until "+$250 delivery" | DONE |
| Confirm-once follow-up; merged clarifications; one quote per message | `dropUnstatedDietaryRefusals`, confirmation merge, DB unique constraint | `quoteIntegrity.test.ts`, `parseReply.test.ts` | RCS vegetarian unknown → confirmed | DONE |
| Revision voids approval; operator revoke | `onRevision` → `approval_void`; `revokeApproval` | `quoteIntegrity.test.ts` | ap_32e2d549… revoked, nothing charged | DONE |
| Human approval only (card, client form, iMessage YES+code) | `approve`, `approve_in_view`, `verifyApproval` | `verifyApproval.test.ts` (13 cases) | approval card tapped in Claude.ai; headless self-approve refused | DONE |
| Pay guard: approved quote, amount ≤ approved ≤ ceiling, payee quoted, unexpired | `payments/guard.ts` (expiry at the boundary instant) | `stripe.test.ts` (fixed clock), `guard.test.ts` | pay without approval refused | DONE |
| Exactly one charge under concurrency, retries and restarts | idempotency key per approval | `paymentSafety.test.ts` (5 concurrent → 1 charge; retry same key; restart same payment) | n/a | BUILT, NOT LIVE |
| Stripe sandbox charge + hosted receipt | Stripe test mode, `expand[]=latest_charge` → `receipt_url` | `stripe.test.ts`, sim journey (simulated, no receipt link) | test key + customer + card verified read-only; 0 PaymentIntents | BLOCKED: one charge needs a fresh human approval + Pay |

## 4. Asynchronous resumption and persistent memory

| Requirement | Implementation | Tests | Hosted evidence | Status / gap |
|---|---|---|---|---|
| Jobs outlive sessions and restarts; no duplicate outreach | Supabase Postgres repository, signed webhooks, `wait_for_update` cursor | `generalPurpose.test.ts` restart; sim journey (2 restarts) | `job_dec51a…` survived 8 deploys | DONE |
| Find deals without ids | `list_deals`, `get_quotes()` with no id | sim journey; live-readonly | 5 deals listed; most relevant opened | DONE |
| Learning → warm estimates | brain profiles in Supabase, `ask` (freshness note; seed-only hidden live) | sim journey (warm estimate after restart), `brainAdapter.test.ts` | `ask` returns 3 learned estimates; 9 profiles | DONE (estimate after a paid deal: BUILT, NOT LIVE) |

## 5. Security, category independence, embedded MCP App

| Requirement | Implementation | Tests | Hosted evidence | Status / gap |
|---|---|---|---|---|
| Messages/transcripts are data: injection and pay-links blocked | `prompt_injection`, `external_payment_link` rejects; call safety (`dropAgentOnlyAmounts`, `answeredSomething`) | `approvalCaveats.test.ts`, `callSafety.test.ts`, `validate.test.ts` | QuickQuote Deli "Can't win" | DONE (mock vendor) |
| Signed webhooks only | Inkbox signature verify | `webhook.test.ts` | unsigned + forged rejected (live) | DONE |
| Secrets never exposed | env on Manufact as secrets; scripts read `.env`, never print | review | n/a | DONE |
| Category independence (any goods/services, request's own units) | generalized extraction prompt, requirement answers | `generalPurpose.test.ts` (licensed roofer wins) | live demo is catering only | BUILT, NOT LIVE for a non-catering category |
| Embedded deal board (inline + fullscreen, light/dark, polling, stages, approval card) | `apps/mcp/views/*` | `views.test.ts`, screenshots | rendered + polled in Claude.ai; approval card tapped | DONE. Audit fix ac3095a: stage chip now says "Can't win" for a failed hard requirement (was "Final quote") |
| Payment/receipt state on the board after a real charge | board `payment.receipt_url` | sim journey | not yet | BLOCKED with the Stripe charge |
| Mentions, settings, launcher entrypoints | `server.mentions`, settings tools, `open_haggle` global+thread | `mcp.e2e.test.ts` | launcher entrypoints listed live | DONE (ChatGPT not re-checked this pass) |

## Summary

- **DONE:** demo discovery and readiness, identity, routing over email/Voice AI/RCS, the allowlist, the all-in gate, confirm-once and merges, approval voiding and revocation, human-only approval, payment guards, resumption and persistence, `list_deals`, learned estimates, injection and pay-link blocking, signed webhooks, the embedded board and approval card.
- **BUILT, NOT LIVE:** learned contact preferences, counteroffers and the Claude strategist, idempotent single charge under concurrency, A2A, non-catering categories, a warm estimate after a paid deal.
- **BLOCKED:**
  - an accepted live concession (needs the authorized demo with a vendor replying);
  - a phone callback (human authorization);
  - the Stripe sandbox charge and receipt (fresh approval + Pay);
  - public discovery and reputation (`GOOGLE_PLACES_API_KEY`);
  - three vendors still need same-org Inkbox identities (setup).
- **NOT IMPLEMENTED:** nothing in scope. Contacting publicly discovered real businesses is deliberately not authorized.

## Witnessed-demo checklist (one fresh Claude.ai purchase)

1. Yash and Aarnav confirm ready; the three routes are READY in `discover`; the deployed build is `0.5.0+ac3095a`.
2. A fresh Claude.ai chat makes the request; `deal` starts and the board renders inline.
3. Quotes arrive by email, Voice AI call and RCS; any confirming question is answered once.
4. A counter citing a real competing quote (or the target) is sent; the vendor's revised quote shows "Lowered their price".
5. Aarnav approves the current, fully updated quote on the approval card (not the old Sunset Kitchen approval).
6. Aarnav taps Pay: exactly one Stripe test PaymentIntent, and the receipt link appears on the board.
7. A new chat calls `ask` for the same order and gets a labelled warm estimate.
8. Keep: the job id, board screenshots, the PaymentIntent id, the `ask` output; re-run `live-readonly.mjs`.
