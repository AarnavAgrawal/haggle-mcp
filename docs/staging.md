# Staging

How to stand up Haggle's staging environment, release a candidate to it, verify it and roll it back. Staging is a **second, independent deployment**: it shares code with production and nothing else (no database, Inkbox identity, webhook secret, Anthropic key, alert channel or Manufact server).

Every step is marked:
- **[YOU]**: a dashboard or account action only the user can take (a provider account, a credential, a live change). Nothing in this repository performs it.
- **[SCRIPT]**: a command from this repository. It never runs against production: `apps/mcp/scripts/staging-release.ts` refuses anything but a staging env file.

**Two people set staging up.** Who owns each step below, the shared secrets vault, what Aarnav reports back, and the joint go/no-go gates are in `docs/staging-handoff.md`.
- Supabase and Anthropic: Yashnil.
- Manufact and Inkbox: Aarnav.

Status on 2026-10-22:
- **Provisioned:** the Supabase staging project (`vsvcgzesbhjmxwnnqjkh`, reachable through the session pooler, schema empty) and the Anthropic staging key.
- **Not yet:** Manufact, Inkbox, Slack, migrations.
- **Scripts:** run only in plan mode, read-only, and against throwaway local databases (section 9).

## 1. Provision the accounts

### 1.1 Supabase (staging project) [YOU]
1. Create a separate project, e.g. `haggle-staging`, in the same region as production. Note its **project ref** (the staging ref).
2. Go to **Database → Connect** and copy the **session pooler** string (port 5432, user `postgres.<staging ref>`). It becomes staging's `SUPABASE_DB_URL`. Percent-encode any `@`, `:` or `/` in the password.
3. Go to **Database → Backups** and note the plan's daily backups and whether PITR is available (`docs/backup-restore.md` §1). Staging doesn't need PITR. A logical dump before each release is enough (section 4).
4. Note the **production** project ref as well. Staging's `HAGGLE_PROD_DB_HOSTS` lists it, so staging can recognize the production database and refuse it.

### 1.2 Inkbox (staging buyer identity) [YOU]
1. Create a staging identity, e.g. `haggle-staging`. Pick the org on purpose:
   - Simulated sellers trust a buyer only within their own org (sender trust).
   - Real consenting vendors are outside any org, so for them the org doesn't matter.
2. Create an API key that can act for that identity (`INKBOX_API_KEY`). Copy the webhook signing secret (`INKBOX_WEBHOOK_SECRET`).
3. **The webhook subscription comes after the first deploy** (section 6). It needs the staging server's URL.

### 1.3 Anthropic [YOU]
Create a separate API key, or a separate workspace, for staging. Staging's spend then shows on its own, and `HAGGLE_AI_DAILY_TOKEN_BUDGET` caps it.

### 1.4 Slack alerts [YOU]
Create an incoming webhook for a staging channel, e.g. `#haggle-staging-alerts`. This URL becomes `HAGGLE_ALERT_WEBHOOK_URL`, and it is itself a secret. To test it, send one message from your own terminal. The server sends only redacted alerts.

### 1.5 Manufact (staging server) [YOU]
1. Make a **separate checkout** for staging. It keeps its own link file:
   ```bash
   git worktree add ../haggle-staging <commit>
   cd ../haggle-staging && npm ci
   ```
2. Create a **second server**: not a new deployment of production's `calm-spark-ck3qm`. From that checkout, `./node_modules/.bin/mcp-use deploy --new --no-github --name haggle-staging` creates one and writes `.mcp-use/cloud/link.json`. `--no-github` makes it a managed upload of that checkout, like production. Check the flags with `mcp-use deploy --help` first, because this CLI changes between versions. The first deploy can wait until section 5; to create the server without deploying, use the dashboard instead.
3. **Never copy production's `.mcp-use/cloud/link.json` into this checkout.** `staging-release.ts` refuses a checkout linked to `calm-spark-ck3qm`, or to any `--production-server` you name.
4. Set the start command to `cd apps/mcp && ../../node_modules/.bin/mcp-use start --host 0.0.0.0` and the port to 3000.
5. Note the server **id**, which `servers env` and `--server-id` take. Copy the MCP URL from the dashboard; never guess it.

### 1.6 GitHub [nothing]
CI needs no secrets and never deploys. Staging adds nothing there.

## 2. Configure the environment

### 2.1 The staging env file (local) [YOU]
Keep one staging env file **outside the repository**, e.g. `~/.config/haggle/staging.env` with `chmod 600`. Every script takes it explicitly. Nothing reads `.env` by default.

