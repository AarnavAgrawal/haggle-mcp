# Manual actions (cannot be done safely from a development session)

Only actions that need a person, a provider dashboard, new credentials, a live system, or a decision. Everything else is in the code. Order is the recommended order for tomorrow; details and commands are in `docs/pilot-launch-checklist.md` and `docs/staging.md`.

## 1. Decide (30 minutes, Yash; some with Aarnav)
- [ ] **Review and merge plan for draft PR #1** (`yashnil` → `main`); nothing merges without your approval.
- [x] **Security decisions H1–H3**: decided 2026-10-22 and implemented (`docs/security-review-s5.md` §4).
- [ ] **Ask Inkbox** whether a text that is exactly "CANCEL …" with a code is ever intercepted as a carrier opt-out keyword on its line (Haggle needs "CANCEL 482913" delivered; a bare "CANCEL" is a standard opt-out word).
- [ ] **With Aarnav:** the `packages/core` additions and brain tenancy option (`docs/aarnav-handoff.md`).
- [ ] **Shared files** (both must agree, so they stay undone until Aarnav agrees): bump `apps/mcp/package.json` version to `0.6.0` (the server already reports 0.6.0); add `scripts/migration-compat.sh` and `scripts/smoke-local.sh` to the root `verify` script so it matches CI.
- [ ] **Whether to regenerate `docs/eval-report.md`**: regenerating on current code changes rows unrelated to this sprint (`docs/sprint-5-report.md` §7); someone should re-read its "Open findings" first.

## 2. Provider dashboards (Yash)
- [ ] **Inkbox:** add `message.bounced` and `message.failed` to the buyer webhook subscription; check the mailbox inbound filter mode; create a staging identity, key and webhook secret.
- [ ] **Supabase:** create the staging project; confirm backup retention and point-in-time recovery for production.
- [ ] **Manufact:** create a separate staging server (and confirm the `mcp-use deploy` flags for a new server with `mcp-use deploy --help`).
- [ ] **Anthropic:** a staging key with a spending limit.
- [ ] **Slack:** an incoming webhook for `HAGGLE_ALERT_WEBHOOK_URL` (staging first).
- [ ] **GitHub:** branch protection on `main` requiring "CI / verify".

## 3. Provider questions (email Inkbox and Anthropic)
- [ ] Inkbox: per-message SPF/DKIM/DMARC results; is the send-time Message-ID final; bounce payloads and timing; idempotency-conflict status code; `remote_phone_number` on `call.ended` and whether it is carrier-verified; can SMS sender IDs be spoofed on its line; A2A `messageId` dedupe; cost of per-workspace identities.
- [ ] Anthropic: limits for the intended `HAGGLE_AI_*` budgets; structured-output schema-size ceiling; confirm current prices against the table in `docs/pilot-metrics.md`.

## 4. Live systems (only after 1–2; never from a dev session)
- [ ] Create the staging env file, then run `staging-release.ts` plan → `--execute` → `--deploy` (`docs/staging.md`).
- [ ] Run the consenting-mailbox email trial on staging (`docs/email-trial-checklist.md`).
- [ ] Verify the approver's phone on the real SMS line; record 3 consenting vendors.
- [ ] One friendly-vendor deal end to end on staging (manual payment).
- [ ] Production: verified backup, then migrations 103–122 through the ledger (backfill through 102 only), launch gate, preflight, smoke.

## 5. Legal
- [ ] Commercial-email requirements for outreach and reminders (opt-out wording, sender identification).
- [ ] Pilot terms: Haggle never holds money; who bears the risk of a vendor no-show after a customer-reported payment; vendor consent record standard.

## 6. Housekeeping (only with your OK)
- [ ] Delete the agent worktrees and branches under `.claude/worktrees/` (sprints 3–5) and the local `backup/yashnil-pre-secret-rewrite-20261022` branch once you no longer need them.
