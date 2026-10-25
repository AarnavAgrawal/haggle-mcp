# Production readiness checklist

Next-steps reference for taking Haggle from hackathon release candidate to production and YC readiness. Tick items as they are done and verified (CLAUDE.md section 10). Day-to-day task tracking still lives in `CHECKLIST.md`.

**Stack corrections vs. the original list.** The source list came from an older plan, so these items are rewritten for v5:
- Email is **Inkbox**, not Primitive (section 1).
- Payment is **Stripe test mode**, not Base Sepolia x402 (section 6).
- The MCP surface has more than eight tools: `ask`, `discover`, `check_price`, `deal`, `wait_for_update`, `get_quotes`, `answer_business`, `approve`, `pay`, `business_profile`, `open_haggle`, `list_deals`, `call_back`, `settings_read`/`settings_update` (section 2).
- Channels are email, Voice AI phone calls, iMessage and A2A, all through Inkbox (section 3).

**Lane note.** Items touching `apps/mcp/views/**`, `packages/brain/`, `apps/sellers/`, `apps/bench/` and `fixtures/` are Aarnav's; `packages/core/*` changes need both people to agree (CLAUDE.md section 4).

## Progress

### Pass 1: production security (2026-10-21)

Branch `yashnil` (baseline `bd98cd1`), committed, **not pushed or deployed**, and no migration applied to any live database. Verified locally:
- typecheck: clean
- unit tests: 771 passed, 2 skipped
- Postgres 17 tests: 527 passed, migrations 100-105 applied
- SQL assertions: pass, including the new `engine_security_assertions.sql`

New regression suites:
- `packages/engine/tests/approvalSecurity.test.ts`
- `packages/engine/tests/recovery.test.ts`
- `packages/engine/tests/extractionSafety.test.ts`
- `apps/mcp/tests/security.e2e.test.ts` (HTTP, two authenticated workspaces plus a revoked one)
- policy and revocation cases in `apps/mcp/tests/workspace.test.ts`

Each new engine test was run and seen failing before its fix.

| Vulnerability (audit) | Before | After (verified by) |
| --- | --- | --- |
| Agent names its own email approver (`deal.approver_email`) | Accepted and stored on the job | Ignored with a warning; the job takes the workspace approver (approvalSecurity, security.e2e) |
| `settings_update` changes the approver or raises the cap | Allowed | `approver_change_requires_operator` / `cap_increase_requires_operator`; only `scripts/workspace-admin.ts` (DB access) can do it. Lowering the cap and setting the area stay self-service |
| `choose_in_view` → `approve_in_view` → `pay` with no human | Code returned in `_meta`; the e2e test did exactly this | Live (and mock with `HAGGLE_APPROVALS=out_of_band`): no code is ever returned. `approve_in_view`, form (elicitation) and simulated approvals are refused by the engine (`approval_needs_human_channel`). Only the approver's coded text approves |
| Email code approval on by default (spoofable From) | On | Off unless `HAGGLE_EMAIL_APPROVAL_BY_CODE=true`; not offered as an approval route when off |
| Workspace spending cap advisory only | Caveat; only the $5k server ceiling enforced | Payment ≤ min(server ceiling, workspace cap) at deal, approval and pay time (lowering the cap after approval blocks the charge) |
| Approval binding to terms | Quote id + amounts in the guard | Plus DB triggers: a quote is immutable apart from its status; an approval must name its own job's quote, business and total (migration 105) |
| Open auth by default; unauthenticated → `ws_default` | Open unless `HAGGLE_AUTH=required` | Live mode always requires a credential. Missing, unknown or revoked → 401. With an incomplete live config, everything but the handshake gets 503 |
| No credential revocation | None | `workspaces.revoked_at` (migration 105), `workspace-admin.ts revoke` / `rotate` |
| `HAGGLE_NOTIFY_PHONE` decides every workspace's approvals | Global override | The notify number serves only `ws_default`. Each workspace's texts, YES and PAY go to and from its own approver |
| Voice-agent prompt contains every tenant's jobs | Last 20 open jobs, all workspaces | Only the voice workspace's jobs (`HAGGLE_VOICE_WORKSPACE`, default `ws_default`) |
| Job stuck in `created` / `contacting` after a crash | Stuck forever | Recovered by the next advance after 2 minutes; idempotency keys prevent re-sends |
| Duplicate Voice AI calls (retry after an ambiguous 5xx, crash after dialing) | Possible | Inkbox port retries only explicit "not placed" refusals. Every dial is recorded before placing, and an attempt with an unknown outcome is never redialed |
| Claude outage → approvable keyword quote | Any error fell back to keywords | 429/5xx/timeouts are retried by the engine (bounded, then "couldn't read"). The keyword fallback only runs on refusal or no output, and its quotes are non-approvable and never cited in negotiation |
| No extraction timeout; failed details call silently dropped fees and tax | SDK default (10 min); defaults applied | 60 s timeout, 2 retries. A failed details call fails the read |

