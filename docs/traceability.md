# Haggle MVP: requirement traceability (calm-spark, 2026-10-18)

Deployed build: the commit that contains this file (`/mcp` reports `0.5.0+<sha>`; HAGGLE_BUILD_SHA). Rollback: the
previous deployment (850b399). Automated evidence for this release: 413 unit/e2e tests (+1 skipped), 261 on Postgres,
simulated purchase over MCP HTTP with restarts 1/1, real-Claude agent scenarios 7/7 against a mock server without a
Places key and 7/7 against one with the recorded discovery fixture (`scripts/acceptance/agent-scenarios.mjs`, deal forced
to dry_run), hosted read-only acceptance `scripts/acceptance/live-readonly.mjs` (no outreach, no charges).

Status key: **DONE** = built, tested, and seen working on the hosted server with real channels.
**BUILT, NOT LIVE** = built and tested (mock/Postgres/real-Claude), not yet witnessed live.
**BLOCKED** = code done; waiting on a person, an authorization or a credential. **NOT IMPLEMENTED** = no code.

## 00. P1 2026-10-18: real-world discovery and evidence synthesis

One contract for configured demo vendors and real discovered businesses: `discover` finds them, `business_profile`
explains them, `deal(businesses=['<name>' | '<business_ref>'])` selects them, and the same engine quotes,
negotiates, ranks, learns, approves and pays. Demo vendors are fixtures: category `catering`, never offered for
other work.

