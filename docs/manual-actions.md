# Manual actions (cannot be done from a development session)

Only what needs a person, a provider dashboard, new credentials, a live system, or another person's agreement. Everything else is in the code. The order is the order to do them; the exact commands are in `docs/staging-email-trial-runbook.md`.

## 1. Before the first staging trial (Yash)
- [ ] **Supabase:** create the staging project and copy its pooler URL. Note the production project ref for `HAGGLE_PROD_DB_HOSTS`. Install the PostgreSQL 17 client tools (`psql`, `pg_dump`) on the machine that runs the release.
- [ ] **Inkbox:** create a **staging identity with its own mailbox**; the email trial refuses the production `haggle` handle. Also a staging API key and webhook signing secret. If the identity's inbound filter is in whitelist mode, allow your two trial addresses.
- [ ] **Manufact:** create a separate staging server, and link a **separate clean checkout** to it. This repo's `.mcp-use/cloud/link.json` points at production `calm-spark-ck3qm`, so `staging-release.ts` refuses it. Confirm the flags for a new server with `mcp-use deploy --help`.
- [ ] **Anthropic:** a staging key with a spending limit.
- [ ] **Write `~/.config/haggle/staging.env`** (`chmod 600`, outside the repo) with the variables in `docs/staging.md` §2.1, and set the same names on the Manufact staging server.
- [ ] **Two mailboxes you own** for the trial (e.g. one Gmail, one Outlook), with Gmail web/app, Outlook and iOS Mail available to reply from.
- [ ] **Run the runbook** §1–§10. After deploying, subscribe the staging identity to `message.received`, `message.bounced` and `message.failed` (runbook §4).

## 2. Questions for providers (email; answers change code or config)
- [ ] **Inkbox, mail:**
  - Is the send-time Message-ID final, or rewritten by SES? (The trial's verdict answers this for real, but ask too.)
  - Per-message SPF/DKIM/DMARC results.
  - Bounce payloads and timing (hard vs soft).
  - Whether list rows carry the read flag.
  - Whether `messages.get` marks mail read.
  - The idempotency-conflict status code.
- [ ] **Inkbox, texts** (`docs/carrier-keywords.md`):
  - Are carrier opt-out keywords processed on Haggle's line, and **only as the exact whole message**, so `CANCEL 482913` is delivered?
  - Are keyword texts delivered to the webhook?
  - Is there an auto-reply?
  - What error does a send to an opted-out number return?
  - Does START lift it?
  - Can SMS sender IDs be spoofed on its line?
- [ ] **Inkbox, calls:**
  - Is `remote_phone_number` on `call.ended` carrier-verified? (A future basis for callback consent under H1.)
  - A2A `messageId` dedupe.
  - The cost of per-workspace identities.
- [ ] **Anthropic:**
  - Limits for the intended `HAGGLE_AI_*` budgets.
  - The structured-output schema-size ceiling.
  - Current prices, against `docs/pilot-metrics.md`.

## 3. With Aarnav (shared files and his modules; I can't change them alone)
- [ ] The `packages/core` additions and brain tenancy (`docs/aarnav-handoff.md`). Brain tenancy blocks a second customer, not the first.
- [ ] Shared files: bump `apps/mcp/package.json` to `0.6.0` (the server already reports 0.6.0). Add `scripts/migration-compat.sh`, `scripts/smoke-local.sh` and `scripts/test-clock-skew.sh` to the root `verify` script so it matches CI.
- [ ] Whether to regenerate `docs/eval-report.md` (`docs/sprint-5-report.md` §6).

## 4. After a READY trial (only then)
- [ ] Verify the approver's phone on the real text line. Tell pilot approvers to always include the code, and never to text a bare STOP or CANCEL unless they mean "stop texting me".
- [ ] Record 3 consenting vendors (`workspace-admin add-vendor --consent`). Run one deal end to end with a friendly vendor on staging.
- [ ] **Slack:** an incoming webhook for `HAGGLE_ALERT_WEBHOOK_URL`. **GitHub:** branch protection on `main` requiring "CI / verify".
- [ ] **Production**, only after the above and your merge approval:
  - confirm Supabase backups and point-in-time recovery;
  - take a verified backup;
  - apply migrations 103–122 through the ledger (backfill through 102 only);
  - run the launch gate, preflight and smoke.

## 5. Legal
- [ ] Commercial-email requirements for outreach and reminders (opt-out wording, sender identification).
- [ ] Pilot terms:
  - Haggle never holds money.
  - Who bears the risk of a vendor no-show after a customer-reported payment.
  - The standard for recording vendor consent.

## 6. Decisions
- [ ] Review and merge plan for draft PR #1 (`yashnil` → `main`); nothing merges without your approval.

## 7. Housekeeping (only with your OK)
- [ ] Delete the agent worktrees and branches under `.claude/worktrees/` (sprints 3–5 and this pass) and the local `backup/yashnil-pre-secret-rewrite-20261022` branch.
