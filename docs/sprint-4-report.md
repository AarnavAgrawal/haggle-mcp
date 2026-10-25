# Sprint 4 report: real-world pilot readiness (2026-10-22)

Branch `yashnil`. Baseline: `ef122fe`, which was pushed to `origin/yashnil` at the start of the sprint. Draft PR #1 (https://github.com/AarnavAgrawal/haggle-mcp/pull/1) is green on GitHub Actions for `ef122fe`.

The sprint's integrated work is committed locally on top of `ef122fe`. **It is not pushed yet**: GitHub push protection blocked the push (§7, §11).

Nothing was deployed, no live database was migrated, and no live provider setting was changed. No real email, text, call or payment was sent. **Every result below is from simulated providers, in-memory stores and throwaway Postgres databases.**

## 1. Executive summary

Six workstreams (A to F) ran in parallel, each in its own git worktree with its own files and migration number (112, 113, 115, 116, 117; 114 was not needed). The coordinator merged them into `yashnil`, resolved conflicts, and wired together the pieces that crossed workstreams.

Progress along the target journey (customer connects an agent → requests catering → authorized vendors contacted → real-format quotes → extraction and comparison → independent human approval → confirmed booking → transparent payment handoff → knowledge kept):

- **Onboarding.**
  - One `workspace-create` command onboards a pilot workspace.
  - `workspace-admin show` is a PASS/FAIL readiness check that prints the fix for each failure.
  - `deal` with no vendor names now uses the workspace's own consented vendors. Before, it used the server's demo roster, so a pilot workspace couldn't start a deal without naming every vendor.
  - Requests in ordinary language (headcount, date, time, place, delivery, dietary needs, budget) are read and carried through every stage.
- **Vendor email.**
  - The email trial runner has `validate` and `dry-run` modes that contact nothing, plus an offline replay of captured replies through the real webhook-to-quote path.
  - 20 replayable reply fixtures in Inkbox's format.
  - Operators can review held mail and release or reject it, with the decision recorded permanently (migration 112).
  - Reply tokens are proven to work only for their own deal and vendor.
  - Delivery status is recorded per message.
  - Vendors are contacted only in business hours: Monday–Saturday 08:00–19:00 Pacific by default, with at most two reminders.
  - Each vendor's contact status (bounced, opted out, reply held, deferred) is shown on the board.
- **Comparison.** Quotes that offer a different date, miss the delivery window or come from a different business are flagged and can't be approved. Every quote carries a one-line reason why it was or wasn't selected. The compact `get_quotes` output dropped from 14,569 to under 10,000 characters for six quotes.
- **Approval and booking.**
  - Vendors who reply by text now confirm bookings by text.
  - Confirm-only approvals need the vendor's written confirmation.
  - A booking "confirmed" by a sender proven only by the reply token needs the approver's `BOOKED <code>` text.
  - A "payment received" from such a sender is never recorded as verified.
- **Security.**
  - `call_back` needs the approver's coded text and the callee's consent; a model-only call is never placed.
  - A Stripe charge in progress counts as "money in flight".
  - Simulated, keyword-fallback, quarantined or unverified quotes can never carry money.
  - The shared phone line no longer leaks deal codes across workspaces.
  - Database rules make payment states final (migration 115).
- **Reliability.**
  - A lease-renewal error or an ambiguous provider failure never marks a vendor bounced or escalates to a phone call.
  - The inbound reconciler catches up after long outages (migration 117).
  - Indexes make the per-email vendor lookup about 230 times faster on a seeded 10,000-job database.
  - Request-size and rate limits are in place.
  - Log redaction is broader, events turn into alerts, and `ops-report` and safer `job-ops` give operators a way to act.
  - **The live server now actually runs stuck-job recovery.** Before, it never did.
- **Operations.**
  - An environment-variable manifest drives config validation and has a coverage test.
  - The migration ledger detects migrations that are missing or unexpected in the database.
  - A connection-pool gate fixes the earlier pool-exhaustion incident class.
  - There's a launch-gate script, a read-only production smoke mode, a secret scan in CI, and backup, restore and incident runbooks.
- **Evaluation.**
  - Per-field and money-error scoring on a 59-case simulated corpus.
  - A raw-email baseline to compare against.
  - An opt-in live Claude runner with a hard spending cap. It was not run.
  - Traction and abandonment-funnel queries that exclude simulated and test data (migration 116).

**The pilot is still blocked on the same real-world items as last sprint, plus one new one:**
- No real Gmail or Outlook reply has been ingested.
- Inkbox exposes no sender-authentication results.
- The bounce events aren't enabled in the Inkbox subscription.
- No staging environment exists.
- **New:** the push is blocked by GitHub push protection, and needs your decision (§11).

