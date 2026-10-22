# Runbook: first staging deployment and consenting-mailbox email trial

One pass, in order. Each step gives the command, what you should see, what a failure means, and how to undo it. Steps marked **[YOU]** need a dashboard or a decision; **[SCRIPT]** steps are commands in this repo. Reply scenarios and how to read the trial report are in `docs/email-trial-checklist.md` §5 and §7. Staging background is in `docs/staging.md`.

**Scope.** This contacts only mailboxes you own. It sends no text, places no call, and moves no money. It never touches the production database or the production server `calm-spark-ck3qm`. Every script below refuses production on its own.

**Conventions.**
- The staging env file is `~/.config/haggle/staging.env`, outside the repo, `chmod 600`, with the variables in `docs/staging.md` §2.1. `INKBOX_IDENTITY` must be the staging handle; the trial refuses `haggle`.
- `$STG` = `~/.config/haggle/staging.env`; `$STAGING` = `https://<staging server host>`.
- Run commands from the root of a **separate, clean checkout** of the release commit, linked to the staging Manufact server. Never use the working repo: its `.mcp-use/cloud/link.json` points at production, and `staging-release.ts` refuses it.
- Your two trial addresses (e.g. a Gmail and an Outlook address you own) are `$ME1` and `$ME2`.

## 0. Prerequisites [YOU] (each is in `docs/manual-actions.md`)

| Need | Check |
| --- | --- |
| Supabase staging project (pooler URL) | `SUPABASE_DB_URL` in `$STG`; `HAGGLE_PROD_DB_HOSTS` names the production ref |
| Inkbox staging identity with its own mailbox, its API key and webhook secret | `INKBOX_IDENTITY`, `INKBOX_API_KEY`, `INKBOX_WEBHOOK_SECRET` in `$STG` |
| Manufact staging server, and the clean checkout linked to it | `cat .mcp-use/cloud/link.json` shows the staging slug, not `calm-spark-ck3qm` |
| Anthropic staging key with a spending limit | `ANTHROPIC_API_KEY` in `$STG` |
| Server env vars set in the Manufact dashboard (same names as `$STG`, minus `HAGGLE_SMOKE_TOKEN`) | dashboard |

## 1. Plan the release [SCRIPT, contacts nothing]

```bash
git status --short            # must print nothing
node apps/mcp/scripts/staging-release.ts --env-file $STG
```
- **Expected:** `staging release PLAN (nothing is run): commit <sha>` and 7 numbered steps. Step 1 has no `REFUSED` line. Step 2 says `BLOCKED until a backup is given` (normal at this point).
- **Failures:**

  | Message | Fix |
  | --- | --- |
  | `REFUSED environment` | `$STG` must have `HAGGLE_ENV=staging` and `HAGGLE_MODE=live` |
  | `REFUSED database` | `SUPABASE_DB_URL` is production or matches `HAGGLE_PROD_DB_HOSTS`. Stop and fix the file; there is no override |
  | `REFUSED manufact` | the checkout is linked to production. Link the staging checkout: `mcp-use deploy` link, `docs/staging.md` §1.5 |
  | `REFUSED checkout` | uncommitted changes. Use a clean checkout of the exact commit |
  | `REFUSED payments` | set `HAGGLE_PAYMENTS=manual` |

## 2. Database: back up, migrate, gate [SCRIPT]

A new, empty staging project:
```bash
node apps/mcp/scripts/staging-release.ts --env-file $STG --execute \
  --backup-dump ~/haggle-backups/staging-$(date +%Y%m%d-%H%M).dump --backfill-through none
```
For later releases, drop `--backfill-through`.
- **Expected:** each pending `1NN_engine_*.sql` file applied and recorded, ending at `122_engine_metrics.sql`, then `migrations.ts verify` OK and the launch gate passing. The smoke step reports it needs `--base-url` until §3.
- **Failures:**
  - **A migration error:** that file's transaction rolled back, and earlier files stay applied and recorded. Read the error, fix it on a branch, and re-run; already-recorded files are skipped.
  - **The launch gate fails on webhooks:** expected before §4. Re-run the gate after §4.
  - **`psql`/`pg_dump` not found:** install the PostgreSQL 17 client tools.