**Changed behaviour:**
- Live boards and approval cards can no longer approve with a tap. They show the approval as pending while the approver replies YES to the text.
- Mock or demo servers keep the old card, form and simulated flows (labelled DEMO) unless `HAGGLE_APPROVALS=out_of_band`.

**Still open after pass 1:**
- **High, shared resources needing Aarnav (not changed here):** brain profiles are shared across workspaces (no `workspace_id`; `ask`, `business_profile` and `check_price` mix tenants), and simulated quotes are learned as real.
- **Shared, server-wide (Yash's, still to do):**
  - One Inkbox buyer identity, mailbox and phone for every workspace.
  - One Stripe customer and card.
  - The vendor roster, recipient allowlist and `HAGGLE_ALLOW_ANY_RECIPIENT` are global.
  - The discovered-businesses cache is process-global.
  - `lastSms`, notify dedupe, held texts, reconciler state and callback codes are in memory.
- **Medium:**
  - ~~`call_back` still accepts the board or form authorization, so a model can relay a callback code and place a negotiation call (no money moves).~~ **Resolved** (`2adea66`, `e42d1b8`): on a live server (or with `HAGGLE_APPROVALS=out_of_band`) `call_back` only texts the approver a one-time code. Only their `CALL <code>` reply, the signed-in owner in the web app (`/internal/callbacks/authorize`) or an operator places the call, and `call_back_in_view` refuses with `callback_not_authorized`. Tested in `packages/engine/tests/security.test.ts` and `apps/mcp/tests/security.tenancy.e2e.test.ts`.
  - Resuming a `charging` payment row skips the guard (the Stripe idempotency key covers it).
  - No durable job lease: two replicas can still double-parse.
  - Real (non-Inkbox) vendor mail is still never trusted.
  - Stripe still charges the operator's own card (manual handoff not built).
  - No opt-out or bounce handling.
- **Not done:** no deploy, no live migration, no real-client (Claude/ChatGPT) check of the new approval UX.

**Needs Aarnav or a shared-contract decision:**
1. `apps/mcp/views/deal-board` and `views/approval` should show the live state ("approve by replying YES to Haggle's text") when no ticket comes back. Today they degrade to "Approval is pending."
2. Brain tenancy (`2xx` migration adding `workspace_id`, or aggregate-only sharing).
3. Skip learning from `meta.simulated` and keyword-fallback quotes.
4. Optionally add `unreliable_extraction` to `QUOTE_FLAGS` / view schemas in `packages/core`, so views can show it as a flag rather than only as the approval block reason.

### Pass 2: toward a real-vendor pilot (2026-10-21)

Branch `yashnil`, on top of pass 1 (`338ff69`). Committed, **not pushed or deployed**; migration 106 is applied only to throwaway test databases. No real vendor was contacted and no payment rail was called.

Verified locally:
- typecheck: clean
- unit tests: 789 passed
- Postgres 17 tests: 548 passed, including three two-connection "two instance" tests
- migrations 100-106 apply; SQL assertions pass (new `engine_pilot_assertions.sql`)

New suite: `packages/engine/tests/pilotSafety.test.ts` (in-memory plus Postgres). Its cases were run and seen failing before the fixes; the Postgres variant was added alongside.

**This is not production readiness.** All channel and payment evidence is from fakes and test databases. Nothing here has been exercised against real Gmail/Outlook mail, real Inkbox webhooks, or a live database.

| Area | Before | After (verified by) |
| --- | --- | --- |
| Real external email (Gmail, Outlook) | Never trusted; or, if anyone loosened it, From + thread would have been the only signal | `HAGGLE_EXTERNAL_SENDERS=reply_token` (off by default; needs `HAGGLE_REPLY_TOKEN_SECRET`, refuses to start without it). Every email to a business carries an HMAC reply token in its subject and body. A reply counts only with all four: From = the pinned address; In-Reply-To/References name Haggle's own outbound Message-ID; the token quoted back; no failing auth evidence. Anything else is quarantined as `identity_unverified` and never read. An aligned DMARC/DKIM pass would stand in for the token, but see the blocker below |
| Duplicate processing across instances | In-process lock only | Postgres `job_leases`: one advancing instance per job; a crashed holder's lease expires (5 min) |
| Duplicate sends after crashes | Idempotency key checked after sending | `outbox` claimed before every email, text (to a business or the human) and call. A fresh claim held by another instance → retry later. A stale claim is resent under the same provider key (email/text) |
| Voice retries | Pass 1 event markers | Outbox: a call that may have gone out (`pending`/`unknown`/`sent`) is never claimed again; the database trigger refuses it too. Only a definite "not placed" is retried |
| Payment | Stripe self-charge, or nothing; the vendor was told "payment sent" | `HAGGLE_PAYMENTS=manual` handoff, below |
| Resumed payments | A resumed `charging` row skipped the guard | Re-runs the full guard (approval, quote revision, amount, job, server and current workspace caps) before any resumed Stripe call or handoff confirmation |
| Opt-outs and bounces | Only synchronous provider errors | Opt-outs (email, or STOP by text) and hard bounces are recorded in global `vendor_suppressions`. Every send path and `deal()` refuse suppressed contacts. A bounce counts only if it names Haggle's own Message-ID, so a forged bounce is ignored. False-positive phrases are tested |
| Vendor authorization | One server-wide allowlist; `HAGGLE_ALLOW_ANY_RECIPIENT` | Per-workspace `workspace_vendors` with recorded consent, operator-added via `workspace-admin.ts add-vendor`; the agent can't add them. Workspace B can't contact A's vendor. Allow-any is ignored in live |

**The manual payment handoff:**
1. After the human approves, the business is asked how it takes payment. The message explicitly says Haggle never moves money.
2. `pay` returns the handoff state (rail `manual`) and charges nothing.
3. The business's reply is stored as untrusted instruction text: never parsed as a quote, never followed. If it contains a link, the human is warned.
4. Only the workspace approver's `PAID <code>` text completes it, after revalidation. The handoff becomes `human_confirmed` (final, enforced by a database trigger) and the job moves to `paid`.
5. The business is then told "the customer has told us they have paid … please check you received it". It is never told "payment sent".

**Blockers and remaining risks after pass 2:**
- **BLOCKED on Inkbox: provider-level sender authentication.**
  - Inkbox's SDK and webhooks expose no SPF/DKIM/DMARC results for mail from outside Inkbox (checked in `@inkbox/sdk` types: `MessageDetail`, `MailWebhookMessage`, `sender_access`).
  - The reply token proves possession of the email Haggle sent, the same strength as an email-verification link. It does not prove the sending server: someone with access to that mailbox, or a forwarded copy, could reply.
  - Ask Inkbox for Authentication-Results on inbound mail. `verifyExternalReply` already consumes them through the existing `AuthEvidence` shape.
- **Not live-verified:**
  - Whether real Gmail and Outlook replies keep the token (subject "Re:" keeps it; most clients quote the body).
  - Whether Inkbox's inbound `bodyText` includes quoted history.
  - Whether DSNs arrive at the buyer mailbox in the parsed shape.
  - These need one consenting real mailbox test before the pilot.
- **Manual handoff limits:**
  - Haggle records that the human reports paying; it never verifies money arrived.
  - No cancellation or refund flow for a handoff.
  - Vendor instructions are shown as text; the human must verify them independently.
- **Still open from pass 1, Yash's lane:**
  - One shared Inkbox identity and phone.
  - In-memory `lastSms` reply routing and held texts. Notify dedupe is now durable through the outbox.
  - ~~`call_back` still trusts a board or form authorization.~~ **Resolved** (`2adea66`, `e42d1b8`): see pass 1 "Medium" above.
  - Named lookup of workspace vendors: the agent must pass the vendor's contact; name-only resolution still uses the server roster.
- **Still open, Aarnav's lane:** the brain tenancy and simulated-learning items listed under pass 1.

**Changes needing Aarnav or a shared-contract decision:**
1. The views should show the handoff. The board's `payment` line already carries rail `manual` and statuses `awaiting_invoice` / `invoice_received` / `settled`, plus a reason. Useful additions: a "pay the business directly, then reply PAID <code>" state, and the business's instructions shown as untrusted text, with links not clickable.
2. Optional, in `packages/core`, both need to agree:
   - an approval status for the handoff (`awaiting_human_payment`), since today it maps to `approved`;
   - payment rail `manual` in the shared payment types;
   - `identity_unverified` as a visible quarantine reason.

### Pass 3: overnight sprint (2026-10-22)

Branch `yashnil`. Committed locally, **not pushed or deployed**. Migrations 108–111 are applied only to throwaway test databases. No real email, text, call or payment was sent. Full write-up: `docs/overnight-sprint-report.md`.

Verified on the fully merged tree:
- typecheck: clean
- unit tests: 1,059 passed (14 Postgres-gated skips)
- Postgres 17: 762 engine tests passed, plus 3 ledger tests
- migrations 100–106 and 108–111 apply, every SQL assertion passes, and 111 re-applies idempotently

**Observed on the live Inkbox account (read-only):**
- Mail goes out through Amazon SES, and the stored Message-IDs are the SES ids that replies reference.
- No message or webhook field carries SPF/DKIM/DMARC results; the only extra is `sender_access`.
- Bounces arrive only as `message.bounced`, and the live subscription doesn't include it.
- The mailbox holds no Gmail or Outlook mail yet.

**This is still not production readiness:** every channel result below comes from fakes, simulated reply layouts and test databases.

| Area | After pass 3 (verified by) |
| --- | --- |
| Real client reply layouts | Gmail (including wrapped attributions), Outlook header blocks with or without the separator, Outlook mobile, iOS/Apple Mail, bottom-posted replies and forwards are cut to the vendor's own words; vendor prose containing "From:" is kept (`realClientReplies`, `emailBody`; eval corpus leak 1 → 0) |
| Bounces | `message.bounced` / `message.failed` webhook handling plus a reconciler sweep of outbound status (`deliveryStatus`, `webhookDelivery`). **The live subscription still needs both events added** |
| HTML-only mail, attachments | Safe HTML-to-text; attachments capped while streaming and identified by magic bytes; 5xx downloads retried; a PDF total that contradicts the body is flagged (`htmlText`, `attachmentReliability`) |
| Continuity vs identity | A reply proven only by the token can quote but never approve, pay, name a payee or settle; payment instructions from it carry a confirm-by-phone warning (`continuityVsIdentity`) |
| Opt-outs and bounces | Footers and "$550" no longer trigger them; an unverified STOP is job-local (WS-F regressions) |
| Tenancy | Durable, workspace-scoped text routing (108); ambiguous texts held; wrong-code and `business_profile` leaks fixed; vendors resolved by name per workspace (`tenancy`, `workspaceVendors`, `security.e2e`) |
| Reliability | Lease renewal plus a fence before every side effect; A2A, approval iMessage and `textHuman` claimed in the outbox; `operator_reviews` (109); stuck-job recovery; stale Stripe `charging` rows held; `job-ops.ts` (`reliability`, `jobOps`) |
| Purchasing | Compliance-gated recommendation; quote validity and re-confirmation; the vendor confirms the booking before the handoff (110); `human_reported_paid` vs `settled_verified`; honest cancellation; the PAID-after-30-min bug fixed (`purchaseFlow`, `e2ePurchase`, `purchaseOutput`) |
| Operations | CI workflow (actionlint clean, not yet run on GitHub); fail-closed `HAGGLE_ENV` config; production-DB guard on operator scripts; ledger (111); `/ready`; redacted logs; alert webhook; AI usage limits; `smoke.ts` (`config`, `health`, `aiUsage`, `smoke.e2e`, `migrationsLedger.pg`) |
| Evaluation | 49-case simulated corpus, 23 adversarial tests, `docs/eval-report.md`. Claude extraction is not measured |

**Blockers after pass 3:**
- No real Gmail or Outlook reply has been ingested. Run `apps/mcp/scripts/email-trial.ts` with a consenting mailbox. Its first check: does the Message-ID returned at send time equal the SES id that replies reference? If not, every external reply fails `not_in_our_thread`.
- Inkbox exposes no Authentication-Results. Ask for them, per message; `AuthEvidence` already consumes them.
- The live webhook subscription lacks `message.bounced` and `message.failed`.
- No staging environment. Live migrations 103–111 aren't applied, and the CI workflow has never run on GitHub.
- The views and `packages/core` don't show the booking/handoff stages yet (Aarnav, §11 of the sprint report). Brain tenancy is still open.

### Pass 4: sprint 4, pilot readiness (2026-10-22)

Branch `yashnil`, on `ef122fe` (which is pushed, with CI green on draft PR #1). The sprint-4 commits are local only: GitHub push protection blocked the push over synthetic test secrets (`docs/sprint-4-report.md` §11). Not deployed. Migrations 112, 113 and 115–117 are applied only to throwaway databases. No real email, text, call or payment was sent. Full write-up: `docs/sprint-4-report.md`.

Verified on the fully merged tree:
- typecheck: clean
- MCP build: OK
- unit tests: 1,378 passed, 21 skipped
- Postgres 17: 938 passed, 1 skipped, plus 4 ledger tests
- migrations 100–106, 108–113 and 115–117 apply; each 112+ migration also applies alone on 100–111
- secret scan of the docs: clean

**Still not production readiness:** all channel, payment and extraction evidence comes from simulated providers and deterministic readers.

| Area | After pass 4 (verified by) |
| --- | --- |
| Pilot onboarding | `workspace-create` / `workspace-admin show` PASS/FAIL readiness; `deal` without names uses the workspace's consented vendors; plain-language requests carried through every stage (`pilotOnboarding`, `requestPlain`, simulated `acceptancePilot`: 12 tool calls, 5 human steps) |
| Real-format email | 20 Inkbox-format fixtures through the webhook to a quote or quarantine; reply-all in Cc accepted; tokens scoped to one deal and vendor; quarantine release/reject with permanent provenance (112) (`emailFixtures`, `replyTokenScope`, `quarantineReview`) |
| Email trial runner | `validate` and `dry-run` contact nothing; offline replay through the real path; every send gate tested. **Never run live** |
| Vendor contact policy | Business-hours window (default Mon–Sat 08:00–19:00 Pacific, on in live mode), at most 2 reminders, none after a reply, opt-out or bounce; per-vendor contact status on the board (`contactWindow*`, `boardVendorContact`) |
| Quote validity | Date, delivery-window and identity mismatches block approval; tax-excluded totals and added gratuities flagged; per-quote selection reason; stale quotes never recommended (`termsCheck`, `evalFields`, `valueExplain`) |
| Booking and payment honesty | Text vendors confirm by text; confirm-only needs the vendor's written yes (113); a token-only "confirmed" needs `BOOKED <code>`, and a token-only "received" is never verified; the cap is rechecked before the handoff (`purchasingPilot`, `bindingTerms`, `security`) |
| Transaction integrity | `call_back` needs the approver's `CALL <code>` and callee consent; a charge in progress counts as money in flight; simulated, heuristic, held and unverified sources can't carry money; payment states final (115) (`security`, `security.tenancy.e2e`) |
| Reliability | Lease-renewal errors and ambiguous sends (including Inkbox 409) never bounce or escalate; reconciler catch-up after outages (117); stuck-job recovery now runs on the live tick; alerts from engine events (`leaseFence`, `outboxAmbiguity`, `reconcileCatchUp`, `failureDrill`, `inkboxConflict`) |
| Operations | Env manifest validates config (silent fallbacks are now startup errors); ledger detects database-ahead; pool gate; request-size and rate limits; `launch-gate`, `smoke --live-readonly`, `ops-report`, `quarantine`; backup/restore drill run locally (`envManifest`, `configRules`, `migrationsLedger`, `limits`, `opsReport`) |
| Output size | Compact `get_quotes` ≤ 10,000 characters for 6 quotes (was 14,569); `detail:true` gives the full board (`boardSize`, `mcp.e2e`) |
| Evaluation | 59-case corpus (49 independent), per-field and money-error scoring, a raw-email baseline, traction and funnel queries excluding test data (116). Claude extraction not measured |

**Blockers after pass 4:**
- No real Gmail or Outlook reply ingested. The send-time vs SES Message-ID question is still open.
- The Inkbox subscription lacks `message.bounced` and `message.failed`.
- Inkbox gives no sender-authentication results.
- No staging environment; live migrations 103–117 not applied.
- Sprint-4 push blocked pending your decision (GitHub push protection on synthetic test secrets).
- Views and `packages/core` don't show the new stages yet; brain tenancy is still open (Aarnav).

### Pass 5: sprint 5, release candidate (2026-10-22)

Branch `yashnil`, pushed (fast-forward) to draft PR #1; not merged, not deployed. Migrations 118, 119, 121 and 122 are applied only to throwaway databases. No real email, text, call or payment was sent. Full write-up: `docs/sprint-5-report.md`; prerequisites: `docs/pilot-launch-checklist.md`; manual steps: `docs/manual-actions.md`.

Verified on the integrated tree: typecheck and build clean; unit 1,561 passed / 31 skipped; Postgres 1,025 passed / 1 skipped plus 6 apps/mcp Postgres tests; `verify-migrations`, `migration-compat` (seeded 102 upgrade and every checkpoint), `smoke-local`, secret scan and env-manifest check all OK.

**Still not production readiness:** every result is simulated.

| Area | After pass 5 (verified by) |
| --- | --- |
| Booking | Booking needs the vendor's written confirmation or the approver's `BOOKED <code>`, enforced in the database (118); no dead ends after approval; stale/withdrawn approvals ignored; other-day replies and unconfirmed must-haves never book (`purchaseBypass`, `purchaseExits`, `purchaseScenarios.e2e`) |
| Agent experience | 9 agent tool calls (was 12) and 5 human steps in the simulated acceptance flow; `list_deals` resumes with the purchase stage; plain "not compared" reasons; local-calendar dates (`acceptancePilot`, `purchaseFlow.e2e`, `purchaseComparison`, `purchaseDates`) |
| Operator control | Audited operator log (119); suspend/resume; approver verification; audited roster; operator callback and held-text release by CLI; `pilot-preflight` PASS/WARN/FAIL/BLOCKED (`lifecycleControls`, `operatorActions`, `pilotPreflight`) |
| Release | `build_sha`/`version` on `/health` and `/ready`; staging release script (plan/execute/deploy); migration compatibility from 102; guard enumeration across all scripts; smoke can't contact anyone; launch gate requires bounce events; CI runs every gate (`release`, `releaseStaging`, `smokeSafety`, `scriptsDbGuard`, `ciRelease`) |
| Security review | 14 fixes plus H9 from an independent adversarial review: stale approver, cross-workspace texts, code guessing, message guard, invented offers, opt-outs across channels, unauthorized phone sends, payment-instruction swaps, approval immutability (121), tenant menu leak (`securityS5`) |
| Metrics | Database-only metrics with a tested simulated-vs-real rule; per-job AI usage (122) and approximate cost; seeded pilot benchmark (`metrics`, `benchmark`) |

**Blockers after pass 5:** real-mail evidence; staging and live migrations 103–122; Inkbox bounce events; brain tenancy and view stages (Aarnav). Decisions H1–H3 were made and implemented the same day: texted confirmations and receipts never bind on their own, caller ID is never callback consent, and only the approver's `CANCEL <code>` cancels a vendor-confirmed booking (`securityDecisions`, `purchaseFlow.e2e`).

## 1. Production infrastructure
- [ ] Finalize and verify the shared TypeScript contracts between the deal engine and the business brain.
- [ ] Apply all Supabase migrations; verify schemas, indexes, constraints and relationships.
- [ ] Verify Row Level Security on every relevant table and test cross-user data isolation.
- [ ] Set up separate development, staging and production environments.
- [ ] Deploy the MCP server to a stable, public HTTPS endpoint (Manufact).
- [ ] Configure production credentials, API keys, env vars and secret management.
- [ ] Run persistent background workers for async outreach (email, calls, iMessage) and negotiation jobs.
- [ ] Configure and verify Inkbox identities, sender permissions, webhooks and delivery (email domain, phone number, iMessage).
- [ ] Set up database backups and test a restore.
- [ ] Set up CI/CD with typecheck, lint, tests and post-deploy verification.

## 2. Core MCP and agent experience
- [ ] Implement and verify every MCP tool (full list above).
- [ ] Back every tool with the production engine and brain instead of stubs or fixtures.
- [ ] Consistent structured outputs, input validation and actionable error messages.
- [ ] Long-running jobs persist after the agent disconnects or its session ends.
- [ ] Secure user authentication and scoped MCP tool permissions.
- [ ] Clear `next` hints; minimize unnecessary tool calls.
- [ ] Verify from Claude Code and at least one other MCP client (ChatGPT or Claude).
- [ ] Write install instructions, example prompts and tool docs.

## 3. Real vendor discovery and communication
- [ ] Real business discovery by service category and area.
- [ ] Collect and validate business emails/phones, sources and metadata.
- [ ] Keep real businesses separate from simulated test sellers in every environment and output.
- [ ] Personalized RFQs with quantities, dates, budgets, requirements and deadlines.
- [ ] Each sourcing request has a dedicated, correctly routed identity or conversation thread.
- [ ] Inbound processing: email, attachments, call transcripts, iMessage; reliable thread matching.
- [ ] Route vendor questions and missing info to the user for clarification (`answer_business`).
- [ ] Bounded, context-aware follow-ups that respect vendor opt-outs.
- [ ] Track bounces, delivery failures, non-responses, unanswered calls and expired requests.
- [ ] Validate the full sourcing flow with real vendor replies, not simulated ones.

## 4. Quote extraction, comparison and negotiation
- [ ] Parse plain-text emails, informal replies, `quote.json` attachments, PDFs and call transcripts.
- [ ] Normalize into the `Quote` schema with source references.
- [ ] Extract prices, taxes, fees, minimums, deposits, availability and terms correctly.
- [ ] Flag uncertain or contradictory details instead of inventing missing ones.
- [ ] Check each quote against the user's original requirements.
- [ ] Rank quotes by total cost, compliance and user preferences.
- [ ] Fair-price checks using genuinely comparable historical quotes.
- [ ] Negotiate using only verified competing quotes and approved user limits.
- [ ] Negotiation round limits, spending limits and escalation rules.
- [ ] Vendor confirms the negotiated offer before any purchase.

## 5. Business intelligence and learning
- [ ] All five brain functions done: `learnFromReply`, `estimate`, `checkPrice`, `negotiationHints`, `discover`.
- [ ] Persist structured business profiles after each meaningful interaction.
- [ ] Record pricing history, menus, service areas, minimums, fees and response times.
- [ ] Track negotiation outcomes and observed discount behavior.
- [ ] Warm estimates from real historical quotes and transactions.
- [ ] Show estimate confidence, sample size, source and data freshness.
- [ ] Update profiles when newer quotes contradict older observations.
- [ ] Expire stale prices; require verification before final purchase.
- [ ] Demonstrate a repeat transaction benefiting from learned vendor info.
- [ ] Measure how much the warm path cuts latency, tool calls or manual work vs. a cold deal.

## 6. Approval, payments and transaction safety
- [ ] Explicit human approval before any binding order or payment.
- [ ] Bind each approval to the exact vendor, quote, amount and terms.
- [ ] Verify approver identity and permissions on every approval.
- [ ] Strict spending caps; reject unauthorized payment requests.
- [ ] Keep Stripe test mode clearly separate from any live-money setup.
- [ ] A supported real payment flow (Stripe live) or an explicit manual payment handoff.
- [ ] Check the payee matches the business that issued the accepted quote.
- [ ] Prevent duplicate charges with idempotency keys and state constraints.
- [ ] Record receipts, payment status, timestamps and failure reasons.
- [ ] Handle cancellations, failed payments, expired quotes, refunds and dispute handoffs.
- [ ] Test attempts to bypass approval, change amounts or swap payees.

## 7. Reliability and security
- [ ] Durable job states, automatic retries, exponential backoff and timeouts.
- [ ] Idempotent outreach, webhook processing and payment actions.
- [ ] Recover interrupted jobs after restarts, network failures or worker crashes.
- [ ] Webhook signature checks, sender authentication and replay protection.
- [ ] Prompt-injection defense for vendor emails, PDFs, attachments and call transcripts.
- [ ] Validate all external content; cap document sizes, file types and processing cost.
- [ ] Secure credentials; redact personal info and secrets from logs.
- [ ] Test concurrent jobs across users, vendors and organizations.
- [ ] Audit log covering vendor contact, quote changes, approvals and payments.
- [ ] Monitoring and alerts for stalled jobs, webhook failures, delivery failures and payment errors.
- [ ] Manual escalation, job cancellation and an emergency stop for automated actions.
- [ ] Document data retention, deletion, user consent and allowed vendor outreach (including call consent).

## 8. Product interface and onboarding
- [ ] Finish the deal board with clear, live job status.
- [ ] Show contacted vendors, pending replies, normalized quotes and key exclusions.
- [ ] Show the chosen quote, amount, approval request and outcome.
- [ ] Clearly distinguish confirmed quotes, unverified estimates and simulated demo data.
- [ ] Simple onboarding: connect Haggle and create a first sourcing job.
- [ ] Sample request and instructions for using Haggle through an agent.
- [ ] Job history and a way to resume unfinished deals (`list_deals`).
- [ ] Error and recovery states understandable without technical knowledge.
- [ ] Test onboarding and approval with people who have never seen the product.
- [ ] Fix the highest-friction issues from those sessions.

## 9. Testing and benchmarks
- [ ] Deterministic simulated vendor fleet for repeatable integration tests.
- [ ] Automated tests for every MCP tool and every significant engine state transition.
- [ ] Test messy emails, PDFs, missing fields, wrong prices and ambiguous terms.
- [ ] Test silent vendors, bounces, delayed replies, duplicate messages and expired offers.
- [ ] Test requirement mismatches; cheap non-compliant quotes are rejected.
- [ ] Test negotiation safeguards; unsupported claims are never sent.
- [ ] Test unauthorized approvals, malicious vendor messages and payment attacks.
- [ ] Multi-user concurrency tests with cross-user isolation checks.
- [ ] Raw-email baseline to compare against Haggle's orchestration.
- [ ] Measure completion rate, latency, tool calls, token cost and human interventions.
- [ ] Measure quote extraction accuracy and financial-field error rates.
- [ ] Compare active human time with Haggle vs. sourcing manually.
- [ ] End-to-end regression suite before every production deploy.
- [ ] Document benchmark method and report full measured results.

## 10. Real-world validation and traction
- [ ] Pick one initial purchasing category and define its ideal customer.
- [ ] Recruit at least five pilot users with real upcoming purchases.
- [ ] Identify 20 to 30 real vendors in that market.
- [ ] Run real, permission-based sourcing requests with those vendors.
- [ ] Collect and normalize at least ten real vendor quotes (response rates permitting).
- [ ] Get at least one real user through a full sourcing decision.
- [ ] Facilitate at least one real purchase or verified purchasing handoff.
- [ ] Interview pilots about current workflows, trust concerns and pain points.
- [ ] Measure vendor response rates, quote completion rates and why jobs fail.
- [ ] Check whether users come back for later requests.
- [ ] Ask prospects about concrete pricing and willingness to pay.
- [ ] Find the three biggest friction points and ship fixes.
- [ ] Collect testimonials or feedback, with permission.
- [ ] Keep an accurate dashboard of real users, jobs, quotes, purchases and retention.

## 11. Launch and YC readiness
- [ ] Minimal landing page: what Haggle does and who it's for.
- [ ] Stable demo reachable by external reviewers.
- [ ] Record a genuine end-to-end demo that clearly marks real vs. simulated interactions.
- [ ] Technical docs for the MCP interface, business learning and safety controls.
- [ ] Document known limits and unsupported purchasing scenarios.
- [ ] Production security, privacy and deployment review.
- [ ] Final performance tests; fix all critical reliability issues.
- [ ] Feature freeze before the YC deadline; produce a stable release candidate.
- [ ] Factual summary of shipped features, live users, real transactions and benchmarks.
- [ ] Short-term roadmap based on pilot feedback.
- [ ] Submit the YC application with an accurate demo and verified traction numbers.
