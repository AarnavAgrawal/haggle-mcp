# Overnight sprint report (2026-10-22)

Branch `yashnil`, from `51bae51` to the commit that adds this file. Everything is **local**: nothing was pushed, merged to `main`, deployed, or applied to the live database. No real email, text, call or payment was sent. The only live-service contact was read-only inspection of the Inkbox buyer mailbox, webhook subscriptions and delivery log (details in §8). One read-only query against the production database was attempted and blocked by the permission system; it was not retried.

## 1. Executive summary

Six workstreams ran in parallel, each in its own git worktree with its own files, migration number and Postgres test port. The coordinator merged them one at a time, resolved conflicts, and ran the full suite after each merge.

Where this leaves the target flow: real request → real vendor email → reliable reading → accurate comparison → verified human approval → confirmed booking → honest payment handoff.

- **Reading real vendor email.** Replies are read correctly however Gmail, Outlook (desktop, web and mobile), iOS or Apple Mail lays them out, including bottom-posted replies and forwards. Quoted Haggle text can no longer be read as the vendor's price; the corpus leak dropped from 1 to 0. HTML-only mail is now read. Inkbox bounce events are handled. Attachments are capped while streaming and identified by their bytes, not their file name.
- **Opt-outs and bounces.** A footer "unsubscribe" no longer counts as an opt-out. A STOP from an unverified sender stops contact for that deal only. A "$550" in a quote is no longer read as SMTP error 550.
- **Continuity is not identity.** A reply proven only by the reply token can quote, but can never approve, pay or name a payee. Payment instructions from such a sender carry a "confirm by phone" warning.
- **Comparison.** A quote that misses, or hasn't confirmed, a hard requirement can no longer win or be texted for a YES. Recommendations respect the workspace cap. A delivery deadline ("by 5:00 PM") is never assumed met.
- **Booking.** On the manual rail, approval asks the vendor to confirm availability and terms first. The handoff starts only after that confirmation. A stale quote is re-confirmed before approval, and changed terms need a new human approval.
- **Honest payment.**
  - "The customer reports paying" (`human_reported_paid`) is kept distinct from "the business confirmed receipt" (`settled_verified`).
  - Cancellation tells the vendor exactly what happened.
  - A cancellation after a reported payment flags the operator and never claims a refund.
  - The PAID-after-30-minutes bug, which made every real manual payment fail, is fixed.
- **Multi-tenant.**
  - Text routing is durable and scoped to a workspace (it used to be in memory).
  - An ambiguous text is held, never guessed.
  - Two cross-tenant leaks were found and fixed: a "YES <wrong code>" text reached another workspace's approver, and `business_profile` showed other tenants' deals.
  - The agent can name a workspace's vendors by name.
- **Reliability.**
  - Leases are renewed while an advance runs, and a stale holder is fenced out.
  - Three side effects that weren't claimed in the outbox now are: A2A sends, the approval iMessage, and the `textHuman` fallback.
  - Repeated failures go to a durable operator-review queue, and stuck jobs are found and recovered.
  - A Stripe `charging` row is never resumed after 20 hours, because Stripe's idempotency keys expire after 24.
  - `job-ops.ts` gives operators safe retries.
- **Operations.**
  - GitHub Actions CI is set up.
  - `HAGGLE_ENV` config fails closed if anything is missing.
  - A production-database guard covers every operator script.
  - The migration ledger is migration 111, and `/ready` is database-aware.
  - Logs are structured and redacted, and alerts go to an optional webhook.
  - AI usage has per-job and per-day limits that fail safe, holding for a human.
  - There is a smoke-test runner and a deployment guide.
- **Evaluation.** There is a labelled simulated corpus (49 replies, 14 deals), 23 adversarial tests, and a reproducible report in `docs/eval-report.md`.

Still blocked, and the reason it isn't pilot-ready: **no real Gmail or Outlook reply has ever been ingested**, and **Inkbox exposes no sender-authentication verdicts**. Tomorrow's first real-world action is one consenting-mailbox run of `apps/mcp/scripts/email-trial.ts` (§10).