## 2. Features completed, by workstream

**A: real email and vendor communication**
- `apps/mcp/scripts/email-trial.ts`, `email-trial-lib.ts` and the new `email-trial-replay.ts`:
  - New `validate` and `dry-run` commands; nothing is contacted or written.
  - `send` refuses a run folder that was already used, and re-checks all three gates just before it sends.
  - `collect` reports what the real pipeline did with each reply.
- Checked against the installed SDK types; two bugs fixed:
  - A reply-all with Haggle in Cc was dropped (`addressedToBuyer`).
  - `check-subscription` missed mixed subscriptions. It now also reports the buyer's inbound filter mode.
- Fixtures: `packages/engine/tests/fixtures-email/` (20 Inkbox-format replies), with `apps/mcp/tests/emailFixtures.test.ts`.
- Operator review of held mail: `inbound/quarantineReview.ts` and `apps/mcp/scripts/quarantine.ts` (`list`, `show`, `release`, `reject`), plus migration 112.
  - A release becomes trust `operator_verified`, which counts as continuity only. It can produce a quote, but it can't confirm a booking or name a payee.
  - A database trigger makes a recorded release the only way a held message can become trusted.
- Reply tokens: proven scoped to one deal and vendor. **Fixed:** an outgoing email could carry another business's token.
- Delivery status (`deliveryStatus.ts`): recorded per message. Webhook and sweep together have a single effect.
- Contact hours and reminders: `workflow/contactWindow.ts`, tested with a fake clock across both DST changes. Live wiring is by the coordinator.
- Per-vendor contact status: `inbound/contactStatus.ts`.
- Follow-up checks: `parsing/termsCheck.ts` raises `date_mismatch`, `delivery_window_mismatch` and `identity_mismatch`, each blocking approval. The keyword reader now flags tax-excluded totals (`tax_excluded`) and added gratuities (`fees_unclear`).
- Docs: `docs/email-trial-checklist.md`.

**B: onboarding and the purchasing workflow**
- Text vendors: `ingestBusinessIMessage` and the SMS vendor branch now run the booking-reply reader. Booking requests go by text.
- Confirm-only approvals reach `confirmed` only on the vendor's written yes. Phone-only and A2A vendors are refused up front. Migration 113 adds this.
- `ranking/selection.ts`: per-quote `selection {status, reason}`. A stale quote is never recommended. The price comparison in the value explanation is now between the two quotes compared (pairwise).
- `workflow/requestNormalize.ts`: reads plain-language requests. Facts are asserted at the RFQ, extraction, comparison, approval text, booking request, handoff and closing note.
- Stages:
  - New `order_confirmed` and `handoff_refused`.
  - Stalled stages get a specific next step.
  - Manual-rail texts no longer say "PAY charges it".