- **Rollback:** restore the dump (`docs/backup-restore.md` §3). On a new project, dropping and recreating it is equivalent.

Create the staging workspace once (`docs/pilot-onboarding.md` has the full arguments):
```bash
node --env-file=$STG apps/mcp/scripts/workspace-create.ts --name "Staging Trial" --approver-phone <your +1 number> --cap 1500 --area "San Francisco, CA"   # DRY RUN: prints the plan
node --env-file=$STG apps/mcp/scripts/workspace-create.ts --name "Staging Trial" --approver-phone <your +1 number> --cap 1500 --area "San Francisco, CA" \
  --apply --by "<you>" --credentials-file ~/.config/haggle/staging-workspace.creds
```
Copy the bearer token from that 0600 file into `$STG` as `HAGGLE_SMOKE_TOKEN`.

## 3. Deploy the release candidate [YOU or SCRIPT]

```bash
./node_modules/.bin/mcp-use servers get <staging server id> --json      # note the live deployment id = ROLLBACK
node apps/mcp/scripts/staging-release.ts --env-file $STG --execute --deploy \
  --backup-ref "<the dump from §2>" --server-id <staging server id> --rollback-ref <ROLLBACK> --base-url $STAGING
```
- **Expected:** the build label is set and the deploy succeeds. `/ready` reports the new `build_sha` within 10 minutes, and the read-only smoke passes.
- **Checks:**
  - `curl -s $STAGING/ready` must show `ready: true`, `build_sha` equal to your commit, and `migrations.ok: true`.
  - `HAGGLE_SMOKE_TOKEN=... node apps/mcp/scripts/smoke.ts $STAGING --live-readonly --expect-build <sha>` must report `smoke OK`.
- **Failures:**
  - **`/ready` 503 with `missing`:** a server env var isn't set in the dashboard. The response lists names only.
  - **`build_sha: "invalid"`:** `HAGGLE_BUILD_SHA` was mis-set.
  - **Smoke 401:** wrong `HAGGLE_SMOKE_TOKEN`.
- **Rollback:** redeploy `<ROLLBACK>` (`docs/staging.md` §8). The schema stays (additive); `verify` and the gate then need `--allow-ahead`.

## 4. Webhook subscription [YOU], then check it [SCRIPT, read-only]

In the Inkbox dashboard, subscribe the **staging** identity to `$STAGING/webhooks/inkbox` with `message.received`, `message.bounced` and `message.failed`. Then:
```bash
node apps/mcp/scripts/launch-gate.ts --target staging --env-file $STG --skip-build --check-webhooks --webhook-url $STAGING/webhooks/inkbox
HAGGLE_EMAIL_TRIAL=1 node --env-file=$STG apps/mcp/scripts/email-trial.ts check-subscription
```
- **Expected:** the gate passes. `check-subscription` lists no missing mail events.
- **If `buyer_mail_inbound_filter` says whitelist:** add `$ME1` and `$ME2` to the identity's allowed senders, or their replies are dropped before Haggle sees them.
- **Failure:** a missing event fails the gate. Fix the subscription in the dashboard; there's nothing to roll back.

## 5. Validate and dry-run the trial [SCRIPT, contacts nothing, writes nothing]

```bash
export HAGGLE_EMAIL_TRIAL_MAILBOXES=$ME1,$ME2
HAGGLE_EMAIL_TRIAL=1 node --env-file=$STG apps/mcp/scripts/email-trial.ts validate --run ~/haggle-trials/t1 --to $ME1 --i-own-this-mailbox
node apps/mcp/scripts/email-trial.ts dry-run --run ~/haggle-trials/t1 --to $ME1 --buyer <staging mailbox address>
```
- **Expected from `validate`:** an `ok` line per gate and `send: all gates pass (nothing was contacted).`, exit 0.
- **Expected from `dry-run`:** `DRY RUN: nothing is sent, fetched or written.` and the exact test email. The subject starts `[HAGGLE TEST]` and the body begins `THIS IS A TEST`.
- **Failures:** each `BLOCKED`/`FAIL` line ends with a `fix:` line. The common ones:

  | Message | Fix |
  | --- | --- |
  | `INKBOX_IDENTITY ... production handle` | use the staging identity |
  | `--to ... not an exact entry` | add the exact address, only if you own it |
  | `--run` inside the repository or readable by others | use `~/haggle-trials/<new name>` (`chmod 700`) |

