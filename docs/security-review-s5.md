# Security review, sprint 5 (workstream D)

Adversarial security and integration review of Haggle at baseline `ce4760e` (2026-10-22), with fixes on top. Everything below was found and checked with the in-memory engine, throwaway Postgres databases and fake providers. No real email, text, call or payment was sent; no live service was touched.

## 1. Scope

- **Reviewed:**
  - `apps/mcp` (every tool, the settings, the mention resource, the webhook route, the operator scripts);
  - `packages/engine` (the engine, the stores, inbound matching and sender auth, text routing, callbacks, payments, negotiation, recovery, the reconciler, dead letters);
  - migrations `100`–`117`.
- **Read-only:** `packages/core`, `packages/brain`, `apps/mcp/views`.
- **Threat actors:**
  - a malicious or prompt-injected agent calling MCP tools;
  - a malicious vendor (mail, text or call content, a spoofed sender, forged reply tokens, Cc and forwarding tricks);
  - a tenant trying to reach another workspace;
  - a stranger texting the shared line;
  - a replayed or forged webhook;
  - an operator mistake.

## 2. Method

1. **Read-only sweeps.** Four parallel sweeps, one per area:
   - tenancy;
   - inbound sender identity and codes;
   - an inventory of every path with a real-world side effect;
   - self-approval and payment tampering.
2. **Confirmation.** Each claimed issue was confirmed by a concrete trace or a probe test. Suspected-only items are labelled as such in §4.
3. **Fixes.** Each confirmed issue got a failing regression test first (`packages/engine/tests/securityS5.test.ts`, `apps/mcp/tests/securityS5.test.ts`), then the smallest fix. Every new test was seen failing before its fix.
4. **Database rules.** Database-level rules got SQL assertions: `supabase/tests/engine_security2_assertions.sql` for migration `121_engine_security2.sql`.

## 3. Findings fixed in this sprint

Severity is for the pilot: live mode, manual payment, out-of-band approvals, a shared text line. Line numbers are at baseline `ce4760e`.

