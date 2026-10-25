# Production deploy: the public live launch

The complete runbook for putting Haggle in front of the public, live: any visitor can sign up on the web app, add the businesses they work with, and have Haggle contact them for real by email, Voice AI call and text through Inkbox. Payment is the **manual handoff** (`HAGGLE_PAYMENTS=manual`): the human pays the vendor directly, and Haggle never holds or moves money. Live Stripe keys are refused.

This document builds on the existing ones. It links to them for detail and doesn't repeat them:

| Doc | What it has |
|---|---|
| [deployment.md](deployment.md) | The MCP server: environments, `config.ts` checks, every env var rule, the migration ledger, Manufact deploy, smoke, `/health` and `/ready`, CI |
| [staging.md](staging.md) | The staging environment, step by step, and `staging-release.ts`. **Do all of it first:** production repeats it with production accounts |
| [env-manifest.md](env-manifest.md) | Every server variable, generated from `apps/mcp/src/envManifest.ts` |
| [web-app.md](web-app.md) | The web app's architecture, auth, chat, dashboard and approvals |
| [backup-restore.md](backup-restore.md) | Supabase backups, PITR, the logical dump before every migration, restore drills |
| [runbook-incidents.md](runbook-incidents.md) | After-deploy checks, rollback criteria, incident handling |
| [pilot-launch-checklist.md](pilot-launch-checklist.md) | The controlled pilot that should come before a public launch |
| [demo-deploy.md](demo-deploy.md) | The public **demo** (mock mode). A separate deployment that keeps working alongside production |

Every step is marked **[YOU]** (a dashboard or account action; nothing in this repo performs it) or **[SCRIPT]** (a command from this repo, run from the repo root of a clean checkout of the exact commit you deploy).

**Never put a secret in git, in a build argument, or in a `NEXT_PUBLIC_*` variable.** Secrets go only in the hosts' environment settings and in env files kept outside the repository (`chmod 600`). Prefer pasting into dashboards over CLI flags, which land in shell history.

---

## 0. The shape of production

```
 visitors ──https──▶ web app (apps/web, Next.js)         Vercel, or a container host (apps/web/Dockerfile)
                        │  Supabase Auth (sign-in), chat (Claude), dashboard
                        │  x-haggle-service-token + x-haggle-workspace on every call
                        ▼
                     MCP server (apps/mcp)                  Manufact, HAGGLE_ENV=production, HAGGLE_MODE=live
                        │  engine → Inkbox (email, Voice AI calls, iMessage/SMS) · Claude · Google Places
                        ▼
                     Supabase production project            Postgres (engine 1xx, brain 2xx, web 3xx) + Auth
 Inkbox ──webhooks──▶ https://<mcp host>/webhooks/inkbox    replies, call transcripts, texts
 scheduler ─────────▶ https://<web host>/api/cron/tick      backup of the server's own 30 s tick
```

The web app and the MCP server **share one Postgres database**: the web tables (`workspace_members`, `chat_threads`, `web_profiles`) reference the server's `public.workspaces`.

The public demo (`NEXT_PUBLIC_HAGGLE_DEMO=true`, a mock-mode server) is a **separate** deployment with its own Supabase project, server and token. Never point the demo at production, or production at the demo's server.

---

## 1. Accounts to create [YOU]

Production gets its own account or project at every provider: nothing is shared with staging or the demo.

| Provider | What | Notes |
|---|---|---|
| **Supabase** | A production project, e.g. `haggle-prod`, on a **paid plan** with PITR | Same region as the MCP server. Note the **project ref** |
| **Manufact** | A production MCP server | Its own checkout and `.mcp-use/cloud/link.json` ([staging.md](staging.md) §1.5 has the pattern) |
| **Vercel** (or a container host) | The web project | Vercel **Pro**: Hobby is for non-commercial use, and its crons run at most daily |
| **Inkbox** | The production buyer identity (mailbox + phone number), API key, webhook signing secret | Voice AI calls and texts need the identity's phone number |
| **Anthropic** | Two API keys with spend limits: one for the server, one for the web chat | Separate keys keep the two spends apart |
| **Google Cloud** | A Places API key, restricted to the Places API | Optional: without it, discovery of real businesses is off |
| **Cloudflare** | A Turnstile widget (site key + secret key) for the web app's hostname | Bot protection on sign-in |
| **AWS SES** (or another SMTP provider) | A verified sending domain for sign-in emails | Supabase's built-in mailer is rate-limited and not for production |
| **Slack** | An incoming webhook for `#haggle-prod-alerts` | The URL is itself a secret |
| **DNS** | The domain, e.g. `haggle.example` | `app.` for the web app; optionally `mcp.` for the server |

