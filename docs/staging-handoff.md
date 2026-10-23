# Staging handoff: who sets up what (Yashnil + Aarnav)

Staging is built by two people from one shared secrets vault. This page says who owns each piece, exactly what Aarnav configures on Manufact and Inkbox, what each person reports back, how both build their local env file, and the go/no-go gates that must pass before migrations, any deploy and any external email.

It does not repeat the procedures. The authoritative runbooks are:
- `docs/staging.md`: what staging is, every variable, release, verify, roll back;
- `docs/staging-email-trial-runbook.md`: the first deploy and the consenting-mailbox trial, step by step;
- `docs/deployment.md` §4–5: the migration ledger and Manufact CLI upload.

**Fixed identifiers** (not secrets):

| | Production (never touched from staging) | Staging |
| --- | --- | --- |
| Supabase project | `behfuaxftitnzkkbnaia` | `vsvcgzesbhjmxwnnqjkh` |
| Manufact server | `calm-spark-ck3qm` | to be created by Aarnav (§3) |
| Inkbox buyer identity | `haggle` (Yash's org) | to be created by Aarnav (§4); never `haggle` |

Status on 2026-10-22:
- **Supabase:** the staging project exists, reached through the session pooler `aws-0-us-east-1.pooler.supabase.com:5432`. Postgres 17.11, `public` schema empty, no migrations applied.
- **Anthropic:** the staging key authenticates and can use `claude-sonnet-5-5`. Workspace `wrkspc_016wWanebQdavDeFHZ1fVKra`; its spend limit is not yet confirmed.
- **Vault:** both are in the shared vault.
- **Not yet created:** Manufact and Inkbox staging.

## 1. Who owns what

| Area | Owner | Done when |
| --- | --- | --- |
| Supabase staging project, `SUPABASE_DB_URL` (pooler), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Yashnil | in the vault ✅ |
| Anthropic staging key, workspace spend limit, `HAGGLE_AI_*` budgets | Yashnil | key in vault ✅; spend limit confirmed in the Console |
| `HAGGLE_REPLY_TOKEN_SECRET` (generated in the vault, ≥ 16 characters) | Yashnil | in the vault |
| Engine migrations (`1xx_engine_*`) on staging, via `staging-release.ts` | Yashnil | `migrations.ts verify` OK |
| Brain migrations (`2xx_brain_*`) on staging | Aarnav | `brain_profiles` exists on staging |
| Manufact staging server, its env vars, the link file | Aarnav | §3 done, §5 report shared |
| Inkbox staging identity, its API key, webhook secret, inbound filter, webhook subscription | Aarnav | §4 done, §5 report shared |
| Staging Slack alert webhook (`HAGGLE_ALERT_WEBHOOK_URL`) | **not yet assigned**: agree who | in the vault |
| Staging workspace and `HAGGLE_SMOKE_TOKEN` (`workspace-create.ts`) | Yashnil | token in the vault |
| Email trial (send, reply, collect) | Yashnil, from his own mailboxes | verdict `READY` |
| Go/no-go sign-off (§7) | both | each gate's boxes ticked by both |

The env variable names are those in `docs/env-manifest.md`. Nobody renames them.

## 2. The shared vault and your local env file

**Vault layout.**
- One item per variable, titled with the exact env name (e.g. `INKBOX_API_KEY`), in the **Haggle Staging** vault.
- One non-secret note, **"Staging config (non-secret)"**, holds the §5 reports.
- Production credentials never go in this vault.

**Rules.**
- Values move only vault → dashboard, or vault → your local file.
- Values never go into chat, email, issues, PRs, commits, CI or a shell command line (`servers env set KEY=VALUE` puts the value in shell history, so use the Manufact dashboard).
- If a value lands anywhere else, rotate it and replace the vault item.

**Build your local file** (each of you, on your own machine):
1. Create it private before writing anything:
   ```bash
   mkdir -p ~/.config/haggle && chmod 700 ~/.config/haggle
   (umask 077; touch ~/.config/haggle/staging.env)
   ```
2. Open it in an editor and paste each value from the vault under its exact name. Use the list in `docs/staging.md` §2.1. If your vault has a CLI that renders a template into a file, use that instead, writing only to this path.
   - Don't put it in a synced folder (iCloud Drive, Dropbox).
   - Don't `cat` it, and don't `source` it into a shell you also use for production.
3. Check it without printing values:
   ```bash
   stat -f %Lp ~/.config/haggle/staging.env                          # 600 (Linux: stat -c %a)
   grep -oE '^[A-Z0-9_]+=' ~/.config/haggle/staging.env              # names only
   node apps/mcp/scripts/staging-release.ts --env-file ~/.config/haggle/staging.env   # offline plan
   npx tsx apps/mcp/scripts/pilot-preflight.ts --target staging --env-file ~/.config/haggle/staging.env --db-url-env SUPABASE_DB_URL   # read-only
   ```
   The plan must show no `REFUSED database` or `REFUSED environment` line. Until §3 is done it shows `REFUSED manufact`.

**Local-only variables** (never on the server):
- `HAGGLE_SMOKE_TOKEN`;
- `HAGGLE_EMAIL_TRIAL`, `HAGGLE_EMAIL_TRIAL_MAILBOXES`.

**The PostgreSQL 17 client tools** are needed only by whoever runs migrations (Yashnil): `brew install postgresql@17`, then `PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH`.

## 3. Aarnav: the Manufact staging server

Background is in `docs/staging.md` §1.5 and `docs/deployment.md` §5. The exact steps (mcp-use CLI 2.10.0):

1. **Use a separate clean checkout** of the agreed commit, never the working repo:
   ```bash
   git worktree add ../haggle-staging <agreed sha> && cd ../haggle-staging && npm ci
   ./node_modules/.bin/mcp-use whoami          # confirm the Manufact org you're in
   ```
   **Never copy `.mcp-use/cloud/link.json` from another checkout.** Production's names `calm-spark-ck3qm`, and `staging-release.ts` refuses it.
2. **Pick the Manufact org on purpose.** Both of you must be able to deploy and roll back, so use an org you are both members of.
3. **Before the first deploy:** pass gate G1 (§7). The first `mcp-use deploy` is what creates the server and writes the link file. The CLI has no link-only command.
4. **Create the server** with a managed upload, like production:
   ```bash
   ./node_modules/.bin/mcp-use deploy --new --no-github --name haggle-staging
   ```
   - Check `mcp-use deploy --help` first.
   - `--new` makes a new server; leaving it out could update a linked one.
   - `--no-github` uploads this exact checkout, the same way calm-spark is deployed.
5. **Server settings** (dashboard):
   - Start command: `cd apps/mcp && ../../node_modules/.bin/mcp-use start --host 0.0.0.0`.
   - Port: `3000`.
6. **Server env vars** (dashboard; secrets as write-only):
   - Set every name in `docs/staging.md` §2.1 except the local-only ones in §2.
   - Add `HAGGLE_EXTERNAL_SENDERS=reply_token` with `HAGGLE_REPLY_TOKEN_SECRET`.
   - Leave every `HAGGLE_ENABLE_*` off.
   - Leave `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` **unset** until the 2xx brain migrations are on staging. Otherwise the brain reads a `brain_profiles` table that doesn't exist yet.
   - Confirm the brain's Supabase client accepts the new-style `sb_secret_` key.
   - `HAGGLE_BUILD_SHA`/`HAGGLE_BUILD_TIME` are set per deploy (`docs/staging.md` §5).
7. **Check the names, not the values:** `./node_modules/.bin/mcp-use servers env list <staging server id>`.
8. **Expected after this first deploy:** `/ready` answers 503 until migrations are applied (G2). The server can't contact anyone yet: no subscription, no workspace, channels off.

## 4. Aarnav: the Inkbox staging identity

Background is in `docs/staging.md` §1.2 and §6.

1. **Create the identity** `haggle-staging`, with its own mailbox. The email trial refuses `haggle`, with no override.
   - **Org:** create it in your org, unless you both decide otherwise. A key in your org can't act on production's `haggle` (Yash's org).
   - Your simulated sellers trust a buyer only in their own org. Leave `INKBOX_SENDER_TRUST` at its default, `outbound-verified`, unless you both decide to pin the org.
2. **API key:** scoped to `haggle-staging` only, into the vault as `INKBOX_API_KEY`. Copy the webhook signing secret into the vault as `INKBOX_WEBHOOK_SECRET`. Put `INKBOX_IDENTITY=haggle-staging` in the server env and in both local files.
3. **Sender restrictions:**
   - **Inbound:** if the identity's inbound mail filter is in whitelist mode, allow exactly the two trial mailboxes Yashnil names, and later each consenting pilot vendor. Nothing else.
   - **Outbound:** no extra allowance. `HAGGLE_ALLOWED_RECIPIENTS` stays unset; deals reach only each workspace's own consenting vendors.
   - No phone number, iMessage or A2A on staging until each is tested.
4. **Webhook subscription:** create it only after the server exists (§3) and gate G3's first two boxes are ticked.
   - **URL:** `https://<staging host>/webhooks/inkbox`.
   - **Events:** `message.received`, `message.bounced`, `message.failed`, all three required. Add `call.ended`, `imessage.received` or `a2a.sent_task.updated` only for channels staging enables.
   - Check it read-only (`docs/staging-email-trial-runbook.md` §4); the gate fails if a mail event is missing.

## 5. What Aarnav reports (no credentials)

Put these into the vault note "Staging config (non-secret)", then tell Yashnil it's there. Values of keys, secrets and tokens are **never** part of the report; they're in their vault items.

```
Manufact
  org (slug):                         ...
  server id / slug:                   ... / ...
  MCP URL (copied from the dashboard): https://.../mcp
  staging host:                       https://...
  link.json keys (organizationId, serverId, serverSlug, sourceType): ...   # not secret; lets Yashnil link his staging checkout
  current deployment id (rollback point): ...
  start command and port confirmed:   yes/no
  env var NAMES set (servers env list): ...
Inkbox
  org (whoami):                       ...
  identity handle / mailbox address:  haggle-staging / ...
  agent identity id:                  ...
  API key scope:                      haggle-staging only? yes/no
  inbound filter mode / allowed senders: ... / ...
  webhook subscription id, URL, events: ... (after G3)
Vault items added:                    INKBOX_API_KEY, INKBOX_WEBHOOK_SECRET (names only)
Decisions taken:                      Manufact org, Inkbox org, sender trust
```

## 6. Yashnil: after the report

1. **Link a staging checkout of your own:** a fresh worktree of the same sha, with `.mcp-use/cloud/link.json` written from the reported keys. Then run the offline plan; `REFUSED manufact` must be gone.
2. **Migrations** (after G2), from that checkout:
   ```bash
   node apps/mcp/scripts/staging-release.ts --env-file ~/.config/haggle/staging.env --execute --backup-ref "new project, empty" --backfill-through none
   ```
   Then tell Aarnav to apply the 2xx brain migrations.
3. **Workspace and smoke token:** `docs/staging-email-trial-runbook.md` §2. The token goes into the vault.
4. **The trial:** runbook §3–§9, after G3 and G4.

## 7. Joint go/no-go gates

A gate passes only when both have ticked every box. Any unticked box is a **no-go**: stop, fix it, and re-run the gate. Gates are kept in this order.

### G1: before the first deploy (server creation)
- [ ] Both local files are 0600 and outside any repo or synced folder. The offline plan shows no `REFUSED environment` or `REFUSED database`.
- [ ] The pilot preflight `config` check passes: every required live variable is present, including the Inkbox ones.
- [ ] The vault holds every server variable. The Manufact dashboard has the same names; `HAGGLE_SMOKE_TOKEN` and the email-trial variables are not there.
- [ ] Every `HAGGLE_ENABLE_*` is off. `HAGGLE_PAYMENTS=manual`. `HAGGLE_PROD_DB_HOSTS=behfuaxftitnzkkbnaia`. `INKBOX_IDENTITY` isn't `haggle`.
- [ ] The checkout is a clean worktree of the agreed sha, CI is green on it, and it has no link file copied from elsewhere.

### G2: before migrations
- [ ] The §5 report is in the vault note; Manufact isn't `calm-spark-ck3qm`.
- [ ] The offline plan in Yashnil's staging checkout prints no `REFUSED` line at all.
- [ ] `psql --version` reports 17.x on the PATH used.
- [ ] A read-only check of the staging database matches expectations: empty `public` for the first release, or a ledger at the expected file.
- [ ] A backup is given (`--backup-ref` for the empty project; `--backup-dump` outside the repo afterwards).
- [ ] Both agree on the exact sha.

### G3: before the release deploy (and before the webhook subscription)
- [ ] `migrations.ts verify` OK; the launch gate passes, apart from the webhook check.
- [ ] The current deployment id is noted as `--rollback-ref`.
- [ ] After the deploy: `/ready` shows `ready: true`, `build_sha` equal to the sha, and `migrations.ok: true`. `smoke.ts --live-readonly --expect-build <sha>` reports `smoke OK`.
- [ ] Then the subscription (§4.4). `launch-gate.ts --check-webhooks` passes.

### G4: before any external email (the trial's `send`)
- [ ] `email-trial.ts check-subscription` lists no missing mail event. The inbound filter allows exactly the trial mailboxes.
- [ ] `HAGGLE_EMAIL_TRIAL_MAILBOXES` lists only mailboxes Yashnil owns. `validate` and `dry-run` pass (runbook §5).
- [ ] `ops-report --brief` prints `ALL CLEAR`.
- [ ] The pilot preflight shows no `FAIL`. `BLOCKED` items are only those needing a human outside this check.
- [ ] Both say go. Nothing beyond the one labelled test email is sent; the first real vendor deal needs a `READY` verdict and a separate decision.

## 8. Outdated references (reported, not changed here)

These live in shared files (`CLAUDE.md`, `CONTRACTS.md`, `PLAN.md`, `README.md`), which change only with both owners' agreement (CLAUDE.md §4). Proposed edits:

| File | Now | Proposed |
| --- | --- | --- |
| `CLAUDE.md` §1 | Hackathon event, "Building ends Sun 10:00 AM", tracks | Move to a history line; describe the pilot and staging/production. |
| `CLAUDE.md` §3 Deploy | `npx mcp-use deploy --name haggle --root-dir apps/mcp` (GitHub) or `npx -y mcp-use@latest deploy --no-github -y` | Point to `docs/deployment.md` §5: managed upload from a clean worktree at the repo root, link file per checkout, the start command; staging via `docs/staging-handoff.md`. As written it could deploy from the wrong source or a moving CLI version. |
| `CLAUDE.md` §0, §3, §7 | "payment through Stripe test mode" | The pilot uses the manual handoff (`HAGGLE_PAYMENTS=manual`); Stripe test mode is the only automated rail and is off in the pilot. |
| `CLAUDE.md` §4 | Branches `yash/*`, `aarnav/*`; the `haggle` identity only | The real branches (`yashnil`, Aarnav's); add the staging identity `haggle-staging` and the owner split above. |
| `CLAUDE.md` §6, §9 | The hackathon tool list and cut order | The tools `apps/mcp/index.ts` registers today (adds `list_deals`, `call_back`, `cancel_deal`, `negotiate`, `send_message`, `get_conversation`, `get_identity` and the `*_in_view` tools); drop the cut order. |
| `CLAUDE.md` §1 (legacy note) | Primitive/x402 "to replace" | Still accurate, but the files remain in `packages/engine` (`inbound/primitive.ts`, `outbound/primitiveSender.ts`, `payments/x402Challenge.ts`). Removing them is an engine change for Yashnil, in a separate pass. |
| `CONTRACTS.md` §6, env block | Stripe test mode as the payment step | Same manual-handoff note. The Primitive/x402 note is accurate. |
| `PLAN.md` | Hackathon schedule; `npx mcp-use deploy --name haggle --root-dir apps/mcp` | Mark it as the original plan; point deploys to `docs/deployment.md`. |
| `README.md` | "Deploy" section: `cd apps/mcp && … npx mcp-use deploy` | Deploy from the repo root with the link file (`docs/deployment.md` §5); link `docs/staging-handoff.md`. |

Non-shared, outdated docs (marked superseded in this pass, content kept as history): `docs/preflight-readiness.md` (Primitive, x402, pnpm spikes) and `docs/buyer-runbook.md`.
