# Sprint 5 report: release candidate and pilot preparation (2026-10-22)

Branch `yashnil`, draft PR #1 (not merged). Baseline `ce4760e`. Five workstreams in isolated worktrees (A purchasing, B onboarding/operator, C staging/release, D independent adversarial review, E analytics/benchmark), integrated by the coordinator, who also did F (this report, the handoffs, the checklists). Nothing was deployed, provisioned or migrated on a live database; no real email, text, call or payment was sent. **All evidence below is simulated** (in-memory store, throwaway Postgres, fake providers).

Companion docs: `docs/pilot-launch-checklist.md` (prerequisites), `docs/manual-actions.md` (what only a person can do), `docs/aarnav-handoff.md` (brain, views, shared contracts), `docs/security-review-s5.md` (D's full review), `docs/staging.md`, `docs/first-user-guide.md`, `docs/pilot-metrics.md`.

## 1. Can a controlled pilot begin?

**Not yet with a real customer; yes for the staging pilot steps.** The code now supports the target flow end to end in simulation: a request in plain language, quotes from consenting vendors, a comparison that says why each vendor is or isn't compared, approval only by the human's coded text, a booking only after the vendor's written confirmation or the approver's `BOOKED <code>`, and payment directly to the vendor with Haggle recording only what the customer reports. What is missing is real-world evidence plus a few provider, environment and decision steps:

1. **No real reply has ever been ingested.** The consenting-mailbox trial (send-time Message-ID vs what replies reference) is the single biggest unknown; if it fails, no real email reply becomes a quote.
2. **No staging environment exists**, and the live database is at migration 102 (sprint 5 adds 118, 119, 121, 122).
3. **The Inkbox subscription lacks bounce events**; the launch gate now refuses to pass without them.
4. **Brain profiles are shared across workspaces** (Aarnav). Acceptable for a single-customer pilot; not for two.
5. ~~Three product/security decisions (H1–H3)~~: decided and implemented after the sprint (§8).

With those done on staging (`docs/pilot-launch-checklist.md` §A–D), a single-workspace pilot with 3+ consenting vendors and manual payment is a reasonable, controlled next step.

## 2. What was built

### A. Purchasing experience
- **Booking always needs confirmation.** A vendor reached by phone or A2A (no written reply possible) previously moved to the payment handoff the moment the human approved. Now the approver must confirm with the vendor and text `BOOKED <code>`; migration 118 enforces "no handoff before attestation" in the database.
- Vendor replies are ignored against a withdrawn/expired approval; a booking reply naming another day is unclear, never a yes; must-haves the quote never confirmed are listed in the booking request and a bare "confirmed" doesn't book them.
- **No dead ends after approval:** a stalled booking or refused handoff can be withdrawn by approving another quote (nothing paid); cancelling a confirm-only order closes its booking and tells the vendor.
- The `ready_offered` lease-loss gap (human never told quotes were final) is closed.
- **Dates:** demo quotes valid 14 days from when given (the fixed `2026-10-21` made every demo quote stale today); "tomorrow"/"Saturday" resolve in the workspace timezone, not UTC.
- **Comparison:** every contacted vendor that isn't compared gets a plain reason (declined, unreachable, asked a question, unreadable reply, no reply), and `next` ends with "Not compared: …".
- **Fewer calls:** `list_deals` resumes a deal with its purchase stage and next step; no `pay` call on the manual rail. Simulated acceptance flow: **12 → 9 agent tool calls**, human steps unchanged at 5 (none could be removed without weakening authorization).
- 8 end-to-end purchase scenarios (success, vendor declines, never confirms, stale quote, requirement unconfirmed, approver refuses, cancel mid-booking, paid then no-show), resume tests on memory and Postgres.

### B. Pilot onboarding and operator actions
- `operator_actions` audit log (119): append-only, every operator change records who, why and when.
- `workspace-create`: dry run by default, `--apply --by`, idempotent, credentials only to a new 0600 file or on explicit request.
- `workspace-admin`: `suspend` / `resume` (suspension holds every open deal and refuses every tool with 403 `WORKSPACE_SUSPENDED`), `verify-approver` / `unverify-approver`, audited vendor roster with consent text, `history`.
- `job-ops callback` and `quarantine release-text`: CLI entry points to the review-mediated operator paths; they run on the job's next advance under its lease, so every engine check still applies.
- **`pilot-preflight`**: deployment and per-workspace checks, each PASS / WARN / FAIL / BLOCKED with a fix line, `--json`, exit codes; no provider call unless `--check-webhooks` is given.
- Docs: `docs/first-user-guide.md` (new, with example prompts), `docs/pilot-onboarding.md`, `docs/operator-recovery.md`.

### C. Staging and release readiness
- `/health`, `/ready` and serverInfo report `version`, `build_sha` (validated: a misplaced secret in `HAGGLE_BUILD_SHA` is no longer echoed) and `build_time`.
- `staging-release.ts`: plan by default; `--execute` backs up, applies migrations through the ledger, runs the launch gate and a read-only smoke; deploy only behind `--deploy` with a rollback ref. Refuses production, calm-spark, dirty checkouts and non-manual payments.
- `migration-compat.sh`: upgrades a seeded database at 102 one migration at a time (the live database's path), plus every checkpoint. `verify-migrations.sh` re-applies re-runnable migrations and isolates 112–117 and 118+ on their bases.
- Production-DB guard enumeration now walks every script directory; it found and closed an unguarded script (`scripts/acceptance/job-evidence.mjs` read `apps/mcp/.env`).
- Smoke tests proven unable to contact anyone (every outside port throws); a mock-mode local smoke runs in CI.
- Launch gate requires `message.bounced` and `message.failed`.
- CI adds: env-manifest freshness, shellcheck, offline launch gate, local smoke, migration compatibility. `test-postgres.sh` runs every `apps/mcp/tests/*.pg.test.ts`.
- Docs: `docs/staging.md` (new, every step marked [YOU] or [SCRIPT]); `docs/deployment.md` corrected: the live database is at 102, backfill through 102 (the old text said 106, which would have recorded 103–106 as applied).

### D. Independent adversarial review (`docs/security-review-s5.md`)
14 issues fixed, each with a test that failed first: a replaced approver's phone could still approve; coded texts from an unknown number landed on another workspace's deal; wrong YES codes weren't counted with several approvals pending; the agent-message guard missed reworded commitments, amounts without "$" and lookalike names; request details could plant an invented competing offer; an operator could release a held `BOOKED` text to any deal; an `@domain` allowlist entry authorized A2A card URLs; opt-outs weren't honoured across channels (text/call after an email STOP, escalation to a call, counteroffers); live `send_message` by phone acted as an unauthorized callback; payment instructions could be silently swapped after the human was told how to pay; a removed vendor was still contacted; approval terms were mutable in Postgres (121); `business_profile` showed another tenant's menu. Coordinator added H9: an opted-out business can't be approved.

### E. Analytics and evaluation
- `ops/metrics.ts` + `scripts/metrics.ts`: metrics only from database rows, in a read-only transaction; one tested simulated-vs-real rule; REAL and SIMULATED buckets side by side; sourcing completion, reply/quote rates by channel, manual interventions, time to first quote / approval / booking, duration, funnel.
- `ai_usage_events` (122) records each Claude call's tokens per job (wired into the live server at integration); `ops/costs.ts` gives an approximate cost with a dated, documented price table.
- `pilot-benchmark.ts`: seeded mock-mode deals, deterministic fingerprint, JSON + markdown output.
- Leaner output: quiet `wait_for_update` polls are one line; the compact board drops restated reasons and unused fields. Benchmark output per deal 25,807 → 22,646 characters (−12%).

## 3. Integration fixes (coordinator)
- B×C: the preflight test's "ready" subscription lacked the bounce events C's launch gate now requires (fixture fixed, check kept).
- E×C: the live server now passes AI usage to `ai_usage_events`.
- **Intermittent Postgres failure, root-caused:** fake SMS senders returned `sms_<n>` per process; parallel suites sharing one database collided on the unique provider id, so an outbound RFQ row was silently dropped and the vendor's reply had nothing to match. Fakes now return per-run ids (the earlier per-run phone change in `ce4760e` was not the real cause).
- H9 fix above.

## 4. Verification (final tree)
| Check | Result | Sprint-4 baseline |
| --- | --- | --- |
| typecheck, MCP build | clean | clean |
| unit (`npx vitest run`) | 1,561 passed, 31 skipped | 1,378 / 21 |
| Postgres engine suite | 1,025 passed, 1 skipped (final run; 3 consecutive full runs before the H9 test was added) | 938 / 1 |
| apps/mcp Postgres tests | 6 passed, 2 skipped (staging `--execute` test needs a host `psql`; runs in CI) | 4 |
| `verify-migrations.sh` | OK (118, 119, 121, 122 each alone on 100–117) | OK |
| `migration-compat.sh` | OK (seeded 102 upgrade + every checkpoint) | new |
| `smoke-local.sh` | OK | new |
| secret scan, env-manifest check | clean, current | clean |
| GitHub Actions | green on checkpoint `61f732b` (push run 39801910403, PR run 39801916991); final push: see PR #1 | green on `ce4760e` |

## 5. Prioritized outstanding production risks
1. **Critical, unverified real email path** (Message-ID matching, real Gmail/Outlook replies).
2. **High, no staging; live database at 102.** Every sprint-4/5 safeguard that lives in a migration (112–122) is absent in production until applied.
3. ~~High, sender identity on text (H2) and caller-ID consent (H1)~~: fixed after the sprint (§8).
4. **High, bounce events not subscribed** (dashboard action).
5. **Medium, brain tenancy** (Aarnav): shared profiles across workspaces; mock-job replies can teach live profiles.
6. **Medium, views don't show booking stages, reasons or flags** (Aarnav); the agent relays them as text.
7. ~~Medium, the model can cancel a vendor-confirmed booking (H3)~~: fixed after the sprint (§8).
8. **Medium, board size grows with workspace history** (one measured board 10,851 chars vs 10,000 budget).
9. **Low, approver verification is operator-recorded**, not a coded round trip; approvals aren't gated on it (preflight blocks instead).
10. **Low, per-process rate/AI limits and alert dedupe**; text routing scans recent jobs (H10).

## 6. Known limitations and follow-ups
- Approval isn't refused once the event date has passed (A; many existing tests use a fixed date).
- After an opt-out, the board can still show the business as `quoted` (H9 display half).
- `docs/eval-report.md` not regenerated: current code changes unrelated rows (tax treatment, identity, mismatch flags); its "Open findings" need a human re-read first.
- `apps/mcp/package.json` still says 0.1.0 (shared file; server reports 0.6.0); root `verify` lacks the two new CI scripts.
- No HTTP-level e2e for `WORKSPACE_SUSPENDED` (needs a mock-workspace `suspended` flag).
- Benchmark tool calls (mean 32 per deal) measure a scripted polling agent, not the acceptance flow; compare across commits, not against the 9-call acceptance number.

## 7. Migrations added
118 `engine_booking` (attestation before handoff), 119 `engine_pilot` (operator log), 121 `engine_security2` (approval immutability), 122 `engine_metrics` (AI usage). Each applies alone on 100–117 and in order from 102; none applied anywhere live.

## 8. After the sprint: decisions H1–H3 (2026-10-22)
Yash approved the three recommendations; implemented test-first (`packages/engine/tests/securityDecisions.test.ts`, MCP-level `apps/mcp/tests/purchaseFlow.e2e.test.ts`).
- **H2:** texts from a vendor's number (SMS and iMessage) and caller-ID-matched calls are `text_only` identity. A texted "confirmed" waits for the approver's `BOOKED <code>`; a texted "received" never records `settled_verified`; texted payment details always carry the confirm-by-phone warning. Provider-authenticated email books and verifies as before.
- **H1:** `called_us` callback consent needs an authenticated inbound call; caller ID alone (even with `HAGGLE_TRUST_INBOUND_CALLER_ID`) never counts. Today that leaves operator-recorded consent as the only basis for live callbacks.
- **H3:** after the vendor confirmed (or the approver attested) a booking, `cancel_deal` texts the approver a one-time `CANCEL <code>` and cancels nothing; their coded reply cancels and tells the vendor. Re-approving a different quote can't withdraw a confirmed booking. Unconfirmed deals cancel as before. The operator's `job-ops fail-safe-close` is unchanged (an audited operator path, not a model tool).
- **Test-infrastructure fix:** `InMemoryRepository` stamped rows with the real clock; from 2026-10-22 16:00Z (the fixed date tests use) the failure drill saw future-dated rows and failed, also on `b0d1893`. The store now takes an optional clock and the drill passes it.

- **Verified (final tree):** typecheck and build clean; unit 1,576 passed / 31 skipped; Postgres 1,039 passed / 1 skipped plus 6 apps/mcp Postgres tests; `verify-migrations`, `migration-compat`, `smoke-local`, secret scan and env-manifest check OK.