---

## 2. Every key and secret, and which service gets it

Generate each shared secret once, on a trusted machine, and paste it into each host that needs it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # 43 characters
```

Make three different values: `HAGGLE_SERVICE_TOKEN`, `HAGGLE_TICK_SECRET` and `CRON_SECRET`. Never reuse one for another.

### 2.1 MCP server (Manufact): live mode

Set in the Manufact dashboard (or `mcp-use servers env set <server-id> KEY=VALUE`; the id, not the slug). The rules for each are in [env-manifest.md](env-manifest.md). `config.ts` refuses to start on any error and names the variable.

| Variable | Value | Secret |
|---|---|---|
| `HAGGLE_ENV` | `production` | |
| `HAGGLE_MODE` | `live` (production refuses mock) | |
| `HAGGLE_PAYMENTS` | `manual` | |
| `HAGGLE_BUILD_SHA` / `HAGGLE_BUILD_TIME` | the deployed commit and build time, per deploy ([deployment.md](deployment.md) §5 step 4) | |
| `SUPABASE_DB_URL` | the production **session pooler** URL (port 5432, `postgres.<ref>` user, BYPASSRLS role) | yes |
| `HAGGLE_PROD_DB_HOSTS` | the production **project ref** (set it on staging and the demo too) | |
| `HAGGLE_DB_POOL_MAX` | `4` (keep `replicas × pool + scripts` under the pooler's 15) | |
| `INKBOX_API_KEY` | the production identity's key | yes |
| `INKBOX_WEBHOOK_SECRET` | the production subscription's signing secret | yes |
| `INKBOX_IDENTITY` | the production handle | |
| `HAGGLE_ENABLE_CALLS`, `HAGGLE_ENABLE_IMESSAGE` | `true` once each channel is tested on staging (both off by default). Leave `HAGGLE_ENABLE_SMS` off until the 10DLC registration is approved; `HAGGLE_ENABLE_A2A` only with allowlisted Agent Cards | |
| `HAGGLE_EXTERNAL_SENDERS` + `HAGGLE_REPLY_TOKEN_SECRET` | `reply_token` + a 16+ character secret, so real vendors' replies from their own mail servers are accepted | yes (the secret) |
| `ANTHROPIC_API_KEY` | the server's key | yes |
| `HAGGLE_AI_MAX_CALLS_PER_JOB` | e.g. `60` | |
| `HAGGLE_AI_DAILY_TOKEN_BUDGET` | your daily cap, e.g. `5000000` (production warns when unset) | |
| `GOOGLE_PLACES_API_KEY` | the Places key (discovery; off when absent) | yes |
| `HAGGLE_SERVICE_TOKEN` | the shared web token (≥ 32 characters; **same value on the web app**) | yes |
| `HAGGLE_WEB_APPROVALS` | leave unset (on when the service token is set) so the signed-in owner can approve and report payment in the web app; `false` forces approvals back to the approver's coded text | |
| `HAGGLE_TICK_SECRET` | ≥ 16 characters; **same value on the web app** (the cron backup) | yes |
| `HAGGLE_ALERT_WEBHOOK_URL` | the Slack webhook (`https://` only) | yes |
| `HAGGLE_CONTACT_HOURS` / `_DAYS` / `_TIMEZONE`, `HAGGLE_CALL_HOURS` | when vendors may be contacted (defaults: Mon–Sat 08:00–19:00 Pacific; calls 9–20) | |
| `HAGGLE_RATE_TOOL_CALLS_PER_MIN` / `_BURST` | the per-credential tool-call limit (default 120/min in live mode) | |