## 6. Send the one test email [SCRIPT, the only step that sends mail]

```bash
HAGGLE_EMAIL_TRIAL=1 node --env-file=$STG apps/mcp/scripts/email-trial.ts send --to $ME1 --run ~/haggle-trials/t1 --i-own-this-mailbox
```
- **Expected:** `Sent the TEST email to m***@...` with its Inkbox id, the run state path, and the 9 reply scenarios.
- **Failures:**
  - **`already exists`:** this run directory already sent. Use a new `--run`; it never sends twice.
  - **A provider error:** recorded in `run.json` with the error scrubbed. Run `collect` anyway: if the mail did go out, it is recovered by subject (`send_recovered`).
- **Rollback:** none needed. It is one labelled test email to your own mailbox.

## 7. Reply from your mail clients [YOU]

Do the 9 scenarios in `docs/email-trial-checklist.md` §5 from `$ME1`: Gmail web, Gmail app, Outlook, iOS Mail; forward to `$ME2` for scenario 5. Wait about 2 minutes after the last one.

Meanwhile, the staging server receives each reply by webhook. There's no deal for it, so its log shows the message as unmatched or held, keyed `mail:<id>`. **That log line is the webhook-delivery evidence; note which ids appear.**

## 8. Collect and read the verdict [SCRIPT, reads only allowlisted senders]

```bash
HAGGLE_EMAIL_TRIAL=1 node --env-file=$STG apps/mcp/scripts/email-trial.ts collect --run ~/haggle-trials/t1 --i-own-this-mailbox
```
It writes `report.md` and `report.json` (redacted) and `raw/` (unredacted, 0600; never commit it). The first line is the verdict:

| Verdict | Meaning | Next |
| --- | --- | --- |
| `READY: replies match by Message-ID` | Real replies reference the id Haggle records. The only replies held are the expected ones (scenarios 5 and 8; 2 if the quote was cut) | Go to §9 |
| `ID MISMATCH` | Clients reference the stored or SES id, so every real reply would be quarantined | **Stop.** An engine change is needed: record the id named by `engine_should_record`. No pilot until fixed and re-trialled |
| `TOKEN ONLY` | Headers lost, but the token survived. Replies are held as `not_in_our_thread` | **Stop.** Send `raw/` In-Reply-To/References per client to the coordinator |
| `NOT MATCHED` | Neither the id nor the token survived | Check the replies used Reply on the test email; repeat with a new `--run` |
| `NO REPLIES` | Nothing collected | Wait and re-run. Check the inbound filter (§4) |

Per reply, also check:
- the webhook read state (`read` means probably processed; `unread` means the server never fetched it) matches the server log from §7;
- each held reply's reason is the expected one;
- `CHECK: body looks quoted but nothing was cut` lines (reader bugs: keep the raw file).

Re-run `node apps/mcp/scripts/email-trial.ts dry-run --run ~/haggle-trials/t1 --to $ME1` any time to replay the captures offline.

## 9. Operator report and cleanup [SCRIPT, read-only]

```bash
node --env-file=$STG apps/mcp/scripts/ops-report.ts --brief
```
- **Expected:** the trial replies may appear as held or unmatched email. Nothing else should be listed.
- **Clean up** each trial message so the queue stays meaningful:
  ```bash
  node --env-file=$STG apps/mcp/scripts/quarantine.ts reject --message <msg_id> --by "<you>" --why "email trial"
  ```
  Re-run until it prints `ALL CLEAR`. `--fail-on-attention` exits 2 while anything is listed, for cron.

## 10. Afterwards

- Save `report.md` with the sprint notes. Keep `raw/` and `run.json` private; delete them when they're no longer needed.
- **If `READY`:** the next step is one deal with one friendly, consenting vendor on staging (`docs/pilot-onboarding.md`, `docs/staging.md` §7.4).
- **If anything else:** nothing further until the engine fix is made and the trial repeated with a new `--run`.
- **Full rollback of the staging release:** redeploy `<ROLLBACK>` (§3); restore the §2 dump only if data must go back too.