## 2. Production readiness: before and after

| Area | Before (51bae51) | After (this branch) | Evidence |
| --- | --- | --- | --- |
| Real client reply layouts | Outlook header-block quotes and bottom-posted replies passed our quoted RFQ (budget included) to the reader | Cut correctly; vendor prose containing "From:" or "Date:" is kept | `realClientReplies` 23/23, `emailBody`, eval corpus leak 1 → 0 |
| Bounces | Only bounce emails delivered to the mailbox (which SES-sent mail never produces) | `message.bounced` / `message.failed` webhook events plus a reconciler sweep of outbound status | `deliveryStatus`, `webhookDelivery` tests |
| HTML-only mail | Body null, so the reply failed to parse | Safe HTML-to-text, with link targets visible | `htmlText` tests |
| Token-only sender | Could name an x402 payee or settle | Never; continuity-only reasons can't move money | `continuityVsIdentity` |
| Opt-out / bounce false positives | A footer "unsubscribe" or "$550" suppressed a vendor globally | Fixed; an unverified STOP is job-local | WS-F regressions (9 formerly `it.fails`) |
| Text routing | In-memory `lastSms` and held texts; a wrong code fell through to any workspace | Durable `text_routes` / `held_texts` (108); ambiguous texts held | `tenancy` (8 scenarios fail on baseline) |
| Vendor selection | Contact addresses only for workspace vendors | Names resolved against the workspace's own vendors | `workspaceVendors` |
| Lease safety | An advance longer than the TTL kept sending while another instance took over | Renewal plus a fence before every side effect | `reliability` (16 of 23 fail on baseline) |
| Dead letters | Silent retries or give-ups | `operator_reviews` (109), `job-ops.ts` | `reliability`, `jobOps` |
| Booking | Approval meant pay | Vendor confirmation required before the handoff (110 trigger) | `purchaseFlow`, `e2ePurchase` |
| Manual payment wording | Views rendered "$X paid · Stripe test mode" | Stage names; reported vs verified | `purchaseOutput` |
| CI and config | None | `.github/workflows/ci.yml`; fail-closed `HAGGLE_ENV`; production-DB guard | `config`, `health`, actionlint clean |
| Migration tracking | None | `engine_migrations` ledger (111) + CLI | `migrationsLedger.pg` |

## 3. What was built, by workstream (paths)

**A: real external email.**
- New: `packages/engine/src/inbound/{deliveryStatus,htmlText,quarantineReasons,trustStrength}.ts` and `packages/engine/src/parsing/pdfBody.ts`.
- Changed: `inbound/{emailBody,senderAuth,attachments}.ts`, `live/{inkbox,reconcile}.ts`, and `apps/mcp/src/webhook.ts`.
- Trial runner: `apps/mcp/scripts/email-trial.ts`, with its logic in `email-trial-lib.ts`.
- Tests: `realClientReplies`, `emailBody`, `htmlText`, `deliveryStatus`, `continuityVsIdentity`, `attachmentReliability`, `inboundRegression`, `optOutBounce` (engine), plus `webhookDelivery` and `emailTrial` (apps/mcp).

**B: tenancy.**
- New: `packages/engine/src/workflow/textRouting.ts` and migration `108_engine_tenancy.sql`.
- Changed: `apps/mcp/src/{vendors,businesses,brain}.ts`, plus `apps/mcp/scripts/workspace-admin.ts` (new `show` and `remove-suppression` commands) and `workspace-create.ts` (one-command onboarding).
- Tests: `tenancy` (engine), plus `workspaceVendors` and new `security.e2e` cases (apps/mcp).

**C: reliability.**
- New: `packages/engine/src/workflow/{deadLetter,recovery}.ts`, migration `109_engine_reliability.sql`, and `apps/mcp/scripts/job-ops.ts`.
- Tests: `reliability` (engine) and `jobOps` (apps/mcp).