```bash
HAGGLE_ENV=staging
HAGGLE_MODE=live
SUPABASE_DB_URL=postgres://postgres.<staging ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
HAGGLE_PROD_DB_HOSTS=<production ref>
INKBOX_API_KEY=<staging key>
INKBOX_WEBHOOK_SECRET=<staging signing secret>
INKBOX_IDENTITY=haggle-staging
ANTHROPIC_API_KEY=<staging key>
HAGGLE_PAYMENTS=manual
HAGGLE_AI_MAX_CALLS_PER_JOB=60
HAGGLE_AI_DAILY_TOKEN_BUDGET=<tokens per day>
HAGGLE_ALERT_WEBHOOK_URL=<staging Slack webhook>
HAGGLE_EXTERNAL_SENDERS=reply_token
HAGGLE_REPLY_TOKEN_SECRET=<generated in the vault, >= 16 characters>
HAGGLE_SMOKE_TOKEN=<staging workspace bearer, after section 4.3>
```

- **The pooler host matters.** Use the session pooler host from Database → Connect (the staging project's is `aws-0-us-east-1.pooler.supabase.com`). The direct `db.<ref>.supabase.co` host is IPv6-only, so many networks can't reach it.
- **Percent-encode** `@`, `:`, `/`, `#`, `?` and `%` in the password.
- **Reply tokens:** real mailboxes (Gmail, Outlook) are trusted only with `HAGGLE_EXTERNAL_SENDERS=reply_token` (`docs/pilot-onboarding.md`).
- **Brain store:** leave `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` off the **server** until the 2xx brain migrations are on staging (`docs/staging-handoff.md` §3).

`docs/env-manifest.md` ("Staging, separate from production") lists every other variable.

Leave every `HAGGLE_ENABLE_*` channel off until it has been tested on staging. `HAGGLE_BUILD_SHA` and `HAGGLE_BUILD_TIME` are set per deploy (section 5), not in this file.

### 2.2 The same variables on the server [YOU]
Set them in the Manufact dashboard: paste them there, so nothing lands in shell history. Or use `./node_modules/.bin/mcp-use servers env set <staging server id> KEY=VALUE`. Prefer the dashboard: `servers env set` puts the value in shell history. Leave out `HAGGLE_SMOKE_TOKEN`, `HAGGLE_EMAIL_TRIAL` and `HAGGLE_EMAIL_TRIAL_MAILBOXES`: only local scripts read them.

## 3. Plan the release [SCRIPT, read-only]

From the staging checkout, at the exact commit you want to release:

```bash
node apps/mcp/scripts/staging-release.ts --env-file ~/.config/haggle/staging.env \
  --server-id <staging server id> --base-url https://<staging server host>
```

Plan mode connects to nothing and changes nothing. It runs only `git rev-parse` and `git status`. It prints:
- every refusal;
- every step, with its exact command;
- whether you or the script runs it.

It refuses (exit 1) when any of these holds:
- the file isn't `HAGGLE_ENV=staging` and `HAGGLE_MODE=live`;
- `HAGGLE_PROD_DB_HOSTS` is empty;
- `HAGGLE_ALLOW_PROD_DB=true`;
- `SUPABASE_DB_URL` looks like production (there is no override);
- payments aren't `manual`;
- the link file names a production server, or not `--server-id`;
- the checkout has uncommitted changes;
- a `--backup-dump` path is inside the repository.

## 4. Database: back up, apply migrations, gate [SCRIPT]

### 4.1 First release on the new, empty project
```bash
node apps/mcp/scripts/staging-release.ts --env-file ~/.config/haggle/staging.env --execute \
  --backup-ref "new project, empty" --backfill-through none
```
This applies every engine migration in filename order, each in one transaction (`psql -1 -f`, with the database passed in `PG*` variables, never on the command line). It then records them in the ledger (`migrations.ts backfill`), runs `migrations.ts verify` and runs the launch gate. The brain's `2xx_brain_*` files are listed but never applied here: Aarnav applies them (**[YOU / Aarnav]**). It needs `psql` and `pg_dump`, version 17, on your PATH.

### 4.2 Every later release
```bash
node apps/mcp/scripts/staging-release.ts --env-file ~/.config/haggle/staging.env --execute \
  --backup-dump ~/haggle-backups/staging-$(date -u +%Y%m%dT%H%M%SZ).dump
```
1. It refuses to touch the schema without `--backup-dump <file outside the repo>`, or `--backup-ref <your backup or PITR reference>`.
2. It applies only the engine files the ledger lacks, records each one, then runs `verify` and the launch gate.
3. It stops for a human on any of these:
   - **drift:** an applied file has changed;
   - an **unverified** ledger row;
   - an **unexpected** row: the database is ahead of this checkout;
   - a failed file. It is rolled back and not recorded.

   Never fix drift with `--accept-drift` until you have compared the database with the file.

A database that already has migrations but no ledger (the live database: 100–102 per the audit) takes `--backfill-through 102_engine_stripe.sql`, the last file you **know** is applied. The script never guesses this.

Sprint-5 migrations (118 A, 119 B, 121 D, 122 E) need no change to any script. Every list is read from `supabase/migrations/`.

### 4.3 The staging workspace [SCRIPT, once]
After the first migration run, create the workspace and its vendors:
```bash
node --env-file=$HOME/.config/haggle/staging.env apps/mcp/scripts/workspace-create.ts ...
```
- The arguments are in `docs/pilot-onboarding.md`. The guard refuses a production database here.
- Put the printed bearer token into the env file as `HAGGLE_SMOKE_TOKEN`. It is shown once.

## 5. Deploy the release candidate

**Either [YOU]** run the four printed commands from the staging checkout's root:
1. `servers get`: note the live deployment id, your rollback point.
2. `servers env set … HAGGLE_BUILD_SHA=<sha>`.
3. `servers env set … HAGGLE_BUILD_TIME=<iso>`.
4. `deploy --json`, then follow the build logs.

**Or [SCRIPT]** let the script do the same:
```bash
node apps/mcp/scripts/staging-release.ts --env-file ~/.config/haggle/staging.env --execute --deploy \
  --backup-dump <file> --server-id <staging server id> --rollback-ref <live deployment id> \
  --base-url https://<staging server host>
```
`--deploy` runs only with `--execute`, and it needs:
- the server id, which must match the link file;
- the deployment to roll back to;
- the base URL.

It then sets the build label, deploys, waits up to 10 minutes for `/ready` to report the new `build_sha`, and smoke-tests the server. CI never runs it.

## 6. Webhook subscription [YOU, after the first deploy]

Create the Inkbox subscription for the staging buyer identity. Use the dashboard, or `inkbox.webhooks.subscriptions.create({ agentIdentityId, url, eventTypes })` from your own machine.
- **URL:** `https://<staging server host>/webhooks/inkbox`.
- **Events:** `message.received`, `message.bounced` and `message.failed`, all three required. Add `call.ended`, `imessage.received` and `a2a.sent_task.updated` only for channels staging enables.

Then check it, read-only:
```bash
node apps/mcp/scripts/launch-gate.ts --target staging --env-file ~/.config/haggle/staging.env \
  --skip-build --check-webhooks --webhook-url https://<staging server host>/webhooks/inkbox
```
The gate **fails** if any of the three email events is missing. Other events only warn. Passing `--base-url` to `staging-release.ts` runs the same check inside the gate step.

## 7. Verify [SCRIPT + YOU]

1. **`/ready`** answers 200 with `ready: true`, `version`, `build_sha` (the deployed commit), `build_time` and `migrations.ok: true`:
   ```bash
   curl -s https://<staging server host>/ready
   ```
   `/health` and `/ready` never echo a value. A mis-set `HAGGLE_BUILD_SHA` shows as `"invalid"`.
2. **Read-only smoke.** It never sends, calls, texts or pays; `apps/mcp/tests/smokeSafety.test.ts` proves this with trapped provider ports:
   ```bash
   HAGGLE_SMOKE_TOKEN=<staging bearer> node apps/mcp/scripts/smoke.ts https://<staging server host> --live-readonly --expect-build <sha>
   ```
3. **Alerts [YOU].** The server alerts only on events: stalled jobs, AI limits, and repeated tick, reconcile or stall-check failures. So confirm the channel with the test message from section 1.4, and check `/ready` → `providers.alerts: true`.
4. **One real deal [YOU].** Run it only with consenting vendors, per `docs/pilot-onboarding.md` and the email trial checklist. This is the first step that contacts anyone.

## 8. Roll back

- **Code [YOU or SCRIPT].** Redeploy the previous commit (the `--rollback-ref` deployment) with section 5.
  - The schema stays: migrations are additive.
  - `/ready` stays ready, reporting newer migrations as `unexpected` with `database_ahead: true`.
  - `migrations.ts verify` and the launch gate need `--allow-ahead` until the newer build returns.
- **Schema or data [YOU].** Restore from the dump taken in section 4.2, or with PITR (`docs/backup-restore.md` §3–4). Stop outbound work first (`docs/runbook-incidents.md` §3.0).
- 103 and 115 can be undone only by a restore (`docs/deployment.md` §4).

## 9. What was verified in this repository (and what wasn't)

Verified, on throwaway local or CI databases only:
- `staging-release.ts` plan mode against a synthetic staging env file. It refused a missing link and a production-linked checkout.
- `--execute` end to end on two throwaway Postgres databases (`apps/mcp/tests/releaseStaging.pg.test.ts`):
  - an empty database (`--backfill-through none`);
  - a 100–102 database with demo-era rows and no ledger (`--backfill-through 102_engine_stripe.sql`).
- `scripts/migration-compat.sh`: 102 with rows to latest, through the real ledger CLI, plus every checkpoint.
- The trapped-port smoke test.

Not verified: any provider, Supabase project, Manufact server, Inkbox subscription or Slack channel. Those are the **[YOU]** steps above.