- D's patches: a simulated source can't be approved on a live deal, and the payment check re-runs before the booking or handoff ask.
- A's thread-only rule: the `BOOKED <code>` acknowledgement, and no verified receipt from such a sender.
- MCP tools (`apps/mcp/index.ts`): `deal` takes plain-language fields and returns `UNREADABLE_REQUEST` with the unreadable detail named. Descriptions were rewritten for honesty (E's copy fixes), and `cancel_deal` says exactly what the booked vendor was told.
- Operator scripts: `workspace-create.ts` prints the connection details once, then the readiness check. `workspace-admin.ts show` is the PASS/FAIL check.
- Docs: `docs/pilot-onboarding.md` and `docs/agent-workflow-guide.md`. The client table marks Claude/ChatGPT custom connectors as unverified.
- Acceptance test: `apps/mcp/tests/acceptancePilot.test.ts` (SIMULATED, see §5).

**C: infrastructure, CI and deployment**
- CI (`.github/workflows/ci.yml`):
  - adds a dependency-tree check (`npm ls --all`) and a secret scan;
  - `verify-migrations.sh` applies **each 112+ migration alone on 100–111**.
  - Reproduced from fresh clones with `npm ci`. CI runs Node 22.x (22.23.3 on GitHub); the local Node is 22.21.0, which warns only.
- Environment variables:
  - `apps/mcp/src/envManifest.ts` (84 variables) drives `config.ts`.
  - `docs/env-manifest.md` is generated; `envManifest.test.ts` fails on any unlisted or invented variable.
  - Settings that used to fall back silently (payment cap, `HAGGLE_PAYMENTS`, `HAGGLE_EXTERNAL_SENDERS`, among others) are now startup errors.
- Ledger (`ops/migrations.ts`): adds `unexpected` (in the database but not the repo) and file-name checks. `/ready` reports `database_ahead`.
- Connection pool: `store/poolGate.ts` bounds in-flight queries to the pool size with a queue timeout (`PoolBusyError`). `/ready` shows pool use. In a load test, 60 pollers peaked at 4 in flight.
- `apps/mcp/scripts/launch-gate.ts`: fails closed and never prints values.
- `smoke.ts --live-readonly`: an allowlist of read-only tools plus a hard denylist.
- `scriptsDbGuard.test.ts`: every script that touches a database must import the production-DB guard.
- `secret-scan.ts`: scans docs and READMEs.
- Docs: `docs/deployment.md` §4 (ordering and rollback for 100–117) and §9 (the dashboard checklist), `docs/backup-restore.md` (the restore drill was run locally between two throwaway containers), and `docs/runbook-incidents.md`.

**D: multi-tenant security and transaction integrity**
- `workflow/callbackAuth.ts`:
  - `call_back` in live/out-of-band mode texts the approver a one-time `CALL <code>`; only the job's own approver can authorize.
  - Consent: a workspace vendor with recorded consent, a simulated vendor, or the business that itself called. Never a suppressed number.
  - Wrong codes lock after 5; authorizations expire after 30 minutes.
  - Operator path: `operatorCallback`, engine-only for now.
- `charging` counts as money in flight, so cancel and approval-void are refused during a charge.
- `paymentVerdict` refuses money for keyword-fallback, quarantined, unverified, wrong-job or simulated-on-live sources.
- `WorkspaceEngine` never accepts a client form or view code as approval on a live job.
- Shared line:
  - an inbound call from a number on several deals is held for audit instead of dropped;
  - the "which deal?" text no longer leaks other workspaces' deal codes;
  - operator-only `releaseHeldText`.
- The shared brain now learns only from verified, Claude-read replies.
- Migration 115: payment states are final; a payment settles only from `sent` or `charging`; terms are immutable.
- Tests: `packages/engine/tests/security.test.ts` (33) and `apps/mcp/tests/security.tenancy.e2e.test.ts`. The latter has a reviewed tool list (`REVIEWED_TOOLS`), so a new tool fails until reviewed.

**E: evaluation and output quality**
- `apps/mcp/src/views.ts` `compactBoard`: the default board is compact; `get_quotes({detail:true})` returns the full one. `wait_for_update` returns at most 12 updates.
- Corpus f2: 59 cases, 49 independently meaningful.
- Scoring and runners:
  - `eval/fields.ts`: per-field scoring, with money errors split into shown and approvable.
  - `eval/baseline.ts`: the raw-email baseline.
  - `eval/liveBudget.ts`: the opt-in live Claude runner with a hard USD cap (not run).
- Traction: migration 116 (test marks plus views of real jobs and real vendors), `ops/traction.ts` and `scripts/traction.ts`. Includes an abandonment funnel built from job events.
- Docs: `docs/eval-report.md` (regenerated; "Live evidence: none yet"), `docs/pilot-usability.md` and `docs/demo-script.md` (mock mode only).

**F: reliability and operational control**
- Lease and send safety:
  - A lease-renewal error blocks the send (`LeaseLostError`).
  - An ambiguous provider failure (409, sent but not recorded) is recorded `unknown`, reviewed and never re-sent.
  - An A2A task after its request went out is never re-sent.
  - Nothing is re-sent under an idempotency key more than 6 days old.
- Recovery flags an approval the human never received, an unconfirmed booking and overdue payment instructions.
- Operator `hold`, `resume` and `fail-safe-close`, the last with a truthful text to the human.
- Migration 117: reconciler high-water marks, four indexes, and an indexed `findBusinessCandidates`. `live/reconcileWindow.ts` catches up after outages; a 2-day outage was tested.
- `apps/mcp/src/limits.ts`: MCP body cap 256 KiB, webhook body cap 2 MiB, and a per-credential tool-call rate limit of 120/min with bursts of 30, on in live mode.
- `live/log.ts`: masks card numbers, IBANs, account and routing numbers and SSNs; drops message bodies and payment instructions by field name.
- `live/alerts.ts` `alertingLog`: turns engine events into deduplicated alerts.
- Operator tooling:
  - `ops/report.ts` and `scripts/ops-report.ts`: read-only, per workspace.
  - `job-ops` retries re-check suppression, authorization and key age.
- Docs: `docs/operator-recovery.md`. Failure drill: `tests/failureDrill.test.ts`.

**Coordinator (integration)**
- Board `vendor_contact`: notable contacts only, built from rows `getQuotes` already reads. A's duplicate implementation was dropped.
- Board `selection` and `purchase.order/must_haves/confirm_only`: B's fields fill E's slots. In the compact board, a selectable quote's reason stays in the value explanation, and reasons are clipped to 80 characters, keeping the board within the 10,000-character budget.
- `live.ts` now:
  - runs `recoverStuck` every ~2 minutes (**it never ran in production before**);
  - routes engine events through `alertingLog`;
  - turns on the contact window (`HAGGLE_CONTACT_HOURS=off` disables it).
- `mapInkboxError`: HTTP 409 / idempotency conflict maps to an ambiguous send. The test fails without the fix.
- Redaction of `sb_secret_`/`sb_publishable_` keys, `AIza` Google keys and Slack webhook URLs (C's three known gaps).
- 30 s timeouts for two Postgres tests (about 4 s each) that flaked at 5 s under load. No assertion changed.
- Tests that encoded the old, weaker behaviour were updated:
  - simulated quotes are now refused at approval, not only at payment;
  - the acceptance test reads the detailed board;
  - known-gap tests that the fixes closed were flipped to regular tests.

## 3. Before and after (vs sprint 3, `ef122fe`)

| Area | Sprint 3 (`ef122fe`) | Sprint 4 |
| --- | --- | --- |
| Starting a pilot deal | `deal` without names used the demo roster | Workspace's consented vendors; plain-language request; readiness check for operators |
| Text vendors | Booking `not_in_writing` | Booking confirmed by text; confirm-only gated |
| Token-only "confirmed" / "received" | Treated as authenticated | Needs `BOOKED <code>`; never a verified receipt |
| Quote for another date / window / business | Approvable (eval c42/c43/c46) | Flagged, not approvable |
| `get_quotes` size (6 quotes) | 14,569 chars | ≤ 10,000 compact (full with `detail:true`) |
| `call_back` | Model-only call placed in out-of-band demo mode; form or board could authorize in live | Approver's `CALL <code>` + callee consent |
| Money from simulated / heuristic / held replies | Partially guarded | Refused at approval and at every payment path; DB states final |
| Stuck-job recovery on the live server | Never ran (only via `/internal/tick`) | Every ~2 min |
| DB stall or 409 during send | Vendor marked bounced; possible phone escalation | Recorded unknown, reviewed, never re-sent or escalated |
| Outage over 6 h | Replies whose webhooks failed were lost | Catch-up from a stored high-water mark |
| Pool exhaustion | Unbounded postgres.js queue | Gate + queue timeout; `/ready` shows pool |
| Config typos | Silent fallback (e.g. cap → 500000) | Startup error naming the variable |
| Operator visibility | `job-ops` | + `ops-report`, `quarantine`, `launch-gate`, alerts from engine events |
| Tests | 1,059 unit / 762 PG / 3 ledger | 1,378 unit / 938 PG / 4 ledger |

## 4. Commits and changed files

First-parent history on `yashnil` since `ef122fe`:

| Commit | What |
| --- | --- |
| `759d34a` | Merge S4-D: verified callbacks, money in flight, payment-source guards, shared-line attribution, 115 |
| `9ba7aa5` | Merge S4-E: compact board, per-field eval, raw-email baseline, live eval runner, traction (116) |
| `8b7ef7d` | Merge S4-A: email trial modes and replay, fixtures, quarantine review (112), token scoping, contact hours |
| `5efa6c2` | [integration] board `vendor_contact` |
| `f94f9ac` | Merge S4-A follow-up: date/window/identity mismatch checks, keyword tax/gratuity flags |
| `dda34b6` | Integration fix on that merge: one `vendor_contact` implementation (it reuses the merge's title) |
| `692e3e7` | Merge S4-B: onboarding, plain-language deals, roster default, text-vendor booking, confirm-only gate, selection (113) |
| `4e5255f` | Merge S4-C: env manifest, ledger database-ahead, pool gate, launch gate, read-only smoke, docs |
| `15de813` | Merge S4-F: lease/ambiguous-send safety, catch-up (117), indexes, limits, redaction, ops-report |
| `54a6b31` | [integration] redaction gaps; explicit timeouts for two slow PG tests |
| `e099188` | [integration] synthetic test secrets built from two halves (push protection) |
| HEAD | Sprint wrap-up: this report, readiness Pass 4, checklist |

- The workstream branches hold 46 non-merge commits, each prefixed `[S4-X]` (`git log --no-merges ef122fe..yashnil`).
- `git diff --stat ef122fe..HEAD`: 163 files changed, about 14,100 insertions and 470 deletions.
- New source modules and migrations are listed in §2; new docs are under `docs/`.

## 5. Test results and coverage limits

Final runs on the fully merged tree, with machine load dropped to about 6:

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run build -w @haggle/mcp` | OK |
| `npx vitest run` | **1,378 passed, 21 skipped** (Postgres-gated or memory-only by design), 0 expected-fail, 0 failed |
| `scripts/verify-migrations.sh` | OK: 100–106, 108–113, 115–117 apply; all SQL assertion files pass; each 112+ migration applies alone on 100–111 |
| `PGTEST_PORT=… scripts/test-postgres.sh` | **938 passed, 1 skipped** (a 3-day ops-report run, memory-only by design) + **4 ledger** tests |
| `secret-scan.ts` (docs) | clean |
| Operator scripts load under plain `node` | yes (`scriptsPlainNode.test.ts`: workspace-admin, workspace-create, job-ops, migrations, traction, ops-report) |
| GitHub Actions | green on `ef122fe` (push run 39745081806, PR run 39745107933). **Not yet run on sprint-4 code**, because the push is blocked |

Flakiness seen during the sprint:
- Under machine load of 30–200 from six agents testing at once, `apps/mcp/tests/config.test.ts` (it spawns scripts) and two Postgres tests timed out at 5 s.
- They passed when rerun alone and in the final quiet runs.
- The two Postgres tests now have explicit 30 s timeouts; `config.test.ts` had its spawn budgets raised by C.

**Acceptance scenario (SIMULATED)**, `apps/mcp/tests/acceptancePilot.test.ts`:
- It runs the real MCP endpoint in-process with bearer auth and the live approval policy, over simulated providers.
- Steps: operator onboarding with 3 consented vendors, a plain-language catering request, a vendor question answered, a cheaper noncompliant quote, approval by the approver's text, `BOOKED`, the vendor's booking confirmation, the deal resumed from a second client session, then PAID.
- Measured: **12 agent tool calls** (bounded at ≤ 12) and **5 human steps** (bounded at ≤ 5).

**Coverage limits:**
- No live Inkbox, Anthropic, Stripe, Supabase or Manufact call was made. All extraction numbers come from the deterministic reader or the label oracle.
- The live Claude runner exists but was not run.
- `delivered` contact status is never `true`, because Inkbox's "delivered" events aren't consumed.
- Rate limits, AI counters and alert dedupe are in memory, per process.
- Plain-language dates resolve in UTC, not the workspace's timezone.

## 6. Security issues found and resolved

| Severity | Issue | Fixed by |
| --- | --- | --- |
| High | A model-only `call_back` placed a callback in out-of-band demo mode; in live, a form or board tap could authorize a call with no callee-consent check | D |
| High | Cancel could proceed while a Stripe charge was in progress | D |
| High | The live server never ran stuck-job recovery | F found, coordinator wired |
| High | A lease-renewal stall, or a DB write failing after Inkbox accepted, marked a vendor bounced and could escalate to a phone call | F |
| Medium | A simulated reply on a live job could be approved and charged, or recorded PAID | D + B |
| Medium | A live job could be approved via form or view code if the engine config allowed it | D |
| Medium | The "which deal?" text leaked other workspaces' deal codes | D |
| Medium | The shared brain learned from unverified, heuristic and simulated replies (cross-tenant poisoning) | D |
| Medium | A token-only sender's "confirmed" or "received" counted as authenticated | A found, B fixed |
| Medium | An outgoing email could carry another business's reply token | A |
| Medium | A 409 idempotency conflict counted as a bounce | F + coordinator |
| Medium | A quote for another date or delivery window, or signed by another business, was approvable | A |
| Medium | A cap lowered after approval didn't stop the handoff ask | D found, B fixed |
| Medium | `deal` with no names used the server's demo roster for a pilot workspace | B |
| Medium | Silent config fallbacks (payment cap → 500000; a typo in `HAGGLE_PAYMENTS` or `HAGGLE_EXTERNAL_SENDERS` changed the mode) | C |
| Medium | Unbounded DB query queue (pool-exhaustion incident class) | C |
| Low | A reply-all with Haggle in Cc was dropped; `check-subscription` missed mixed subscriptions | A |
| Low | Redactor gaps: card numbers, IBANs, account numbers, SSNs (F); Supabase, Google and Slack secrets (C, coordinator) | F / coordinator |
| Low | Payment states could change after failing or settling (no DB rule) | D (115) |
| Low | Ambiguous inbound calls were dropped with no audit trail | D |

**Still open:**
- The reply token is a bearer secret: anyone holding a forwarded RFQ can quote as the vendor. Such a sender can't approve, pay or confirm a booking.
- Any new revision voids a pending approval, so a holder of the vendor's thread can force a re-approval.
- Without Inkbox authentication results, spoofed From addresses rely on the token plus thread checks.
- If the lease is lost exactly while the "all quotes are in" text goes out, it isn't re-sent (F, in B's region; the board still shows ready).
- The `BOOKED` code isn't extracted for routing across workspaces, so such a text is held (the safe side).

## 7. Migrations and deployment

| Migration | Adds | Compatibility |
| --- | --- | --- |
| `112_engine_inbound_review.sql` | `messages.delivery_status(_at)`; append-only `quarantine_resolutions`; a trigger that lets an untrusted inbound message become trusted only through a recorded release | Additive. The trigger constrains updates to `messages.sender_trusted` |
| `113_engine_purchasing.sql` | Confirm-only bookings may carry `payment_cents = 0`; paying bookings and handoffs still need an amount | Relaxes one 110 check for confirm-only, scoped by action |
| `115_engine_security.sql` | Payment states final; settle only from `sent`/`charging`; terms immutable; a handoff becomes `human_confirmed` only from open | **Behavioural.** Any existing payment row in an odd state can no longer be updated. Check live rows before applying |
| `116_engine_analytics.sql` | `analytics_test_marks` (append-only); security-invoker analytics views | Additive |
| `117_engine_ops.sql` | `reconcile_cursors`; 4 indexes | Additive. Build the indexes `concurrently` on a large production table if needed (not done in the file) |

- **Ordering:** each of 112–117 applies alone on 100–111, and CI enforces this. The numbers are ordered, 107 and 114 are unused, and the ledger globs the folder.
- **Live database:** per the earlier audit, 103–106 were never applied there. The production rollout is backup, then 103–117 in order, then `migrations.ts backfill --through 106 --confirm` and `record` (docs/deployment.md §4).
- **Rollback limits:** 103 drops and recreates CHECKs, and 115's triggers are behavioural, so undoing either needs a restore (§4 of the deployment doc).
- **Server environment changes on deploy:**
  - Contact hours are on by default in live mode (`HAGGLE_CONTACT_HOURS=off` to disable).
  - The rate limit is on in live mode.
  - New optional variables are listed in `docs/env-manifest.md`.
  - Startup now fails on malformed caps or mode values that used to be silently ignored. Run `launch-gate.ts --target staging --env-file <file>` before deploying.
- **Push status:**
  - GitHub push protection rejected the push. It flagged synthetic Stripe and Slack values used as redaction-test inputs in C's commit `76fe40f` (now inside merge `4e5255f`) and in `54a6b31`.
  - The current file builds them from two halves (`e099188`), but the earlier local commits still contain them.
  - Rewriting those unpushed commits was blocked by this session's permission policy, and I did not use GitHub's bypass links.
  - `origin/yashnil` is still at `ef122fe`. See §11.

## 8. Remaining production blockers, by severity

1. **Critical: no real-mail evidence.**
   - No real Gmail or Outlook reply has been ingested.
   - Untested: whether the Message-ID returned at send time equals the SES id that replies reference. If it doesn't, every external reply fails `not_in_our_thread`.
   - Next step: run `docs/email-trial-checklist.md` with consenting mailboxes.
2. **Critical: bounce events not subscribed.** The Inkbox subscription still lacks `message.bounced` and `message.failed`, so bounces are seen only by the reconciler's sweep.
3. **High: no sender authentication from Inkbox.** No SPF/DKIM/DMARC results, which is why the `BOOKED <code>` workaround exists. Ask Inkbox.
4. **High: no staging environment.** No separate Supabase project, staging Manufact server or staging Inkbox identity. The `.env` file still points development at production.
5. **High: live database far behind.** Migrations 103–117 aren't applied to the live database, and there's no verified backup or point-in-time-recovery plan.
6. **High: push blocked.** Sprint-4 code can't reach GitHub or CI until the push-protection hits are resolved (§11).
7. **Medium: views and shared contracts.** They don't show the new stages yet: booking awaiting confirmation, `BOOKED`, `handoff_refused`, selection reasons, flags (Aarnav, §9).
8. **Medium: brain tenancy.** Profiles are still shared across workspaces: `ask`, `check_price`, the board's price check and negotiation hints mix tenants (Aarnav). *Since fixed (2026-10-25): `202_brain_tenancy`, one brain per workspace, no `contracts.ts` change.*
9. **Medium: one shared Inkbox identity and phone line for every workspace.** Routing is safe but ambiguous texts are held. A held text can be released by an operator only through the engine; there's no CLI yet.
10. **Low: per-process limits and counters.** Rate limits, AI limits and alert dedupe aren't shared across replicas.

## 9. For Aarnav (views, brain, shared contracts)

- [ ] **Approval card and deal board:**
  - Stage text for `awaiting_vendor_confirmation`, plus "check with the vendor, then reply BOOKED <code>" after a thread-only confirmation.
  - Stage text for `order_confirmed`, `handoff_refused`, `human_reported_paid` ("customer reports paying, not verified") and `settled_verified`.
  - Show `purchase.order` and `purchase.must_haves`.
  - Show per-quote `selection.reason`, `vendor_contact` (bounced, opted out, held, deferred), and the new flags: `date_mismatch`, `delivery_window_mismatch`, `identity_mismatch`, `fees_unclear`, `tax_excluded`.
- [ ] **Deal-board refreshes:** have the view call `get_quotes({job_id, detail:true})`. The compact default could then shrink further (E's suggestion). The view must not depend on `freshness.valid_until`, which is now optional.
- [ ] **`packages/core` proposals** (needs both of you):
  - `ApprovalStatus` gains `awaiting_vendor_confirmation`, `order_confirmed` and `handoff_refused`.
  - DealBoard gains `selection`, `vendor_contact` and `purchase.{order, must_haves, confirm_only}`.
  - `QUOTE_FLAGS` gains `date_mismatch`, `delivery_window_mismatch`, `identity_mismatch` and `fees_unclear`.
  - `ReplyMeta.extraction: "claude" | "heuristic"`.
- [x] **Brain tenancy** (done 2026-10-25 as option (a), `202_brain_tenancy`; scoped by brain instance per workspace instead of a `workspaceId` argument, so no `contracts.ts` change):
  - Add a `workspaceId` argument to `learnFromReply`, `estimate`, `checkPrice`, `negotiationHints` and `getProfile` (a `contracts.ts` change).
  - Then either `brain_profiles.workspace_id` keyed `(workspace_id, business_id)` in a 2xx migration, or per-workspace profiles plus a numbers-only aggregate used only when at least 3 workspaces contribute.
  - The engine already skips unverified, heuristic and simulated-on-live replies. The brain should honour `meta.extraction` too.
- [ ] **Demo fleet:** the hard-coded `valid_until: "2026-10-21"` in `packages/engine/src/sim/fleet.ts` (Yash's file, noted by E) makes every demo quote stale. Derive it from the event date.
- [ ] **Shared README:** line 11 still says "pays, in Stripe test mode". E's suggested replacement is in its report.

## 10. Real-provider checks not yet performed

These are all assumptions in the code until checked:
- **Inkbox email:**
  - Whether the send-time Message-ID is final.
  - What `message.bounced` and `message.failed` payloads and timing look like.
  - Whether bounces are permanent only.
  - What status code an idempotency conflict returns, and whether a 5xx is ever returned after acceptance.
  - Whether the 7-day key replay applies to text and iMessage too.
  - Whether `endDatetime` is honoured on list calls.
  - Real webhook payload sizes.
  - The buyer identity's inbound filter mode.
- **Inkbox calls, texts and A2A:**
  - Whether `call.ended` includes `remote_phone_number` for inbound and outbound calls.
  - `CALL`, `BOOKED`, `PAID` and `YES` codes on a real SMS line.
  - A real text vendor's booking reply.
  - Whether A2A dedupes on `messageId`.
- **Claude extraction:**
  - Accuracy on the corpus (opt-in runner, needs a key and a spending cap).
  - The live schema-size limit before adding offered-date and signed-as fields to the Claude schema.
- **Clients:** whether Claude and ChatGPT accept the connector URL, and how `get_quotes` renders.
- **Supabase:** backup retention and PITR on the current plan; the restore procedure against a real backup.
- **GitHub Actions** on sprint-4 code, after the push.

## 11. What I need from you

**Decide now, to unblock the push.**
GitHub push protection flagged synthetic test values: fake Stripe `sk_live_`/`sk_test_`/`rk_live_` strings and a fake Slack webhook URL, used as inputs to the redaction test, in local commits `76fe40f` and `54a6b31`. Pick one:
- [ ] **(a)** Mark them as false positives with the "allow secret" links GitHub printed on the rejected push (4 links). Then I can push as is.
- [ ] **(b)** Authorize me to rewrite only the **unpushed** local commits (`git filter-branch` over `origin/yashnil..yashnil`). The current file already builds the values from two halves, and no force-push is needed, because `origin/yashnil` stays an ancestor.

**Dashboard actions you can do immediately:**
- [ ] **Inkbox:** add `message.bounced` and `message.failed` to the buyer webhook subscription (`docs/email-trial-checklist.md` §1). Check the buyer's mail inbound filter isn't `whitelist`.
- [ ] **Supabase:** create a staging project, and check the production backup and PITR plan.
- [ ] **Manufact:** create a separate staging server.
- [ ] **GitHub:** branch protection on `main` requiring "CI / verify" (docs/deployment.md §9).
- [ ] **Slack:** create an incoming webhook for `HAGGLE_ALERT_WEBHOOK_URL` (staging first).

**Provider questions:**
- [ ] **Inkbox:**
  - Per-message Authentication-Results (SPF, DKIM, DMARC), or raw headers.
  - The send-time Message-ID.
  - Bounce semantics.
  - The idempotency-conflict code.
  - `remote_phone_number` on `call.ended`.
  - A2A `messageId` dedupe.
  - Per-workspace identities and numbers: cost and limits.
- [ ] **Anthropic:** limits for the intended `HAGGLE_AI_*` budgets; the structured-output schema-size ceiling.

**Decisions for you and Aarnav:**
- [ ] The `packages/core` additions (§9) and brain tenancy option.
- [ ] Is `BOOKED <code>` acceptable UX for Gmail and Outlook vendors until Inkbox exposes sender authentication?
- [ ] Contact-hour defaults (Mon–Sat 08:00–19:00 Pacific, at most 2 reminders, first after 24 business hours).
- [ ] Should vendors on `HAGGLE_ALLOWED_RECIPIENTS` count as consenting to callbacks? Today they don't.
- [ ] Is a recorded consent string enough for a pilot vendor?

**Needs a real external test environment:**
- [ ] Consenting Gmail and Outlook mailboxes, then `email-trial.ts` validate → dry-run → send → replies → collect.
- [ ] Staging with migrations 103–117 (backup first), `launch-gate.ts --target staging`, then `smoke.ts --live-readonly`.
- [ ] One friendly real vendor (consent recorded) for an end-to-end manual-rail deal.

**Legal and payment:**
- [ ] Commercial-email requirements for outreach and reminders (opt-out wording, sender identification).
- [ ] Terms stating Haggle never holds money and who bears the risk of a vendor no-show after a customer-reported payment.
- [ ] The consent record standard for vendors.

## 12. Five highest-impact follow-ups

1. **Unblock the push and get CI green on sprint-4 code**, then run the consenting-mailbox email trial. Fix whatever the Message-ID check shows; nothing else matters until a real reply becomes a quote.
2. **Stand up staging:** Supabase project, migrations 103–117 with the ledger, Manufact staging, the Inkbox subscription with bounce events, `launch-gate` and `smoke --live-readonly` green.
3. **Agree the `packages/core` additions with Aarnav** and ship the approval-card and deal-board stages. Today, `BOOKED`, `handoff_refused` and the selection reasons reach the agent only as text.
4. **Run one real pilot deal end to end** with a friendly vendor on the manual rail. Measure each step against the simulated acceptance numbers (12 tool calls, 5 human steps).
5. **Add operator CLIs for the engine-only operator paths:** `quarantine release-text` (`releaseHeldText`) and `job-ops callback` (`operatorCallback`, designed by F as a review-mediated request). Also fix the `ready_offered` lease-loss gap.

## 13. Minimum viable real-customer pilot (updated definition)

The pilot is viable when **all** of the following are true on staging, then production:

1. **Scope:** one operator-onboarded workspace (`workspace-admin show` passes), catering or small events in the SF Bay Area, at least 3 vendors with recorded consent, manual payment only (`HAGGLE_PAYMENTS=manual`), live mode with `HAGGLE_ENV=staging` or `production`, and `launch-gate.ts` green.
2. **Email proven:** the consenting-mailbox trial shows matching Message-IDs, and real Gmail and Outlook replies become token-verified quotes. Suspicious variants are quarantined, and bounce events are subscribed.
3. **Human control:**
   - Approval only by the approver's out-of-band coded text.
   - Booking only after the vendor's written confirmation; a thread-only confirmation requires `BOOKED <code>`.
   - Payment only by the customer directly; Haggle records "customer reports paying" and never claims verification without a verified vendor receipt.
   - `call_back` only with `CALL <code>` and consent.
4. **Operations:**
   - Migrations 103–117 are applied with a tested backup.
   - `/ready` is green, alerts reach Slack, and `ops-report` is reviewed daily.
   - Stuck-job recovery runs.
   - The operator knows `quarantine`, `job-ops` and `docs/operator-recovery.md`.
5. **Honesty:**
   - Every response labels mock vs live.
   - Traction counts exclude test-marked workspaces and jobs.
   - No claim of automated payment, verified vendor identity or savings that wasn't measured.
6. **Exit criterion for "pilot works":** at least one real deal goes from the customer's request to a vendor-confirmed booking and a customer-reported payment, with no developer step and no unsafe action in the logs.
