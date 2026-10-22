# Pilot launch checklist (first real pilot)

The exact prerequisites for the first controlled pilot: one operator-onboarded workspace, catering or small events in the SF Bay Area, at least 3 consenting vendors, human approval by text, and **manual payment directly to the vendor** (`HAGGLE_PAYMENTS=manual`). Haggle never holds or moves money.

Tick an item only when it has been done on the real system, not in tests. `[YOU]` needs a person or a provider dashboard; `[SCRIPT]` is a command in this repo. Commands are in `docs/staging.md` and `docs/pilot-onboarding.md`.

## A. Decisions (before anything is provisioned)
- [ ] [YOU + Aarnav] Approve the `packages/core` additions in `docs/aarnav-handoff.md` §4 (stages, vendor-contact statuses, flags). Until then the agent sees them only as text.
- [x] [YOU] Decide H1, H2 and H3 (decided 2026-10-22, implemented): a texted "confirmed" needs the approver's `BOOKED <code>` and a texted "received" never verifies payment; caller ID is never callback consent; cancelling a vendor-confirmed booking needs the approver's `CANCEL <code>`.
- [ ] [YOU] Accept the contact-hour defaults (Mon–Sat 08:00–19:00 Pacific, at most 2 reminders) or set `HAGGLE_CONTACT_*`.
- [ ] [YOU] Accept `BOOKED <code>` as the booking confirmation for phone and text vendors and for email vendors whose sender can't be authenticated.
- [ ] [YOU] Write the pilot terms: Haggle never holds money, the customer pays the vendor directly, and who bears the risk of a vendor no-show. Settle the vendor consent wording.

## B. Staging (all of `docs/staging.md`)
- [ ] [YOU] Supabase staging project (pooler URL); confirm backups and point-in-time recovery on the plan.
- [ ] [YOU] Inkbox staging identity, API key and webhook secret. Subscribe `message.received`, `message.bounced`, `message.failed`, `call.ended`, `imessage.received`; check the mailbox inbound filter isn't `whitelist`.
- [ ] [YOU] Separate Anthropic key with a spending limit; Slack incoming webhook for alerts; Manufact staging server (never calm-spark).
- [ ] [YOU] Local staging env file (never committed): `HAGGLE_ENV=staging`, `HAGGLE_MODE=live`, `HAGGLE_PAYMENTS=manual`, `HAGGLE_PROD_DB_HOSTS` set.
- [ ] [SCRIPT] `staging-release.ts` plan → `--execute` (backup, migrations through 122 with the ledger, launch gate, read-only smoke) → `--deploy`. `/health` must report the expected `build_sha`.
- [ ] [SCRIPT] `pilot-preflight --check-webhooks` on staging: every check PASS (WARN acceptable only for brain tenancy, until Aarnav's change lands).

## C. Real-channel evidence (staging, consenting people only)
- [ ] [YOU] Consenting Gmail and Outlook mailboxes; [SCRIPT] `email-trial.ts` validate → dry-run → send → replies → collect (`docs/email-trial-checklist.md`). Pass condition: the send-time Message-ID matches what replies reference, and real replies become token-verified quotes.
- [ ] [YOU] One bounce (a non-existent address on a domain you control) arrives as `message.bounced` and marks the vendor bounced.
- [ ] [YOU] Approver's phone: `YES <code>`, `BOOKED <code>` and `PAID <code>` work on the real SMS line; [SCRIPT] `workspace-admin verify-approver` records it.
- [ ] [YOU] Connect the staging connector in Claude (and ChatGPT if used); `get_quotes` renders and `list_deals` resumes a deal in a new conversation.

## D. One friendly vendor, end to end (staging)
- [ ] [YOU] One real vendor who has agreed in writing to be contacted; [SCRIPT] `workspace-admin add-vendor --consent … --by …`.
- [ ] A real request → real quote → approval by text → vendor's written confirmation (or `BOOKED`) → customer pays the vendor directly → `PAID <code>`. Compare against the simulated acceptance numbers (9 agent tool calls, 5 human steps).
- [ ] [SCRIPT] `metrics.ts --workspace <id>` shows the deal in the REAL bucket; `ops-report` shows no stuck jobs.

## E. Production
- [ ] [YOU] Verified production backup; then migrations 103–122 through the ledger (`docs/deployment.md`: the live database is at 102; backfill through 102 only).
- [ ] [SCRIPT] `launch-gate --target production`, `pilot-preflight` for the pilot workspace, `smoke --live-readonly`.
- [ ] [YOU] Mark internal and demo workspaces as test (`traction.ts mark-test`) so metrics stay clean.
- [ ] [YOU] Branch protection on `main` requiring "CI / verify"; merge only after review.
- [ ] [YOU] Onboard the pilot customer with `docs/first-user-guide.md`; at least 3 consenting vendors on the roster; approver verified.

## F. During the pilot
- [ ] Watch alerts and `ops-report` daily; release or reject held mail and texts (`quarantine`), never edit rows by hand.
- [ ] Suspend the workspace (`workspace-admin suspend`) at the first sign of a wrong message; revoking credentials alone does not pause in-flight deals.