| # | Severity | Finding | Evidence (baseline) | Fix |
|---|---|---|---|---|
| F1 | Medium-High | A replaced approver's phone could still approve or decline. | `routeText` treats a sender as the human when Haggle's last text to that number carried an approval. `ingestTextApproval` added that approval without checking the sender is still the approver (`engine.ts` ~2124). | The last-texted approval counts only while the sender is that deal's current approver. |
| F2 | Low-Medium | A coded text from a number that approves no open deal (e.g. the operator's notify number) was stored on another workspace's deal, and that workspace's approver was texted. | `engine.ts` ~2134: `getJob(decided?.job_id ?? last?.jobId ?? open.find(() => true)?.id)`. | It is recorded only on a deal the number approves for, otherwise nowhere. |
| F5 | Low | Wrong `YES` codes weren't counted when the approver had two or more pending approvals, so guessing was unlimited. | `decideByText` counted a wrong code only when exactly one approval was pending. | A wrong code counts against every pending approval of that approver (as `CALL` already does). |
| F6 | Medium | The agent-text guard (`send_message`, `answer_business`, phone briefs) missed reworded commitments, amounts written without a `$`, and lookalike competitor names. | `negotiation/messageGuard.ts:31`: seven fixed phrases; amounts only with `$` or "dollars". | Commitment patterns added; amounts read in price context ("USD 900", "1.2k", "quoted us 900", "match 900"); names compared after folding case, separators and digit lookalikes. Ordinary questions still pass (tested). |
| F7 | Medium | Request details could launder an invented competing offer. | `guardText` counted every `$` amount in `request.details` as citable, and `rfq.ts:94` sends every detail to every vendor. | `deal` refuses a detail that cites a competing offer (`detail_cites_competitor`), and such details never count as citable amounts. |
| F8 | Low-Medium | An operator could release a held `BOOKED <code>` text to a deal of their choice. | `releaseHeldText` refused YES/NO, PAY, PAID and CALL texts, but not BOOKED. | BOOKED texts are refused too (`decision_not_releasable`). |
| F9 | Medium | An `@domain` allowlist entry authorized any A2A card URL ending in it, e.g. `https://attacker.example/@vendor.com`. | `allowedRecipient` (`engine.ts` ~701), same in `job-ops.ts:143`. | `@domain` matches email addresses only (engine and `job-ops`). |
| F10 | Medium | Opt-outs weren't honoured across channels. | **Agent messages:** after an email STOP (verified or not), `send_message` and `answer_business` could still call or text the business. **Escalation:** an email refused as `opted_out` was escalated to a Voice AI call (`onSendFailure`, `dueCalls`). **Counteroffers:** a business that said STOP still got counteroffers, because reading its earlier quote afterwards reset its status to `quoted`. | Agent messages to an opted-out business are refused on every channel (`business_opted_out`). An `opted_out` send failure marks the business declined and never escalates. Counteroffers skip a business that opted out. |
| F11 | Medium | On a live server, `send_message` with the phone channel was effectively an unauthorized callback: uncapped, could switch an email vendor to a call, and could discuss prices without the approver's `CALL` code. | The `sendMessage` phone branch called `placeCallOnce` with only call hours and a cooldown. | Live: no channel switch to a call (`call_needs_approver`), no price talk by call (`call_cites_price`), at most one agent-written call per business per deal (`call_limit`). |
| F12 | Medium | Payment instructions could be silently replaced after the human was told how to pay. This is the classic payment-redirect fraud; the sender could be reply-token-only. | `ingestPaymentInstructions` overwrote `instructions_text` on every trusted reply. | The first instructions are kept. A change records `instructions_changed`, opens an operator review (`payment`) and texts the human not to pay until they confirm by phone. |
| F13 | Low-Medium | A vendor removed by the operator (consent withdrawn) while its RFQ waited for contact hours was still contacted. | Authorization was checked only in `deal()`; `runDueContacts` → `contactBusiness` didn't re-check. | First contact re-checks the allowlist and the workspace vendor list; an unauthorized business is marked unavailable. |
| F14 | Low (defense in depth) | In Postgres, an approval's terms could be changed by UPDATE, and a decided approval could be revived. The in-memory store also didn't bind an approval to its quote on insert. | `105` checks approvals on insert only. `memory.ts insertApproval` checked nothing. | Migration `121_engine_security2.sql` makes approval terms immutable and allows only forward status moves. The in-memory store has the same rules (`payments/guard.ts approvalUpdateViolation`) and checks quote, business and total on insert. |
| F15 | Low | `business_profile` could show another tenant's data from the shared brain profile. | The brain keeps only the newest history rows, but menu, flags, area and reply speed accumulate from evicted rows. `historyOnly` returned the whole profile when every remaining row was the caller's (`apps/mcp/src/brain.ts:41`). | Exact mode always rebuilds from the caller's rows and drops area and reply speed. |

## 4. Open findings: hand-offs and accepted risks

| # | Severity | Finding | Status |
|---|---|---|---|
| H1 | Low-Medium | Callback consent "called_us" rests on caller ID, which can be spoofed. `callbackConsent` (`callbackAuth.ts:63`) accepts an inbound call matched by number even when the caller isn't trusted. Exploit: spoof a non-consenting vendor's number to make it eligible for a callback. The approver's `CALL` code or an operator is still needed. | **Accepted risk** for the pilot: vendors are consented `workspace_vendors`. Recommendation: count `called_us` only for `sender_trusted` calls. This changes the behaviour asserted in `security.test.ts:174`, so it's a product decision. |
| H2 | Medium | A text from the vendor's number counts as a verified sender (`bindsTermsAlone`, `trustStrength.ts`). An SMS "confirmed" books the deal and an SMS "received" records `settled_verified`, while `SMS_PAYMENT_WARNING` says texts can't prove who wrote them. SMS sender IDs can be spoofed. | **Decision for Yash** (`purchasingPilot.test.ts:80` asserts this). Recommendation: treat SMS like reply-token email for confirmations and receipts (`BOOKED <code>` required; never `settled_verified`). |
| H3 | Low-Medium | `cancel_deal` lets the model cancel a human-approved, vendor-confirmed booking. A prompt-injected agent (e.g. from another vendor's text) could do it. | **Accepted risk** for the pilot (nothing is paid or committed by a cancel; the human is told). Spec for workstream A: after `order_confirmed`, require an out-of-band `CANCEL <code>` from the approver. |
| H4 | Low | A stranger's `PAY <code>` text is stored on another workspace's deal whose latest approval has that code. It's recorded as untrusted with a `pay_ignored` event. No charge, no reply, but it adds noise to that deal. | **Accepted** (the audit trail is useful). Existing tests assert it (`approvalSecurity.test.ts:154`, `sms.test.ts:856`). |
| H5 | Medium | `ask`, `check_price` and the board's price check read brain profiles shared across workspaces. | **Known** (sprint-4 §8.8). Aarnav: add `workspaceId` to the Brain interface (`packages/core/contracts.ts`) and key `brain_profiles` by workspace. |
| H6 | Low | A2A sends don't consult suppressions, and there's no opt-out over A2A. | **Accepted**: A2A is off in the pilot. |
| H7 | Low | Any extra dollar figure in a vendor's booking reply counts as changed terms and voids the approval, so a thread holder can force a re-approval. | **Accepted**: fails safe. |
| H8 | Low (suspected) | The approval's `thread_id` is set from the first matching inbound email before its sender is trusted (`engine.ts` ~3957). | **Accepted**: email approval is off by default, and the email approval branch re-checks the approver's address and trust. |
| H9 | Low | After a STOP, reading an earlier quote of that business resets its status to `quoted`, so the board shows it as quotable. | **Partly fixed** (F10: no agent message, no counter). Spec for workstream A: keep `declined` when the job has an opt-out event for the business, and refuse `approve` for an opted-out business. |
| H10 | Low (reliability) | Text routing and PAY/PAID acknowledgements scan only the 20–50 most recent jobs across all workspaces, so a busy server can miss a late PAY on an older deal. | Request to workstream B/C: scope by approver number in the store. |
| H11 | Low | Rate limits, AI limits and alert dedupe are per process. | **Known** (sprint-4 §8.10). |

## 5. Side-effect paths and their authorization

Every path that reaches the outside world, who can trigger it, and what must hold first. "Fence" means lease check + outbox claim + provider idempotency key.

| Side effect | Function | Triggered by | Checks |
|---|---|---|---|
| Vendor email: RFQ, reminder, follow-up, counter, answer, agent message, booking, handoff, confirmation, cancel note | `sendRecorded` | `deal` / `advanceJob`, `answer_business`, `send_message`, `negotiate`, booking/handoff hooks, `cancel_deal` | Contact fixed at `deal()` (never from message content). Suppression check on every send. Fence. Allowlist / workspace vendor at `deal()` and, now, again at first contact (F13). Contact hours for first RFQ and reminders. Opt-outs refuse agent messages and counters (F10). Agent text passes the message guard (F6, F7). |
| Vendor text (iMessage / SMS) | `sendIMessageToBusiness` | Same as email | Stored phone, suppression, fence, opt-out (F10), guard. |
| Text to the human | `textHuman` / `notifyHuman` | Engine events, approval requests, callback authorization | Recipient only from `notifyTarget`: the workspace approver, or the notify number for the default workspace. Never from tool input. Fence, text budget. A held text is re-sent only if the number is still the target. |
| Approval request (text / iMessage / email) | `requestApproval` → text / iMessage / email | `approve` tool, the auto "quotes are in" suggestion | Approver from workspace settings only (the `deal` input is ignored, settings refuse agent changes). Codes never returned in live or out-of-band mode. |
| Approval decision | `decideByText`, email approval branch | Approver's coded text (email only if `HAGGLE_EMAIL_APPROVAL_BY_CODE=true`) | Current approver only (F1). Exact code. Lockout counted across pending approvals (F5). Card, form and simulated decisions refused on live jobs. |
| Outbound call: RFQ, escalation, answer, counter | `placeCallOnce` via `placeRfqCall` / `callBusiness` | `deal` / `advanceJob`, `dueCalls`, counters | Phone suppression, fence (never redialed if it may have rung), call hours and cooldown. No escalation after an opt-out (F10). Counters skip opted-out businesses (F10). |
| Agent-written call | `sendMessage` (phone) | `send_message` | Live: own channel only, no prices, one per business per deal (F11). Opt-out refused (F10). Guard. |
| Callback (price discussion) | `placeCallback` | Approver's `CALL <code>` text, or `job-ops` operator callback | Live: never from a tool. Callee consent from durable records (H1). 6-digit code, 30-minute expiry, lockout. Suppression re-checked at placement. |
| A2A task | `a2aSend` | RFQ, counter, answer, `send_message` | Card URL fixed at `deal()`. Allowlist: `@domain` entries no longer match URLs (F9). Fence. Disabled in the pilot. |
| Booking confirmation and payment handoff | Booking hook, `startHandoff` | Approved approval + vendor reply | Weak senders need `BOOKED <code>` (H2 for SMS). Cap and guard rechecked before handoff. Changed instructions held (F12). `PAID` only from the approver, after revalidation. |
| Stripe charge | `pay` → Stripe | `pay` tool, `PAY <code>` text | `checkApprovedPayment` (approval for exact quote, amounts, caps, state). One charge per approval. Resume re-runs the guard. DB triggers (105, 115, 121). Off in the pilot (`HAGGLE_PAYMENTS=manual`). |
| x402 | `checkX402PaymentAllowed` | x402 challenge | Same guard plus payee checks. Off in live. |
| Voice answering instructions | `setInstructions` | Job changes | Only jobs of the configured voice workspace. Callers' words are data. |
| Operator CLIs | `job-ops`, `quarantine`, `workspace-admin`, `email-trial` | Operator with database access | None calls a provider directly; the server's next advance sends. Retry planner refuses suppressed, deauthorized (now email-only `@domain`, F9), possibly-rung and old keys. Quarantine release is quote-only and pre-approval. Held decision texts are never released (F8). `email-trial send` is gated by env and flags and never contacts vendors. |
| Reconciler, recovery, dead letters, stalled-job checks | `live/reconcile.ts`, `workflow/recovery.ts`, `deadLetter.ts`, `ops/stalled.ts` | Timers | Ingest or plan only. Sends go through the paths above, with their checks. |

Webhooks: the Inkbox signature covers request id, timestamp and body; deliveries more than 300 s old are rejected; every ingest is idempotent by provider id. Mail detail is re-read from the buyer mailbox, never trusted from the payload.

## 6. Verification

- `npx vitest run`: 1,414 passed, 21 skipped (baseline 1,378). The new files are `packages/engine/tests/securityS5.test.ts` (35 tests) and `apps/mcp/tests/securityS5.test.ts` (1 test).
- `scripts/verify-migrations.sh`: OK. It includes `engine_security2_assertions.sql` and applies `121_engine_security2.sql` alone on top of 100–111.
- `PGTEST_PORT=55444 scripts/test-postgres.sh`: 972 passed, 1 skipped, and 1 timed out, plus 4 ledger tests (baseline 938 + 1 skipped + 4). The timeout was a different test in each of two runs (`workflow.e2e`, then `stripe`). Load average was about 200 from parallel workstreams. Those files plus the tenancy and approval-security files pass on rerun: 95 of 95.
- `npm run typecheck`: clean.

## 7. Needs real providers or people

- **Inkbox:** confirm SMS sender ID can't be spoofed on its line (bears on H2), and whether `call.ended` remote numbers are carrier-verified (H1).
- **Yash:** decide H2 (SMS as proof for confirmations and receipts) and H1 (called_us consent).
- **Yash and Aarnav:** brain tenancy (H5).