| Requirement | Implementation | Tests | Status / gap |
|---|---|---|---|
| Discover real businesses for any category without vendor names | `placesDiscover` / `placeDetails` (`packages/engine/src/reputation/places.ts`): stable `place:<id>` refs, dedupe (place id, phone, website, name), operational only | `discovery.test.ts`, `discovery.e2e.test.ts` | BUILT, NOT LIVE: needs `GOOGLE_PLACES_API_KEY` |
| Rank on evidence, not search order or bare stars | score = 0.6 relevance (service terms + area) + 0.3 volume-weighted rating (prior 4.0 over 20 reviews) + 0.1 reachability; `rank_reasons` | 5.0★/3 reviews and an irrelevant 4.9★ pizzeria rank below a 4.7★/318 plumber | BUILT, NOT LIVE |
| No key / provider failure is explicit; nothing substituted | `public_discovery.status`: `not_configured`, `key_rejected`, `rate_limited`, `unavailable`, `no_area`; a request outside the roster's category fails `no_vendors_for_category` | e2e (both servers) | DONE (not_configured verified on the hosted server) |
| Official website evidence | `websiteEvidence` (`reputation/website.ts`): robots.txt, public hosts only (no IP literals, localhost or private ranges, also after redirects), 4 s, 400 KB; extracts title, description, mailto/own-domain emails, tel links, advertised prices | `discovery.test.ts` (injection text never extracted) | BUILT, NOT LIVE (runs for businesses found via Places) |
| One evidence-grounded profile | `business_profile` evidence items `{kind, statement, source, observed_at, freshness, confidence, caveat}`, kinds `verified` / `third_party_listing` / `third_party_reputation` / `vendor_claim` / `inferred_estimate`, plus `unknowns` (availability, capacity, today's price) | `businesses.test.ts`, e2e | DONE for configured vendors; BUILT, NOT LIVE for discovered |
| Advertised price ≠ quote; reviews ≠ capacity; history ≠ guarantee | caveats on each item; `price_model` says "a claim, not a quote" | unit + e2e | DONE |
| Four contact states; found is not authorized | `contactStatus`: discovered → contact_found → authorized (allowlist + channel can send) → verified_responsive (replied before) | `businesses.test.ts`, e2e | DONE |
| Same selection contract; strict scoping; fail closed | `resolveSelection`: roster first, then recent discoveries (in memory 30 min) or `place:` ref re-fetched; unknown/ambiguous refuse; a real deal with any unreachable choice refuses (`not_authorized`, `no_contact_route`, `vendor_not_ready`); `dry_run` previews `would_contact` + `blocked` | e2e, real Claude | DONE (roster); BUILT, NOT LIVE (discovered) |
| Google terms | "Google Maps" attribution on results; Places content in memory only (discovery 30 min, reputation 1 h); only place ids in refs; nothing written to Supabase or the brain | review | DONE |
| Memory: Harbor Table under "Haggle Test Seller" | `engine.businessAliases`: Haggle's own job rows with the same contact **and** same normalized name link older ids; the brain adapter reads/extends that profile. No production data was changed | `brainObserved.test.ts`, `discovery.test.ts` (memory + Postgres), read-only live check: Harbor 1 quote, Mission Eats 4, Sunset 2 | DONE |
| Memory: older ids in channel learning | `contactLearning(id, aliases)` in deal routing, board and profiles | `discovery.test.ts` | DONE |
| Memory: mixed seed/real profiles | `observedOnly` drops menu, minimums, deposit/discount habits and flags (no row provenance), recomputes channels | `brainObserved.test.ts` | DONE |

**Blockers for real-world discovery in production:**
1. `GOOGLE_PLACES_API_KEY` (Places API (New) enabled).
2. **Authorization per business.** A discovered business is contacted only after the operator adds its contact to `HAGGLE_ALLOWED_RECIPIENTS`, once the business agrees.
3. **Voice AI to real numbers.** Calls currently go over Inkbox's shared iMessage line, which requires the callee to have connected. A real business's published phone can't be called until the buyer identity has its own Inkbox phone number.
4. **Email.** Email needs a published address (from the website) on the allowlist.

## 0. P0 2026-10-18: an agent couldn't buy from a named vendor

Claude.ai prompt: "drop-off catering for 25 people in San Francisco next week, 5 vegetarian, target $500 all-in.
Use Mission Eats ONLY…". Claude found Mission Eats (LIVE, phone) but couldn't start the deal.

**Root causes.**
1. `deal.businesses[]` items required `email`, `phone` or `a2a_card_url`. A configured vendor couldn't be named, `discover` masks phones, and `business_profile` said "pass this business with its contact". The only way to start without contacts was to omit `businesses`, which contacts the whole roster. Claude rightly refused that.
2. `business_profile("Mission Eats")` resolved to the seed-only `biz_mission_eats` (one synthetic Oct 11 $675 quote, 48%). Mission Eats' 4 real call quotes were under the contact-only id `biz_6c811a…` used before 0f1835f. The live brain also replayed seed samples and used them for estimates and price checks, and the seed directory could capture live identities by name.
3. A related stall: "next week" had no representation. The model either asked the user for a day or invented one (Wed 12:00 in testing).

| Requirement | Fix | Tests | Hosted evidence | Status / gap |
|---|---|---|---|---|
| Select a known vendor by name or stable ref; Haggle resolves the route | `businesses: ['Mission Eats']` (also `mission_eats`, slug, business id, legacy id) → `resolveVendors` (`apps/mcp/src/vendors.ts`) uses the configured contact and channel | `vendors.test.ts` (4 new), `journey.e2e.test.ts` (6 new) | live-readonly: dry run resolves exactly Mission Eats | DONE |
| Strict scoping: one, a subset or the roster; unknown, ambiguous or not-ready names start nothing; no expansion | resolution is all-or-nothing; `unknown_business` / `ambiguous_business` / `vendor_not_ready` with the question to ask; allowlist and sender trust unchanged | same, plus `deal refuses a business outside the allowlist` | real Claude: Golden Grill (not ready) → nothing contacted, no substitution; Taco Palace → unknown | DONE (ambiguity: unit-tested only; the hosted roster has no ambiguous names) |
| Prove who would be contacted without sending | `deal(dry_run: true)` → `would_contact` (no job, nothing sent) | e2e dry-run test | "dry runs started no deal" | DONE |
| One identity across discover → business_profile → deal | `business_ref` on discover and profile; profile resolves through the roster; `profileIdFor` reads and extends memory under the older contact-only id when the name matches | `brainObserved.test.ts` (identity), e2e | profile: Mission Eats 4 real quotes, 95% (was 1 seed sample, 48%) | DONE |
| Synthetic memory never presented as real | live brain `observed: true`: no seed replay, seed rows hidden, counts/prices recomputed from real quotes, seed directory not used for identity; mock keeps labelled samples | `brainObserved.test.ts` | live-readonly: profile has no seed rows; check_price sample 7 (was 16) | DONE |
| Tools usable from ordinary language | instructions + `deal`, `discover`, `business_profile`, `ask` and llms.txt hints say names are enough and never to ask for a known vendor's contact | metadata asserts in e2e | real Claude 6/6 scenarios on the hosted contract | DONE |
| "Next week" without stalling or inventing a day | `request.date_until`: email, call brief and iMessage say "any day Mon–Fri (flexible), which days work?"; reversed range refused | `callBrief.test.ts`, e2e | real Claude sends date + date_until, no time invented | DONE |
| iMessage RFQ keeps its reference code | truncation shortens the description, never `HG-code` | `callBrief.test.ts` | — | DONE |

**Related outstanding items.**
- **P1:** Harbor Table's one real quote (job_dec51a) sits in a brain profile labelled "Haggle Test Seller", the old HAGGLE_DEMO_FLEET name for the same mailbox. Name matching can't attach it to Harbor Table. Fixing it means relabelling one Supabase row, a production data write that needs approval.
- **P2:** per-channel contact learning (`learnContact`) reads messages by engine business id, so earlier jobs under contact-only ids aren't counted.
- **P2:** if a profile ever mixes seed and real rows, its menu and minimum still carry seed text. Its counts and prices are recomputed. No live profile is mixed today.

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