**D: purchasing.**
- New: `packages/engine/src/ranking/{compliance,validity}.ts`, `approvals/bookingReply.ts`, `payments/purchase.ts`, `workflow/requestNormalize.ts`, and migration `110_engine_booking.sql`.
- Changed: the output code in `apps/mcp/index.ts` and `apps/mcp/src/views.ts`.
- Tests: `purchaseFlow` and `e2ePurchase` (engine; explicitly SIMULATED), plus `purchaseOutput` (apps/mcp).

**E: operations.**
- CI and scripts: `.github/workflows/ci.yml` and `scripts/pg-common.sh` (CI can use a Postgres service instead of Docker).
- Server: `apps/mcp/src/{config,health}.ts`.
- Scripts: `apps/mcp/scripts/{dbGuard,migrations,smoke}.ts`.
- Engine: `packages/engine/src/live/{log,alerts,aiUsage}.ts` and `ops/{stalled,migrations}.ts`, plus migration `111_engine_ops.sql`.
- Docs: `docs/deployment.md`.
- Tests: `opsLogging`, `aiUsage`, `opsMonitoring` (engine), plus `config`, `health`, `smoke.e2e` and `migrationsLedger.pg` (apps/mcp).

**F: evaluation.**
- New: `packages/engine/eval/*`, `packages/engine/tests/{adversarial,evalCorpus}.test.ts`, `apps/mcp/scripts/eval-report.ts`, and `docs/eval-report.md`.

**Coordinator (integration).**
- Inbound texts now carry the line they arrived on (`inkboxTextReceived` → `to`).
- Reconciler give-ups go to operator review (`apps/mcp/src/live.ts`).
- `job-ops.ts` gets the production-DB guard.
- Parameter properties were removed from four classes, so `node scripts/*.ts` runs under Node's type stripping; it crashed before (`scriptsPlainNode` test).
- A delivery requirement with a time is no longer satisfied by "delivery included" (`parsing/requirements.ts`, `deliveryDeadline` test).
- Cross-workstream test fixes after the booking step was added. No security check was relaxed: each handoff test now has the vendor confirm the booking first.

## 4. Commits and branch status

First-parent history on `yashnil` since `51bae51`:

| Commit | What |
| --- | --- |
| `dc134dc` | Merge WS-F: evaluation corpus, adversarial tests, eval report |
| `4147321` | Merge WS-B: durable workspace-scoped text routing, vendor names, tenancy fixes |
| `d993cd7` | [integration] the tenant test checks for real leaks (it no longer flags the sender's own typed code echoed back to them) |
| `bd53e8f` | Merge WS-C: lease fencing, outbox gaps, operator reviews, stuck-job recovery, job-ops |
| `6c2d965` | Merge WS-E: CI, config guard, ledger, readiness, logs, alerts, AI limits |
| `63efeff` | Merge WS-A: client quoting, bounce events, HTML mail, continuity vs identity, trial runner |
| `9aabdf7` | [integration] fixed WS-F bugs become regression tests; text line; reconciler give-ups |
| `bfb3090` | Merge WS-D: booking before payment, handoff stages, compliance gate, re-confirmation |
| `36c00c0` | [integration] operator scripts run under plain node; delivery deadline never assumed met |
| HEAD (wrap-up) | Wrap-up: regenerated eval report, this report, readiness Pass 3, checklist |

The workstream branches hold 23 non-merge commits; `git log --no-merges 51bae51..yashnil` lists them, each prefixed `[WS-X]`. The local workstream branches (`ws-a-inbound`, `ws-c-reliability`, `worktree-agent-*`) and their worktrees under `.claude/worktrees/` can be deleted once you've reviewed. `yashnil` is **ahead of `origin/yashnil` and not pushed**.

## 5. Test results (run on the fully merged tree)

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run build -w @haggle/mcp` | OK |
| `npx vitest run` | **1,059 passed, 14 skipped** (Postgres-gated), 0 failed. Baseline was 789. |
| `scripts/verify-migrations.sh` | migrations 100–106 and 108–111 apply; every SQL assertion file passes; 111 re-applies idempotently |
| `PGTEST_PORT=… scripts/test-postgres.sh` | **762 passed** (engine suite on Postgres 17) + 3 ledger tests. Baseline was 548. |
| Eval report | regenerated from merged code (49 cases, 14 deals, MCP arm measured) |

Regressions and caveats:
- `verify-migrations.sh` failed once with "server not accepting connections" (a container start-up race) and passed on rerun. It may be flaky in CI.
- Docker Desktop crashed during the run. I restarted it, and every Postgres result above is from after the restart.
- Without `npm run build -w @haggle/mcp`, the five apps/mcp e2e files fail with "server did not start". CI builds before testing.

Intended behaviour changes that updated existing tests:
- An over-budget-only quote is no longer recommended.
- A delivery deadline the vendor didn't address is now a follow-up. The golden-grill live-miss case: "+$50 delivery fee" didn't confirm "by 5:00 PM".
- The manual rail requires the booking confirmation before payment instructions or PAID.

## 6. New migrations and compatibility

| Migration | Adds | Compatibility |
| --- | --- | --- |
| `108_engine_tenancy.sql` | `text_routes`, `held_texts` (job-workspace trigger), `suppression_removals` (append-only), `workspace_vendors.channel` | Additive. In-memory routing is gone, so texts in flight at deploy time route by durable records only |
| `109_engine_reliability.sql` | `operator_reviews`; outbox triggers: no re-claim while a review is open; a call never goes `unknown` → `not_sent` | Additive; new triggers on `outbox` |
| `110_engine_booking.sql` | `bookings` (needs a human-approved paying approval; terms immutable), `handoff_receipts`, `payment_handoffs.stalled_at`, and an insert trigger: no handoff before the booking is `confirmed`/`not_in_writing` | **Behavioural.** An existing open manual handoff from pass 2 has no booking row. Since none exist live (106 isn't applied), there's no data issue |
| `111_engine_ops.sql` | `engine_migrations` ledger (records itself) | Idempotent. On production: apply 111, then `migrations.ts backfill --through 106 --confirm`, then `record` each of 108–111 as applied |

Number 107 is unused; it was reserved for WS-A, which needed no migration. Per the pass-1 audit, migrations 103–106 were never applied to the live database, and neither are 108–111. **Apply in order with a backup first** (`docs/deployment.md` §4).

## 7. Unfinished or partly integrated

- **iMessage vendors and booking:** WS-B's `ingestBusinessIMessage` doesn't call WS-D's `ingestPurchaseReply`, so a texting vendor's booking is `not_in_writing` (the human confirms it directly). Wiring it is a small engine change I left for review.
- **Confirm-only approvals** (`action: "confirm"`) bypass the booking gate.
- **Stripe/x402 rails keep charge-then-confirm**, because Stripe test mode charges the operator's card, not a vendor. Only the manual rail has the booking gate.
- **Cancel during a Stripe `charging` row** is flagged (`operator_attention`), but the state machine doesn't treat `charging` as in flight.
- **Held ambiguous texts** are never re-processed: the sender must resend with the deal code. There's no operator "release to job X" command.
- **AI limits and alert rate limits are per process.** Strategist and question-answering calls made from tools count toward the daily budget, but not toward the per-job limit.
- **The A2A re-send after a crash** reuses its `messageId`; that's safe only if the vendor's agent dedupes on it (unverified).
- **Logging:** `webhook.ts` and `index.ts` `run()` don't use the new redacting logger yet.
- **The booking reader is keyword based:** ambiguous replies land in "unclear", which is the safe side. A Claude classifier would cover more real wording.
- **`get_quotes` payload size** grew to 14,569 characters for 6 quotes (from 13,200), above the ~1,500-token target in `CLAUDE.md`. That needs a compaction pass.

## 8. Security and reliability issues found (all fixed unless noted)

**Found by read-only inspection of the live Inkbox account (2026-10-22):**
- Inkbox sends through Amazon SES. The stored Message-IDs are SES ids (`<…@email.amazonses.com>`), and replies reference them.
- The live webhook subscription covers only `message.received`, `call.ended`, `imessage.received` and `a2a.sent_task.updated`. **Bounces were never handled in production.** The code now handles `message.bounced` and `message.failed`; the subscription itself still needs updating (§10).
- No message field or webhook payload carries SPF, DKIM or DMARC results. The only extra field is `sender_access` ("direct" on all 4 observed deliveries). There's no raw-MIME endpoint in SDK 0.7.19.
- `messages.get` marks inbound mail read. The trial runner restores the unread state.
- The buyer mailbox holds only 4 inbound messages, all from our own Inkbox seller fleet. None are from Gmail or Outlook.

**Fixed in code:**

| Severity | Issue | Workstream |
| --- | --- | --- |
| High | A footer "unsubscribe" turned a real quote into a global opt-out | F found, A fixed |
| High | An unauthenticated STOP (spoofable by a competitor who knows the deal code) suppressed a vendor in every workspace | F / A |
| High | Cross-tenant: "YES <wrong code>" fell back to the first open job in any workspace and texted its approver | B |
| High | Cross-tenant: `business_profile` showed other workspaces' deal ids, totals, menu text and reply excerpts | B |
| High | PAID revalidation failed after the 30-minute approval TTL, so every real manual payment slower than that was refused | D |
| Medium | A token-only sender could name an x402 payee or settle | A |
| Medium | An advance longer than the lease kept sending while another instance advanced the job | C |
| Medium | A Stripe `charging` row could be resumed past Stripe's 24-hour idempotency window (risk of a double charge) | C |
| Medium | "$550" or "mail delivery failed" in a quote was read as a hard bounce | F / A |
| Medium | An unconfirmed requirement ranked as met; recommendations ignored the workspace cap | D |
| Medium | Views showed a human-reported manual payment as "paid · Stripe test mode" | D |
| Medium | A delivery deadline was marked met when delivery was merely offered | D found, coordinator fixed |
| Medium | Attachment downloads were unbounded when metadata said size 0; a non-PDF named .pdf failed the whole read; 5xx downloads were permanent | A |
| Low | Outbox gaps (A2A, approval iMessage, `textHuman`); a call's transcript was lost after a crash between dialing and recording; replies to closed jobs sat pending forever; duplicate quarantine flags; the discover registry was shared across tenants | A, B, C |
| Ops | Documented `node scripts/*.ts` commands crashed (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) | E found, coordinator fixed |

**Open:**
- The reply token is a bearer secret: anyone holding a forwarded RFQ can pass as the vendor for quoting. They can't approve, pay or name a payee.
- Any new revision voids a pending approval, so a holder of the vendor's thread can force a re-approval. That's safe, but it's a nuisance vector.
- Spoofing a vendor's From address isn't stopped by DMARC, because Inkbox gives no verdicts.
- `ask` and `check_price` still mix tenants' brain data (Aarnav's lane, §11).

## 9. Real-world testing still required

1. **One consenting-mailbox email trial** (Gmail plus Outlook).
   - This is the first thing to run, because of the one open question: does the Message-ID that `messages.send()` returns equal the SES id that replies reference? If not, **every** external reply fails `not_in_our_thread`. The trial report flags it as MISMATCH.
   - It also checks token survival, quoting layouts, HTML parts, attachments and duplicate sends.
2. A real bounce, to see how `message.bounced` fires and its timing. Use an address you own that rejects mail, or an SES mailbox-simulator address if Inkbox allows it; ask first.
3. Claude extraction accuracy on the corpus: `HAGGLE_EVAL_LIVE=1 ANTHROPIC_API_KEY=… npx tsx apps/mcp/scripts/eval-report.ts`. It was not run, and nothing in the report measures Claude.
4. Whether Inkbox `call.ended` includes `remote_phone_number` for outbound calls (used by crash recovery), and whether A2A dedupes on `messageId`.
5. The first GitHub Actions run (needs a push), and `/ready` on a staging deployment.
6. Real vendor and human behaviour: reply rates, booking-confirmation wording, approval latency. These need pilot users.

## 10. What you need to do tomorrow

**In a web dashboard, now:**
- [ ] **Inkbox:** add `message.bounced` and `message.failed` to the buyer webhook subscription. `email-trial.ts check-subscription` reports what's missing, read-only.
- [ ] **Manufact (staging):** set `HAGGLE_ENV`, `HAGGLE_PROD_DB_HOSTS`, `HAGGLE_AI_MAX_CALLS_PER_JOB`, `HAGGLE_AI_DAILY_TOKEN_BUDGET`, optionally `HAGGLE_ALERT_WEBHOOK_URL` (Slack incoming webhook), and `HAGGLE_BUILD_SHA`.
- [ ] **GitHub:** after you push, confirm the CI workflow runs; consider making it a required check on `main`.
- [ ] **Supabase:** create a separate staging project, so `.env` stops pointing development at production.

**Provider questions:**
- [ ] **Inkbox:**
  - Expose per-inbound-message Authentication-Results: SPF result and domain; DKIM pass, signing domain and alignment; DMARC result, policy and header-From domain. Ideally also raw MIME or raw headers. `verifyExternalReply` already consumes these through `AuthEvidence`.
  - Is the send-time `messageId` final, or assigned later by SES?
  - Does `message.bounced` mean a permanent bounce only?
  - Per-workspace identities: a mailbox, number, 10DLC registration and iMessage handle per workspace, with per-identity hosted-agent instructions. What are the cost and limits?
  - Does A2A dedupe on `messageId`?
- [ ] **Anthropic:** confirm the rate and spend limits for the intended `HAGGLE_AI_*` budgets.

**Decisions for you and Aarnav:**
- [ ] The `packages/core` contract additions (§11): approval statuses, payment rail `manual`, compliance on quotes, and the quarantine and opt-out reasons.
- [ ] Brain tenancy: per-workspace profiles (migration 202 plus `contracts.ts` `workspaceId`), or aggregate-only sharing with k ≥ 3 workspaces.
- [ ] Should the global roster and `HAGGLE_ALLOWED_RECIPIENTS` stay reachable from every workspace?
- [ ] Timeout defaults: 24h booking confirmation, 48h payment instructions, 24h re-confirmation, 7-day quote validity.
- [ ] Is `job.state = paid` acceptable at `human_reported_paid`, or should core get a new state?
- [ ] Who runs `job-ops`, and how often, during the pilot.

**Needs a real external test environment:**
- [ ] A consenting test mailbox on Gmail and one on Outlook. List them in `HAGGLE_EMAIL_TRIAL_MAILBOXES`, then run `HAGGLE_EMAIL_TRIAL=1 npx tsx apps/mcp/scripts/email-trial.ts send --to <addr> --run <dir outside repo> --i-own-this-mailbox`, reply through the printed scenarios, then run `collect`.
- [ ] A staging deployment with migrations 103–111 applied (backup first) and the ledger backfilled. Then run `apps/mcp/scripts/smoke.ts` against it.

**Legal and payment:**
- [ ] Vendor consent: every pilot vendor must be added with `workspace-admin.ts add-vendor --consent "<who agreed, how, when>"`. Decide what consent record is enough.
- [ ] The outreach messages disclose the AI assistant. Have someone check the opt-out wording and CAN-SPAM-style footer requirements for commercial email in the pilot's region.
- [ ] The manual payment handoff means Haggle never holds money. Confirm the terms of service say so, along with who bears the risk on a vendor no-show after a customer-reported payment.

## 11. Checklist for Aarnav

- [ ] **Approval card** (`apps/mcp/views/approval`):
  - When `payment.rail === "manual"`, show `reason` and `purchase.summary`.
  - Never show "paid · Stripe test mode" for manual. `human_reported_paid` should read "Customer reports paying (not verified)", and `settled_verified` "Business confirmed receipt".
  - Hide Pay for manual; show "Pay the business directly after it confirms the booking, then reply PAID <code>".
- [ ] **Deal board / deal-live:**
  - Payment line stages: `awaiting_vendor_confirmation` reads "Waiting for the business to confirm, don't pay yet".
  - Show `purchase.instructions.text` and `vendor_reply.text` as plain untrusted text: links not clickable, with "verify independently" when `has_link`.
  - Per-quote `compliance` (unconfirmed vs doesn't meet). Show `best_available_quote_id` as "closest, not recommended" and `freshness` as stale, re-confirmation requested.
  - Show `operator_attention`, `late_reply` and `text_held` events.
  - Optionally show the quarantine `explanation`/`action`. `last_event` already carries a ≤100-character `board_line`.
- [ ] **Brain** (`packages/brain`, a 2xx migration):
  - Workspace tenancy. Either (a) `brain_profiles.workspace_id` with key `(workspace_id, business_id)`, plus a `workspaceId` argument on `learnFromReply`, `estimate`, `checkPrice`, `negotiationHints` and `getProfile` (a `contracts.ts` change); or (b) per-workspace profiles plus a numeric-only cross-tenant aggregate that is used only when k ≥ 3 workspaces contribute.
  - `learnFromReply` must skip `meta.simulated`, `unreliable_extraction`, heuristic-source and `sender_trusted === false` replies.
- [ ] **`packages/core` diff to agree with Yash:**
  - `ApprovalStatus` adds `awaiting_vendor_confirmation`, `awaiting_human_payment` and `human_reported_paid`.
  - Approval gains `payment_rail` (`stripe|x402|manual`), `purchase_stage` and `money_verified`.
  - DealBoard quotes gain `compliance {status, issues[]}`; DealBoard gains `best_available_quote_id` and `purchase`.
  - `contracts.ts` `PaymentStatus` gains `human_reported_paid` and `settled_verified`, plus rail `manual`.
  - Optional `QUOTE_FLAGS` additions: `unreliable_extraction`, `identity_unverified`, `opt_out_unverified`.
  - `ReplyMeta.extraction: "claude" | "heuristic"`.
- [ ] **Stale docs he may own or share:**
  - README step 3 still lists only migrations 100/101/102/200/201.
  - The README deploy command is wrong.
  - `apps/mcp/README.md` still mentions `HAGGLE_AUTH=required`.
  - `apps/mcp/CLAUDE.md` still has the pnpm build line.
  - `packages/engine/CLAUDE.md` still mentions x402 and email-only.
  - `docs/buyer-runbook.md` still describes Primitive, x402 and pnpm.
  - `scripts/acceptance/live-readonly.mjs` still expects `get_quotes` to be view-bound.

## 12. Next five highest-impact tasks

1. **Run the consenting-mailbox email trial** and fix whatever it shows, starting with the send-time Message-ID question. Nothing else matters until a real Gmail reply becomes a quote.
2. **Stand up staging:** a separate Supabase project, migrations 103–111 plus the ledger, a Manufact staging server with `HAGGLE_ENV=staging`, the webhook subscription with bounce events, and `smoke.ts` green. Then push and get CI green.
3. **Agree the `packages/core` contract additions with Aarnav** and ship the approval-card and deal-board handoff UI. Today the honest states exist only in `reason` and `next` text.
4. **Run one end-to-end pilot deal with a friendly real vendor** (consent recorded) on the manual rail: real request → email → quote → approval by text → booking confirmation → customer pays directly → PAID. Measure each step's latency and every human intervention.
5. **Compact `get_quotes`** back toward the ~1,500-token target, and **ask Inkbox for Authentication-Results**. Agents pay for every token today, and authenticated mail is the only way past the reply-token limitation.