`HAGGLE_AUTH` matters only in mock mode: a live server always requires a workspace credential (or the service token + workspace header). Never set any mock or rehearsal flag on production; `config.ts` refuses them ([deployment.md](deployment.md) §1 lists them). Never set `STRIPE_*` or `HAGGLE_ENABLE_PAYMENTS` on production: manual payment needs none of them, and live Stripe keys are refused anyway.

**Brain profile store.** If the brain should keep business profiles in Supabase, also set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the server (the same production project; secret).

### 2.2 Web app (Vercel, or the container's runtime env)

| Variable | Value | Secret | When it's read |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | no (public) | **build** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon (publishable) key; **never** the service-role key | no (public) | **build** |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | the Turnstile site key | no (public) | **build** |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | e.g. `support@haggle.example` | no | **build** |
| `NEXT_PUBLIC_HAGGLE_DEMO` | **unset** (or anything but `true`) on the live site | no | **build** |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role key (server only) | yes | run |
| `HAGGLE_MCP_URL` | the MCP server's **https base URL, without `/mcp`**, copied from the Manufact dashboard | no | run |
| `HAGGLE_SERVICE_TOKEN` | same value as the server's | yes | run |
| `HAGGLE_TICK_SECRET` | same value as the server's | yes | run |
| `CRON_SECRET` | ≥ 16 characters (Vercel sends it as the cron's bearer) | yes | run |
| `ANTHROPIC_API_KEY` | the web chat's key | yes | run |
| `WEB_CHAT_DAILY_CAP` | chat turns per day across the site, e.g. `2000` | no | run |
| `WEB_CHAT_MODEL` | optional (default `claude-opus-5-5`) | no | run |

`NEXT_PUBLIC_*` values are **inlined into the browser bundle at build time**. Changing one needs a rebuild, and anything in them is public. The pre-deploy check (§7.1) fails if a secret-shaped `NEXT_PUBLIC_*` variable exists or if the anon key is really a service-role key.

### 2.3 Supabase

| Setting | Value |
|---|---|
| Auth → SMTP | SES SMTP host, port 587, the SES SMTP user and password (secret), sender `no-reply@<your domain>` |
| Auth → Attack Protection → Captcha | Turnstile, with the Turnstile **secret** key |
| Auth → URL Configuration | Site URL and Redirect URLs (§3.3) |
| Auth → Providers → Google | client id and secret, optional (§3.3) |

---

## 3. Supabase production project

### 3.1 Create it and protect it [YOU]
1. Create the project on a paid plan. Note the **project ref** and copy the **session pooler** connection string (Database → Connect, port 5432).
2. **Turn on PITR** (Database → Backups). Note the retention. [backup-restore.md](backup-restore.md) §1 lists what to verify. Don't contact a real vendor before backups are confirmed.
3. Settings → API: copy the Project URL, the `anon` key (web, public) and the `service_role` key (web server and brain, secret).

### 3.2 Migrations, through the ledger, in order [SCRIPT]
Production starts empty, so apply **every** file in `supabase/migrations/` in filename order: engine `1xx`, then brain `2xx`, then web `300`, `301`, `302`. Use one transaction per file, and take a logical dump before each later release ([backup-restore.md](backup-restore.md) §2). `302_web_profiles.sql` stores Terms acceptance. Web migrations reference `public.workspaces` (from `103`), so they always come after the engine files.

With the production env file outside the repo (`HAGGLE_ENV=production`, `SUPABASE_DB_URL=…`):

```bash
set -a; . ~/.config/haggle/production.env; set +a
for f in supabase/migrations/*.sql; do
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -1 -f "$f" || break
done
# The ledger (111) exists now: record what was applied, then check.
node apps/mcp/scripts/migrations.ts backfill --through "$(ls supabase/migrations | tail -1)" --confirm
node apps/mcp/scripts/migrations.ts verify
node apps/mcp/scripts/migrations.ts status      # no drift, nothing pending
```

`backfill` records every file up to the last, the web and brain files included. It is your assertion that they are applied: run it only after the loop finished with no error. **Every later release:** apply only the new files, then `migrations.ts record <file> --confirm` for each ([deployment.md](deployment.md) §4). Apply migrations **before** deploying the code that needs them.

### 3.3 Auth [YOU]
1. **Email sign-in through your own SMTP.** In AWS SES, verify the sending domain, add the DKIM CNAMEs and an SPF include (`v=spf1 include:amazonses.com ~all`) plus a DMARC record, and leave the SES sandbox (request production access). Create SMTP credentials and enter them under Auth → SMTP. Then raise Auth → Rate Limits → emails per hour to what SES allows.
2. **Captcha.** Auth → Attack Protection: enable captcha with Cloudflare Turnstile and the Turnstile **secret** key. The web app renders the widget when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set and passes the token to Supabase. Set both or neither: with only one, sign-in fails.
3. **Anonymous sign-ins: OFF** on production. Guests exist only on the demo, and the live web app refuses anonymous sessions anyway.
4. **URL configuration.** Site URL `https://app.<domain>`. Redirect URLs: `https://app.<domain>/auth/callback` only. No localhost and no preview wildcards on production.
5. **Google (optional).** Create an OAuth client in Google Cloud. Use the authorized redirect URI that Supabase shows (`https://<ref>.supabase.co/auth/v1/callback`), and put the client id and secret under Auth → Providers → Google. Publish the OAuth consent screen with the Privacy and Terms URLs (§10).
6. Email templates: brand the magic-link email. Keep `{{ .ConfirmationURL }}` intact.

---

## 4. MCP server on Manufact [YOU + SCRIPT]

Follow [deployment.md](deployment.md) §3 (pre-deploy gate) and §5 (deploy) with the **production** link file and env. In short:
1. Set every variable in §2.1 in the dashboard.
2. Start command: `cd apps/mcp && ../../node_modules/.bin/mcp-use start --host 0.0.0.0`, port 3000.
3. Run the launch gate against the production env file (§7.2), then deploy from a clean worktree of the commit, then set `HAGGLE_BUILD_SHA`.
4. **Copy the MCP URL from the Manufact dashboard.** Never guess it. The web app's `HAGGLE_MCP_URL` is that URL **without** the trailing `/mcp`.
5. Optional custom domain `mcp.<domain>` (Manufact dashboard → domains, plus the CNAME it gives). Update `HAGGLE_MCP_URL` and the Inkbox webhook URL if you switch.

Run one instance unless you have accounted for per-process state (§12).

---

## 5. Web app

### 5.1 On Vercel [YOU]
1. Import the repository. Root Directory: `apps/web`. Framework: Next.js. Keep "Include files outside the root directory" on: npm workspaces install from the repo root and `@haggle/core` is compiled from source.
2. Set the variables in §2.2 for the **Production** environment only. Preview deployments must not get production secrets: give Preview its own staging values, or none.
3. **The cron.** `apps/web/vercel.json` declares `GET /api/cron/tick` every 5 minutes. Vercel calls it with `Authorization: Bearer $CRON_SECRET`. The route forwards one `POST /internal/tick` to the MCP server with `HAGGLE_TICK_SECRET` and returns the server's JSON (`{ ok, … }`). Without `CRON_SECRET` it answers 404 and nothing runs.
   - **Plans:** Hobby crons run at most once a day, and a more frequent schedule fails the deploy. Pro allows every minute. Production needs Pro anyway (commercial use).
   - **This is a backup.** The live MCP server ticks itself every 30 s (deadlines, follow-ups, email → call escalations). The cron only covers a server whose own timer stalled, or an idle instance woken by the request.
   - **Alternatives**, if the web isn't on Vercel or you'd rather not depend on it: an **AWS EventBridge Scheduler** rule (`rate(1 minute)`) with an API destination that `POST`s to `https://<mcp host>/internal/tick` with the `Authorization: Bearer <HAGGLE_TICK_SECRET>` header (keep the secret in its Connection). Or **Supabase `pg_cron` + `pg_net`**: `select cron.schedule('haggle-tick', '* * * * *', $$ select net.http_post(url := 'https://<mcp host>/internal/tick', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'haggle_tick_secret'))) $$);` with the secret stored in Supabase Vault, never inline. Both call the MCP server directly, so `CRON_SECRET` isn't needed.
4. **Function duration.** The chat and deal-stream routes stream for up to 300 s (`maxDuration`). Keep Fluid compute on (the default for new projects), and check the project's maximum duration allows 300 s. The SSE client reconnects after a cut either way.
5. Domains: add `app.<domain>` to the project. Vercel issues the certificate.

### 5.2 On a container host (AWS ECS / App Runner, Azure Container Apps) [YOU + SCRIPT]
`apps/web/Dockerfile` builds a standalone Next.js server: a multi-stage build that installs from the root lockfile, runs `next build` with `NEXT_OUTPUT=standalone`, and serves `node server.js` on port 3000 as the unprivileged `node` user. The build context is the **repo root**. Its ignore file is `apps/web/Dockerfile.dockerignore`, which keeps every `.env*`, `node_modules` and `.next` out of the context.

```bash
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key> \
  --build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY=<site key> \
  --build-arg NEXT_PUBLIC_SUPPORT_EMAIL=support@<domain> \
  -t <registry>/haggle-web:$(git rev-parse --short HEAD) .
docker push <registry>/haggle-web:<sha>
```

- **One image per environment:** the public values are baked in. Never pass a secret as `--build-arg`, because build args are recorded in the image history.
- **Runtime secrets** (§2.2's "run" rows) come from the host's secret store: AWS Secrets Manager or SSM in the ECS task definition, or Azure Container Apps secrets. Set `HOSTNAME=0.0.0.0` and `PORT=3000` (the image's defaults).
- **Health check:** HTTP `GET /api/health`. Run with an init process (`docker run --init`; ECS `initProcessEnabled: true`) so SIGTERM reaches node.
- **Load balancer:** allow responses of at least 300 s with no buffering for `/api/chat` and `/api/deals/*/stream` (ALB idle timeout ≥ 310 s; App Runner caps requests at 120 s, so prefer ECS or Container Apps). Terminate TLS at the balancer.
- **The cron** on a container host: use one of the alternatives in §5.1 step 3, or any scheduler calling `GET https://app.<domain>/api/cron/tick` with `Authorization: Bearer <CRON_SECRET>`.
- CI builds this image on every web change (`.github/workflows/web-image.yml`, placeholder values, never pushed). It checks there's no `.env` file in the image, a non-root user, and that the app answers.

---

## 6. DNS, domains and Inkbox webhooks

### 6.1 DNS [YOU]
- `app.<domain>` → Vercel (CNAME `cname.vercel-dns.com`) or the load balancer.
- Optional `mcp.<domain>` → the CNAME Manufact gives.
- SES: the DKIM CNAMEs, SPF and DMARC from §3.3. The Inkbox mailbox's own domain records, if Inkbox sends from your domain (follow Inkbox's domain setup).
- Add CAA records for the issuers in use (Vercel / Let's Encrypt, Amazon) if you use CAA.

### 6.2 Inkbox webhooks to the production server [YOU, after the first deploy]
For the production buyer identity, create the subscription. Use the Inkbox dashboard, or `inkbox.webhooks.subscriptions.create({ agentIdentityId, url, eventTypes })` from your own machine.
- **URL:** `https://<mcp host>/webhooks/inkbox`.
- **Events:** `message.received`, `message.bounced` and `message.failed` (all three required; the launch gate fails without them), plus `call.ended` (calls), `imessage.received` (texts and approvals by text) and `a2a.sent_task.updated` (A2A), for each channel you enable.
- Check that the mailbox's inbound filter isn't `whitelist`, and that the identity's phone number is attached if calls or texts are on.
- Check it read-only with the gate (§7.2, `--check-webhooks`).

---

## 7. First-run checks

Run all of them on every production deploy. Each one prints names and statuses only, never a value.

### 7.1 `check-env` (web) [SCRIPT]
```bash
vercel env pull --environment=production ~/.config/haggle/web-production.env   # or write the file by hand
node apps/web/scripts/check-env.ts --env-file ~/.config/haggle/web-production.env
```

It checks every variable in §2.2. A missing or invalid value, `NEXT_PUBLIC_HAGGLE_DEMO=true`, an anon key that is really a service-role key, a short token, an http or `/mcp` `HAGGLE_MCP_URL`, or a secret-shaped `NEXT_PUBLIC_*` all FAIL. A missing Turnstile key, daily cap or support email WARN. The script exits 1 on any FAIL. Use `--site demo` for the demo site and `--json` for machines.

### 7.2 `launch-gate` and `pilot-preflight` (server) [SCRIPT]
```bash
node apps/mcp/scripts/launch-gate.ts --target production --env-file ~/.config/haggle/production.env \
  --db-url-env SUPABASE_DB_URL --check-webhooks --webhook-url https://<mcp host>/webhooks/inkbox
node apps/mcp/scripts/pilot-preflight.ts --target production --env-file ~/.config/haggle/production.env \
  --db-url-env SUPABASE_DB_URL --check-webhooks --webhook-url https://<mcp host>/webhooks/inkbox
```

The gate checks config, migrations against the ledger, the build and the webhook events. Preflight adds the live-service checks: manual payments, contact window, signing secret, recipients and alerts. On a public launch, workspaces are created by sign-up, so `--workspace` is only for spot-checking one.

### 7.3 Smoke (server, read-only) [SCRIPT]
```bash
curl -s https://<mcp host>/ready        # 200, ready: true, build_sha = the deployed sha, migrations.ok: true
HAGGLE_SMOKE_TOKEN=<an internal test workspace bearer> node apps/mcp/scripts/smoke.ts https://<mcp host> --live-readonly --expect-build <sha>
```

`--live-readonly` never sends, calls, texts or pays ([deployment.md](deployment.md) §6). Create the test workspace once with `workspace-create.ts`, then mark it as test (`traction.ts mark-test`).

### 7.4 The web app [YOU + SCRIPT]
```bash
curl -s https://app.<domain>/api/health     # { ok: true, mcp: reachable, config: names only, demo: false }
curl -s -o /dev/null -w '%{http_code}\n' https://app.<domain>/api/cron/tick                        # 401 (no bearer)
curl -s -H "Authorization: Bearer $CRON_SECRET" https://app.<domain>/api/cron/tick                   # { ok: true, … } from the server
curl -sI https://app.<domain>/login | grep -i -E 'content-security-policy|strict-transport-security'   # both present, one CSP
curl -sI https://app.<domain>/login | grep -i -o "'nonce-[^']*'"   # run twice: a different nonce each time
```

In a private window: the landing page shows **no** DEMO banner and no guest button. Email sign-in sends a mail from your SES domain, the captcha appears, and onboarding requires accepting the Terms.

---

## 8. Manual end-to-end test, with a real vendor who agreed [YOU]

The first real contact. Use one business that has agreed in writing to be contacted (a friend's shop, or a vendor you already buy from), and your own phone as the approver.
1. Sign up on `https://app.<domain>` with a fresh account and finish onboarding.
2. **Vendors → Add vendor:** the business's email. Choose the consent basis honestly ("business agreed") and tick the attestation.
3. **Chat:** a small, real request ("Quote for lunch for 10 next Friday"). Confirm the dry run, which must list exactly that vendor and channel, then start it.
4. On the deal page, the vendor shows as contacted. Their real reply becomes a quote (a token-verified email reply). If calls are on and the vendor agreed to calls, the email → call escalation can be tested the same way.
5. **Approve** in the web app. The confirm dialog shows the business, the amount and any caveats. Wait for the vendor's written confirmation. The payment instructions are shown as untrusted text from the business: verify them out of band. **Pay the vendor yourself**, click "I've paid the vendor", and wait for the vendor's receipt confirmation.
6. Check:
   - `node apps/mcp/scripts/metrics.ts --workspace <id>`: the deal is in the REAL bucket;
   - `ops-report`: no stuck jobs;
   - the Manufact logs: no `*_failed`;
   - the alert channel: quiet.
7. Account → **Download my data**, then **Delete my account** on a second test account: its service access stops at once.

Don't open sign-ups publicly before this has passed once end to end.

---

## 9. Rollback

| What | How |
|---|---|
| **Web app (Vercel)** | Deployments → the previous production deployment → **Promote to Production** (instant; no rebuild) |
| **Web app (container)** | Redeploy the previous image tag (the tag is the commit sha) |
| **MCP server** | Redeploy the previous commit ([deployment.md](deployment.md) §5 rollback; note the deployment id before every deploy). The schema stays: `/ready` reports newer migrations as `unexpected` and stays ready |
| **Database** | Restore only for data loss or corruption: PITR or the pre-migration dump ([backup-restore.md](backup-restore.md) §4). Stop outbound work first ([runbook-incidents.md](runbook-incidents.md) §3.0) |
| **Stop all outbound contact now** | Scale the Manufact server to zero. To stop one user, `workspace-admin.ts suspend --id <ws> --by <you> --reason "<why>"` (tools refuse, deals held; revoking credentials alone doesn't pause in-flight deals) |
| **Close sign-ups** | Supabase Authentication → Sign In / Providers: turn off "Allow new users to sign up" (existing users can still sign in) |

The criteria for rolling back are in [runbook-incidents.md](runbook-incidents.md) §2. Roll the web app and the server back independently: the web app only calls the server's tools and `/internal/*` routes, so roll back the one that changed.

---

## 10. Cost controls and abuse limits

| Control | Where | Set it to |
|---|---|---|
| `WEB_CHAT_DAILY_CAP` | web | Chat turns per UTC day, site-wide (e.g. `2000`). Past it, the chat answers 429 until tomorrow |
| Per-user chat limit | web (code) | 20 turns per 10 minutes per user |
| Approval route limit | web (code) | 30 actions per minute per user |
| `HAGGLE_AI_DAILY_TOKEN_BUDGET`, `HAGGLE_AI_MAX_CALLS_PER_JOB` | server | Claude tokens per day and calls per job. Past them, replies wait for the human and nothing fails open |
| Anthropic spend limits | Anthropic console | A monthly limit on **both** keys, with email alerts |
| Per-workspace vendor limits | server (code) | At most 100 vendors per workspace and 25 additions per day |
| `HAGGLE_RATE_TOOL_CALLS_PER_MIN` | server | Tool calls per credential per minute (120 by default in live mode) |
| Contact window | server | `HAGGLE_CONTACT_HOURS` / `_DAYS`: vendors are never contacted outside it |
| Turnstile + SMTP rate limits | Supabase | Bots can't mass-create accounts or burn the email quota |
| Inkbox, Google Cloud, Vercel, AWS | consoles | Billing alerts and quotas (Places API daily quota, Vercel spend management) |

---

## 11. Before opening to the public [YOU]

- **Counsel review.** The Terms, Privacy and Acceptable Use pages ship marked "Draft: to be reviewed by counsel before launch". Have them reviewed, then remove the banner. Review especially:
  - AI calls: disclosure on every call; consent and recording rules per state (all-party-consent states); TCPA for calls and texts to businesses' mobile numbers; outreach hours;
  - CAN-SPAM for outreach email (identification, opt-out honored);
  - the processors (Anthropic, Inkbox, Supabase, Vercel or AWS, Google);
  - data retention and deletion.
- **Approver texts.** The user's approver phone is optional now (approvals happen in the web app). Text approvals still need iMessage (the human texts `connect @<handle>` first) or an approved 10DLC campaign for SMS.
- **Support.** A monitored `NEXT_PUBLIC_SUPPORT_EMAIL` inbox, and the opt-out path a business uses to stop contact (suppressions: [runbook-incidents.md](runbook-incidents.md)).
- **Branch protection** on `main`: require "CI / verify"; deploy only reviewed commits.

---

## 12. What's still not production-grade

- **Limits: mostly shared, some still per process.** Since migration `124_engine_rate_limits` these are counted in the shared database (`take_rate_slot`), so every web instance and MCP replica counts together:
  - the chat's per-user turns (20 per 10 minutes) and the site-wide daily cap (`WEB_CHAT_DAILY_CAP`);
  - the approval routes (30 actions per user per minute);
  - the web vendor routes (20 changes and 10 searches per user per minute);
  - the account routes (3 deletion attempts and 5 exports per user per 10 minutes);
  - the MCP server's vendor additions (25 per workspace per UTC day).

  The windows are fixed and aligned to the clock (a 10-minute window starts on the 10-minute mark; the day is the UTC day). If the database can't answer (124 not applied, an outage, more than 2 s), each instance falls back to its own memory count and logs `rate_limit_fallback` (web) or `vendor_daily_limit_fallback` (MCP) once per outage; a database hiccup never refuses a user.
  The AI budget (`HAGGLE_AI_DAILY_TOKEN_BUDGET`, `HAGGLE_AI_MAX_CALLS_PER_JOB`) is still enforced in memory, but each replica rehydrates it from `ai_usage_events` at start-up and every 60 s, so a restart doesn't reset it and replicas converge within a minute (between hydrates each can overshoot by its own calls).
  **Still per process:** double-click joining on the approval routes (a repeat reaching another instance is safe: approval transitions are compare-and-set and sends are idempotent by key), the alert dedupe and rate limit (a duplicate alert across replicas is acceptable) and the MCP tool-call bucket (`apps/mcp/src/limits.ts`). So still run **one** MCP replica.
- **The service token is a root credential** for every web workspace. It lives only on the two servers. Rotate it (set the new value on both, server first) if it may have leaked.
- **Legal.** Terms, Privacy and Acceptable Use are drafts, and the calling and texting rules above need counsel's sign-off.
- **Browser tests are partial.** Playwright covers the public pages under the nonce CSP (in CI) and a demo guest's deal → approve → pay against a local Supabase and a scripted fake Claude (local only, needs Docker): [web-app.md "Browser tests"](web-app.md#browser-tests-playwright). Signed-in email/Google flows, a live (non-demo) deal and real Claude replies are still checked by hand.
- **CSP: styles still allow inline.** Scripts are nonce-based: `apps/web/proxy.ts` mints a fresh nonce per request and sends one policy (`apps/web/lib/csp.ts`) with `script-src 'self' 'nonce-…' 'strict-dynamic'` and no `'unsafe-inline'`, so every page renders per request (the root layout awaits `connection()`; no page is prerendered). `style-src` keeps `'unsafe-inline'` because the app uses React `style` attributes, which a style nonce would block; injected CSS can't run script under this policy.
- **The container image was built only in CI**, not on a production host yet. The Vercel cron and the alternatives in §5.1 haven't been run against a production server.
- **Brain tenancy: fixed in code; one operator step.** Business profiles are scoped per workspace (`202_brain_tenancy`): one workspace's deals never inform another's estimates, price checks or profiles. Apply `supabase/migrations/202_brain_tenancy.sql` to the brain's database **before** deploying that build (`docs/deployment.md` §4); `pilot-preflight` reports PASS from the build alone and does not verify the database; the running server does: `GET /ready` shows `checks.brain` (`schema_missing` until 202 is applied, which makes the server unready) and start-up logs `brain_schema_check_failed` once. Profiles learned before 202 were pooled from every workspace, so 202 parks them under the reserved `ws_legacy_pooled`, which no workspace reads; a single-tenant deployment may hand them to its workspace with one `update brain_profiles set workspace_id = 'ws_<id>' where workspace_id = 'ws_legacy_pooled'`.
