# Deploying Haggle

The deployment checklist for the Haggle MCP server (`apps/mcp`). It was checked against the code on branch `yashnil` after pass 2, plus workstream E (2026-10-22). Every command here runs from the repo root of a **clean checkout of the exact commit you deploy**.

The stack:
- Email, Voice AI calls, iMessage and A2A all go through **Inkbox**.
- Quote extraction, question answering and the negotiation strategist use **Claude**.
- State lives in **Supabase Postgres**.
- Payments are a **manual handoff** (`HAGGLE_PAYMENTS=manual`) or **Stripe test mode**.

There is no Primitive or x402 in v5. Any `primitive*` / `x402*` code or `PRIMITIVE_*` variable is legacy and must not be configured.

## 1. Environments

The server reads two independent settings:
- `HAGGLE_ENV` says **where** it runs: `development` (the default when unset), `staging` or `production`.
- `HAGGLE_MODE` says **whether it talks to real providers**: `mock` (the default) or `live`.

`apps/mcp/src/config.ts` checks the configuration before the runtime is built, and it fails closed. With any problem the server serves only the following, and every message names the variable, never its value:
- the bare MCP handshake;
- `/health` and `/ready`, both answering 503 with the problems;
- `CONFIG_MISSING` from every tool.

| | development | staging | production |
|---|---|---|---|
| `HAGGLE_MODE` | `mock` (or `live` against dev accounts) | `live` (or `mock`) | `live` only |
| Database | a dev/throwaway database | a staging database | the production database |
| Production DB guard | refuses a production `SUPABASE_DB_URL` / `HAGGLE_MOCK_DATABASE_URL` | refuses | n/a |
| Mock/rehearsal flags | allowed | allowed | **refused**: `HAGGLE_SIM_DELAY_SCALE`, `HAGGLE_MOCK_VENDORS`, `HAGGLE_MOCK_PERSONAS_FILE`, `HAGGLE_PLACES_FIXTURE`, `HAGGLE_MOCK_DATABASE_URL`, `HAGGLE_MOCK_BRAIN_FILE`, `HAGGLE_MOCK_WORKSPACES`, `HAGGLE_APPROVALS`, and `HAGGLE_DEMO_SPEED=true`, `HAGGLE_ALLOW_ANY_RECIPIENT=true`, `SELLERS_ALLOW_UNSIGNED=true` |
| Payments | test mode or off | test mode, manual or off | `HAGGLE_PAYMENTS=manual` recommended (Stripe test mode is allowed, with a warning) |

**How a production database is recognized.** A URL counts as production when either holds:
- Its host, or a Supabase project ref, is listed in `HAGGLE_PROD_DB_HOSTS` (comma-separated). A ref matches `db.<ref>.supabase.co` and the session-pooler user `postgres.<ref>`.
- Its host, database or user contains a `production` / `prod` token.

List the production **project ref**, not the shared pooler host: the pooler host (`aws-0-<region>.pooler.supabase.com`) is shared by every project in the region.

**Overriding the guard.** An operator task that deliberately runs a script against production from a laptop sets `HAGGLE_ALLOW_PROD_DB=true` for that one command. The guard also covers the operator scripts that open the database: `workspace-admin`, `workspace-create` and `migrations`. Agent C's `job-ops` should add `import "./dbGuard.ts";` too. A guarded script exits with code 2 before connecting.

**Mock mode.** A `HAGGLE_MODE=mock` server never sends a real message or moves money, and every response says `mode: "mock"`. It is for development and demos only. It is never the production server.

## 2. Environment variables

**`docs/env-manifest.md` is the complete list.** It is generated from `apps/mcp/src/envManifest.ts` and covers every variable the code reads, with its purpose, whether it's a secret, what each target needs and the validation rule. `config.ts` validates from that manifest.

`.env.example` documents every variable. Set secrets on the server with `mcp-use servers env set <server-id> KEY=VALUE`. Never commit them, and prefer pasting into the dashboard: the CLI puts the value in your shell history.

**Required in live mode (any environment).** A missing or invalid value refuses to start:
- `INKBOX_API_KEY`
- `INKBOX_WEBHOOK_SECRET`
- `ANTHROPIC_API_KEY`
- `SUPABASE_DB_URL`: a `postgres://` URL. Use the session pooler on port 5432, with a role that has BYPASSRLS.

**Checked when used:**

| Variable | Rule |
|---|---|
| `HAGGLE_ENV` | `development` \| `staging` \| `production`; anything else is refused. Set it explicitly on every deployed server (a live server without it logs a warning) |
| `HAGGLE_PROD_DB_HOSTS` | production hosts / Supabase project refs (set it on every environment, so dev and staging can recognize production) |
| `HAGGLE_ALLOW_PROD_DB` | `true` only for a deliberate operator task |
| `HAGGLE_REPLY_TOKEN_SECRET` | ≥ 16 characters when `HAGGLE_EXTERNAL_SENDERS=reply_token` |
| `HAGGLE_TICK_SECRET` | ≥ 16 characters, or empty (`/internal/tick` is disabled) |
| `HAGGLE_ENABLE_PAYMENTS=true` | needs `STRIPE_SECRET_KEY` (an `sk_test_` key; live keys are refused), `STRIPE_CUSTOMER_ID` and `STRIPE_PAYMENT_METHOD_ID`, unless `HAGGLE_PAYMENTS=manual` |
| `HAGGLE_ALERT_WEBHOOK_URL` | `https://` only (a Slack-compatible incoming webhook; the URL is itself a secret) |
| `HAGGLE_AI_MAX_CALLS_PER_JOB`, `HAGGLE_AI_DAILY_TOKEN_BUDGET` | positive integers; unset means no limit (production warns when the daily budget is unset) |
| `HAGGLE_STALL_CHECK_EVERY_S` | positive integer, or `0` (off); default 300 |
| `HAGGLE_DB_POOL_MAX` | 1 to 10 (default 4; Supabase's session pooler allows 15 clients in total) |
| `HAGGLE_DB_QUEUE_TIMEOUT_MS` | 100 to 60000 (default 5000): how long a query waits for a free pooled connection before failing as transient |
| `HAGGLE_PAYMENTS`, `HAGGLE_EXTERNAL_SENDERS`, `HAGGLE_GLOBAL_PAYMENT_CAP_CENTS`, `HAGGLE_SPENDING_CAP_CEILING_CENTS`, `HAGGLE_DB_SCHEMA` | a malformed value is refused (they used to fall back silently) |
| `HAGGLE_LOG_LEVEL` | `debug` \| `info` (default) \| `warn` \| `error` |

**Per environment, at minimum:**
- **staging:** `HAGGLE_ENV=staging`, `HAGGLE_MODE=live`, the four required variables pointing at staging accounts and the staging database, and `HAGGLE_PROD_DB_HOSTS=<prod ref>`. Add `HAGGLE_AI_*` limits and `HAGGLE_ALERT_WEBHOOK_URL` for a staging channel.
- **production:** `HAGGLE_ENV=production`, `HAGGLE_MODE=live`, the four required variables, `HAGGLE_PROD_DB_HOSTS=<prod ref>`, `HAGGLE_PAYMENTS=manual`, `HAGGLE_AI_MAX_CALLS_PER_JOB` (e.g. 60), `HAGGLE_AI_DAILY_TOKEN_BUDGET`, `HAGGLE_ALERT_WEBHOOK_URL` and `HAGGLE_BUILD_SHA`. No mock flags.

Every channel stays off unless explicitly enabled (`HAGGLE_ENABLE_CALLS`, `HAGGLE_ENABLE_IMESSAGE`, `HAGGLE_ENABLE_SMS`, `HAGGLE_ENABLE_A2A`). Live mode always requires a workspace credential; `HAGGLE_AUTH` matters only in mock mode.

## 3. Before you deploy

1. **CI is green on the commit.** `.github/workflows/ci.yml` runs on every push and pull request, in mock mode, with no secrets:
   - npm ci and typecheck;
   - build;
   - the unit and end-to-end tests;
   - `scripts/verify-migrations.sh` and `scripts/test-postgres.sh`, both on a Postgres 17 service container.
2. **Or run the same gate locally.** This needs Docker. `PGTEST_PORT` picks a free port:
   ```bash
   npm ci
   npm run typecheck
   npm run build                       # before the tests: the MCP e2e suites start the built server
   npx vitest run
   scripts/verify-migrations.sh
   PGTEST_PORT=55445 scripts/test-postgres.sh
   ```
   With an existing disposable Postgres instead of Docker, set `HAGGLE_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres`. The scripts create their own database on that server and drop it afterwards. They refuse any host but localhost, 127.0.0.1 or the CI service host `postgres`.
3. **Check the database's migrations** (read-only), with the target's variables loaded into the environment:
   ```bash
   npx tsx apps/mcp/scripts/migrations.ts status
   ```
4. **Run the launch gate for the target.** It exits non-zero on any failed prerequisite and never prints a value. The operator passes the target's env file; nothing reads `.env` by default:
   ```bash
   npx tsx apps/mcp/scripts/launch-gate.ts --target staging --env-file <staging env file> --db-url-env SUPABASE_DB_URL
   ```
   It checks:
   - **config:** `checkConfig` on that file. The file must say `HAGGLE_ENV=<target>` and, for staging or production, `HAGGLE_MODE=live`.
   - **recommended variables:** missing ones are a warning only.
   - **migration files:** no duplicate numbers, every name valid.
   - **the ledger against this checkout:** read-only, and refused for a production database unless `--target production`. It fails on pending, drift, unverified or **unexpected** migrations (the database has an engine migration this checkout lacks). `--allow-ahead` accepts unexpected ones for a deliberate rollback.
   - **build:** present and newer than the sources.
   - **webhook subscriptions:** opt-in, read-only. Use `--check-webhooks --webhook-url https://<server>/webhooks/inkbox`, with `INKBOX_API_KEY` in the env file.

   "Tests last green" isn't checkable from a laptop: it shows as `skip`. Check CI on the exact commit instead.

**Node version.** Both `package.json` files require Node ≥ 22.22.2 (`engines`). CI uses `node-version: 22.x`, which resolves to the newest 22 release, and a step fails the job if that release is below the floor. Manufact builds with its own Node 22. Local Node 22.21.0 still installs (npm only warns with `EBADENGINE`) and passed the full gate on 2026-10-22. Upgrade it anyway, because the floor is what CI and production are held to.

## 4. Migrations and the ledger

**How migrations are applied.** They live in `supabase/migrations/`:
- `1xx_engine_*` are Yash's (the server needs every one of them);
- `2xx_brain_*` are Aarnav's (the brain's).

The operator applies them in filename order, each in one transaction, with psql or the Supabase SQL editor. The server never applies migrations.

**The ledger.** Migration `111_engine_ops.sql` creates `engine_migrations` (name, sha-256 checksum, applied_at, recorded_by), forced RLS, no client grants. It records itself without a checksum: a file can't hash itself.

`apps/mcp/scripts/migrations.ts` reads and fills the ledger. Run it with `npx tsx`: plain `node` can't run these scripts, see section 8. It uses `SUPABASE_DB_URL`, or another variable named with `--db-url-env`, and honours `HAGGLE_DB_SCHEMA`:

| Command | Effect |
|---|---|
| `status [--json]` | Read-only. Lists, against this checkout's files: applied (checksum matches), **drift** (an applied file changed in the repo), recorded without a checksum, not recorded, and in the ledger but not in this checkout |
| `verify` | Read-only. Exits 1 unless every engine migration is recorded with a matching checksum |
| `record <file>... --confirm` | Records files you have just applied. A row with a different checksum is refused unless `--accept-drift` |
| `backfill --through <file> --confirm` | Records every repo file up to and including `<file>`. For a database whose migrations were applied before the ledger existed |

`record` and `backfill` are your assertion that those files really are applied. They write only ledger rows.

**First adoption on an existing database** (production today has 100 to 106 and no ledger):
1. Back up the database, or confirm Supabase's point-in-time recovery, before any DDL.
2. Apply the ledger migration:
   ```bash
   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/111_engine_ops.sql
   ```
3. Record what was applied before the ledger. Use the highest file you **know** is applied. Applying 107 to 110 is a separate step: don't backfill past what the database has.
   ```bash
   npx tsx apps/mcp/scripts/migrations.ts backfill --through 106_engine_pilot.sql --confirm
   npx tsx apps/mcp/scripts/migrations.ts record 111_engine_ops.sql --confirm
   ```
4. Check the result:
   ```bash
   npx tsx apps/mcp/scripts/migrations.ts status
   ```
   It must show no drift.

**Each new migration after that:**
```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/1NN_engine_x.sql
npx tsx apps/mcp/scripts/migrations.ts record 1NN_engine_x.sql --confirm
npx tsx apps/mcp/scripts/migrations.ts verify
```

**Ordering.** Apply migrations **before** deploying code that needs them. Migrations are additive, so the old code keeps working on the new schema.

**The engine migrations, in order.** There is no `107` (the number was skipped), so "100 to 106, then 108 to 111" is the full pre-sprint-4 set.

| File | What | Depends on | Compatibility with code already running | Rollback limit |
|---|---|---|---|---|
| `100`–`102` | Core schema, channels, Stripe test payments | – | – | Restore only |
| `103_engine_parity` | Workspaces; job/approval checks widened (`confirmed`, approval actions); rows moved to `ws_default` | 100–102 | Pre-103 code works: new columns have defaults, checks are widened | **Drops and recreates CHECK constraints and moves rows**: undo only by restore/PITR. Once newer code writes `confirmed` jobs or confirm-only approvals, pre-103 code can't read them correctly |
| `104_engine_read_indexes` | Read indexes only | 100 | No schema change | Indexes can be dropped |
| `105_engine_security` | `workspaces.revoked_at`; quotes immutable; approvals must match their quote | 103 | Additive; the triggers refuse writes that were already wrong | Dropping the triggers removes safety checks: don't |
| `106_engine_pilot` | Job leases, outbox, suppressions, workspace vendors, payment handoffs | 103 | Additive (new tables) | Tables can stay; older code ignores them |
| `108_engine_tenancy` | Text routes, held texts, suppression removals, `workspace_vendors.channel` | 103, 106 | Additive | As above |
| `109_engine_reliability` | Operator reviews (dead letters), outbox guards | 106 | Additive; new triggers only refuse unsafe outbox moves | As above |
| `110_engine_booking` | Bookings, handoff receipts, booking-before-handoff trigger | 100, 106 | Additive; a handoff now needs a confirmed booking (older code that skips booking is refused there, by design) | As above |
| `111_engine_ops` | The migration ledger `engine_migrations` | – (idempotent) | Additive | Safe to re-run |
| `112_engine_inbound_review` (A), `113_engine_purchasing` (B), `114_engine_deploy` (C, only if added), `115_engine_security` (D), `116_engine_analytics` (E), `117_engine_ops` (F) | Sprint 4 workstreams | **Each on 100–111 alone**: none may depend on another sprint-4 file | Must be additive (the reviewer checks each one for `drop`/`rename`/narrowed checks) | Per file, in its header |

**Checks on every CI run:**
- `scripts/verify-migrations.sh` applies every file in order and runs the SQL assertions.
- It then applies **each 112+ engine migration alone** on 100–111 in a fresh database, so a hidden dependency between parallel branches fails the build.
- `migrationFileProblems` (unit test, `migrations.ts verify` and the launch gate) refuses two files with the same number and any misnamed file.

**Rollback limits in general.** There are no down migrations. To roll back:
- **Code:** redeploy the previous build. The schema stays: everything since 104 is additive. `/ready` then reports the newer migrations as `unexpected` with `database_ahead: true` and **stays ready**. `migrations.ts verify` and the launch gate need `--allow-ahead`.
- **Schema:** restore from a backup or with PITR (`docs/backup-restore.md`). A restore also loses every row written since. Don't drop a migration's tables by hand while code that uses them might run.

**Readiness.** `/ready` reports `migrations.ok: false` with the missing, drifted or unverified file names until the ledger matches the deployed build. Engine migrations in the ledger that the build doesn't know are listed in `unexpected`; that alone doesn't fail readiness, so a rollback stays possible.

**Drift.** Drift means the repo file changed after it was applied. Don't "fix" it with `--accept-drift` until you have compared the database with the file.

## 5. Deploy to Manufact (CLI upload)

The hosted server `calm-spark-ck3qm` is a **managed upload**: pushing to GitHub, `main` included, does **not** deploy it. Each deploy uploads the local checkout, and each one costs build credits, so deploy once per pass.

1. **Make a clean worktree of the exact commit**, and copy the gitignored link file in from your main checkout:
   ```bash
   git worktree add ../haggle-deploy <commit>
   mkdir -p ../haggle-deploy/.mcp-use/cloud
   cp .mcp-use/cloud/link.json ../haggle-deploy/.mcp-use/cloud/
   cd ../haggle-deploy
   npm ci
   ```
2. **Run the pre-deploy gate** (section 3) on that commit, and apply any new migrations (section 4).
3. **Note the current deployment id**, for rollback:
   ```bash
   ./node_modules/.bin/mcp-use servers get <server-id> --json
   ```
4. **Set the build label** on the server. It isn't read from your shell at deploy time:
   ```bash
   ./node_modules/.bin/mcp-use servers env set <server-id> HAGGLE_BUILD_SHA=$(git rev-parse --short HEAD)
   ```
   `servers env` commands take the server **id**, not the slug. `env unset` needs `--yes`.
5. **Deploy from the repo root.** Leave out `--new` and `--name`, so the linked server is updated; `.env*` files are never uploaded:
   ```bash
   ./node_modules/.bin/mcp-use deploy --json
   ./node_modules/.bin/mcp-use deployments logs <id> --build --follow
   ```
   One deploy creates two deployments: follow the one in "building".
6. **Check the server configuration.** The start command must be:
   ```
   cd apps/mcp && ../../node_modules/.bin/mcp-use start --host 0.0.0.0
   ```
   npm workspaces hoist the CLI to the root, and `./node_modules/.bin` fails with exit 127. The port is 3000.
7. **Copy the MCP URL from the Manufact dashboard.** Never guess it.

**Rollback.** Redeploy the previous commit (the noted deployment and build label say which one) by the same procedure. Migrations are additive, so the old build runs on the new schema.

## 6. After the deploy: smoke test

`apps/mcp/scripts/smoke.ts` checks, in order:
- `/health`;
- `/ready`;
- MCP `initialize` and `tools/list` (the core tools must be listed);
- on **mock** servers only, one simulated deal through `deal` → `wait_for_update` → `get_quotes`, until a quote lands. The deal is then cancelled.

It reads the server's mode twice, from `/health` / `/ready` and from `list_deals`. It never starts a deal on a live server. It prints no secrets.

```bash
# hosted live server: a workspace token is needed for the MCP calls (never echoed)
HAGGLE_SMOKE_TOKEN=<workspace bearer> node apps/mcp/scripts/smoke.ts https://<server>.run.mcp-use.com --expect-build <sha>
# local mock server
cd apps/mcp && PORT=3000 HAGGLE_MODE=mock HAGGLE_SIM_DELAY_SCALE=0 ../../node_modules/.bin/mcp-use start &
node apps/mcp/scripts/smoke.ts http://127.0.0.1:3000
```

Exit 0 means every check passed. Manufact answers `/health` itself on hosted servers, so there it is reported as "skip"; `/ready` is the hosted check. For deeper read-only checks against a live server, use `scripts/acceptance/live-readonly.mjs`.

**Production-safe mode: `--live-readonly`.** Use this mode for staging and production after every deploy:
```bash
HAGGLE_SMOKE_TOKEN=<workspace bearer> node apps/mcp/scripts/smoke.ts https://<server> --live-readonly --expect-build <sha>
```
It calls `/health`, `/ready`, MCP `initialize`, `tools/list`, and only `list_deals` and `get_identity`. Each of those is called only if the server annotates it `readOnlyHint: true, openWorldHint: false`.

Every tool that sends, calls, texts, pays, changes a deal or advances deals as a side effect is refused before any request is made, whatever the server's annotations say: `deal`, `pay`, `approve`, `answer_business`, `send_message`, `negotiate`, `cancel_deal`, `call_back*`, `*_in_view`, `wait_for_update`, `get_quotes`, `open_haggle`, `get_conversation`, `discover`, `business_profile`, `ask` and `check_price`. `apps/mcp/tests/opsReadiness.e2e.test.ts` checks this against a local server and against a fake server that marks `deal` read-only.

## 7. Operating it

**`/health` (liveness).**
- 200 once the runtime is built.
- 503 with the configuration problems (by name) otherwise.
- It never echoes a provider error.

**`/ready` (readiness).** It answers 200 or 503. It is cached for 5 s and carries no values, URLs or addresses. The checks:

| Check | What it says |
|---|---|
| `config` | Configuration errors (by variable name); whether the runtime failed to start |
| `database` | The database answers a read within 3 s. `reason` is `unreachable` (down or timed out) or `pool_busy` (this process's connections are all in use past `HAGGLE_DB_QUEUE_TIMEOUT_MS`). `pool` shows `max`, `in_use`, `queued`, peaks, `timeouts` and `rejected` (counts only) |
| `migrations` | Every engine migration in this build is recorded in the ledger with a matching checksum (live only; mock reports it but doesn't require it). `unexpected` / `database_ahead` lists engine migrations the database has and this build doesn't (reported, not fatal) |

**`/health` against `/ready` during a database outage.** `/health` is liveness. It never queries the database, so it stays 200 and the platform doesn't restart a healthy process because Postgres is down. `/ready` answers 503 with `database.reason` and nothing else: no host, user or driver message. `apps/mcp/tests/opsReadiness.e2e.test.ts` checks this against a server whose database port is closed.

**Connection pool.** Each process opens at most `HAGGLE_DB_POOL_MAX` connections (default 4). Supabase's session pooler allows 15 in total, across every process, replica and reload. Work out `replicas × HAGGLE_DB_POOL_MAX + operator scripts (1 each)` and keep it under 15. Board polling never holds a connection while it waits: `wait_for_update` sleeps between reads. Under load, queries wait in a bounded queue (`HAGGLE_DB_QUEUE_TIMEOUT_MS`, 500 waiters at most) and then fail as transient: one retry for a read, then an error the agent can retry. They don't pile up without limit. `packages/engine/tests/poolGate.test.ts` covers this:
- 60 pollers on a fake slow database never exceed the pool;
- 60 concurrent board reads on Postgres use at most 2 connections when the pool is 2.
| `providers` | Inkbox and Anthropic are configured; the payments mode (`manual` / `stripe_test` / `disabled`); whether alerts are on |
| `ai` | Today's calls and tokens, the limits, the remaining budget, how many jobs are at their call limit. A spent budget doesn't make the server unready: new replies are held for humans |
| `stalled_jobs` | The last stalled-job check's counts by reason |

**Logs.** Live mode writes one JSON line per event, through `packages/engine/src/live/log.ts`. Emails, phone numbers, keys, tokens, connection-string credentials and connector secrets are masked before writing.

**Alerts.** With `HAGGLE_ALERT_WEBHOOK_URL` set, these go to a Slack-compatible webhook:
- stalled jobs (a stuck payment is critical);
- an AI limit reached;
- repeated `tick_failed`, `reconcile_failed` and `stall_check_failed`.

Each alert is redacted. It goes out at most once per key per 30 minutes, and at most 20 go out per 10 minutes.

**Stalled jobs.** A read-only check runs every `HAGGLE_STALL_CHECK_EVERY_S` (default 300 s). It reports a job that is:

| Reason | When |
|---|---|
| `stuck_created` | still `created` after 10 min |
| `stuck_contacting` | still `contacting` after 20 min |
| `past_deadline` | `collecting` / `negotiating` 30 min past its reply-by time with no change |
| `stuck_paying` | still `paying` after 30 min |
| `unparsed_reply` | an inbound reply unparsed for 15 min |

It never changes a job; recovery is the engine's.

**AI limits.** A refused call never reaches Anthropic:

| Call | What happens instead |
|---|---|
| Extraction | Fails the read. The reply is kept and shown as "couldn't read a price" for the human. It never becomes a keyword or approvable quote |
| Question answering | The question waits for the human |
| Strategist | Falls back to the truthful rules |

Counters are per process and per UTC day. With several replicas, each one enforces its own share.

**`/internal/tick`.** `POST` with `Authorization: Bearer $HAGGLE_TICK_SECRET` advances every open deal, for an external cron. The live server also ticks itself.

## 8. Known gaps

- **Operator scripts: plain `node` or `npx tsx`.** The operator scripts now load under Node 22's type stripping: `workspace-admin`, `workspace-create`, `job-ops`, `migrations`, `launch-gate`, `env-manifest`, `secret-scan` and `smoke`. `apps/mcp/tests/scriptsPlainNode.test.ts` checks this. Engine code must therefore avoid TypeScript-only syntax such as parameter properties and enums. `npx tsx` keeps working. Pass the env file explicitly (`--env-file=<file>`): never the production `.env` from a laptop by habit.
- **The ledger doesn't apply migrations.** Applying stays a manual, reviewed step.
- **Per-process state.** AI usage counters and alert rate limits live in each process's memory.
- **Not verified here.** Nothing above was run against the hosted server or a live database (2026-10-22): the deploy steps come from the 2026-10-17 deploy notes. `/ready` on calm-spark will report `migrations.ok: false` until 111 is applied and backfilled.

## 9. Setting up staging, and the first CI run

Staging is a **second, independent server**. It shares code with production and nothing else: no database, no Inkbox identity, no webhook secret, no Anthropic key, no alert channel. Each step below is a dashboard action for the user. Nothing in the repository performs any of them.

**GitHub (first CI run):**
1. **Allow Actions.** Repository Settings → Actions → General: allow GitHub Actions for the repository. Workflow permissions: **Read repository contents** (`ci.yml` asks only for `contents: read`).
2. **Run CI once.** Push the branch or open a pull request (draft PR #1 on `yashnil` did this on 2026-10-22). The **CI** workflow runs with:
   - no secrets;
   - mock mode;
   - a Postgres 17 service container.

   Its steps:
   - Node satisfies `engines`
   - `npm ci`
   - dependency tree consistent
   - secret scan
   - psql client
   - typecheck
   - build
   - tests
   - migrations (including each 112+ file alone)
   - the Postgres suite and ledger.
3. **Protect `main`.** Settings → Branches → add a rule (or ruleset) for `main`:
   - require a pull request;
   - require the status check **CI / verify**;
   - require branches to be up to date.

   Do this after the first run, so the check name is selectable.
4. **No repository secrets are needed.** CI never deploys, and it must not get provider credentials.

**Supabase (staging project):**
1. **Create a separate project**, e.g. `haggle-staging`, in the same region as production. Note its project ref (the staging ref).
2. **Database → Connect:** copy the **session pooler** connection string (port 5432). Use a role with BYPASSRLS (the default `postgres` role). This becomes staging's `SUPABASE_DB_URL`.
3. **Check backups.** Database → Backups: note whether daily backups and PITR are on for the plan (`docs/backup-restore.md`).
4. **Apply the migrations** from a clean checkout of the commit, in filename order. Then fill the ledger: `migrations.ts record` / `backfill` (section 4).

**Inkbox (staging buyer identity):**
1. **Create a staging identity**, e.g. `haggle-staging`, in the org that should own staging. Simulated sellers need the buyer identity in their own org for sender trust.
2. **Create an API key scoped to that identity** for `INKBOX_API_KEY`, and copy the webhook signing secret for `INKBOX_WEBHOOK_SECRET`.
3. **Create the webhook subscription**, only after the staging server is deployed: URL `https://<staging server>/webhooks/inkbox`, events `message.received`, plus `call.ended`, `imessage.received` and `a2a.sent_task.updated` for the channels staging enables. Check it read-only: `launch-gate.ts --check-webhooks --webhook-url …`.

**Anthropic:** a separate API key (or workspace) for staging, so its spend and `HAGGLE_AI_DAILY_TOKEN_BUDGET` are separate.

**Manufact (staging server):**
1. **Create a second server** (not a new deployment of `calm-spark-ck3qm`), e.g. `haggle-staging`, and link a separate checkout or worktree to it. `.mcp-use/cloud/link.json` decides which server `mcp-use deploy` updates: keep one link file per checkout, and never copy production's into the staging checkout.
2. **Start command:** `cd apps/mcp && ../../node_modules/.bin/mcp-use start --host 0.0.0.0`, port 3000.
3. **Environment.** Set staging's variables in the dashboard (`docs/env-manifest.md`, "Staging, separate from production"):
   - `HAGGLE_ENV=staging`, `HAGGLE_MODE=live`;
   - the four required variables, all from the staging accounts above;
   - `HAGGLE_PROD_DB_HOSTS=<production ref>`;
   - `HAGGLE_PAYMENTS=manual`;
   - `HAGGLE_AI_MAX_CALLS_PER_JOB` and `HAGGLE_AI_DAILY_TOKEN_BUDGET`;
   - `HAGGLE_ALERT_WEBHOOK_URL` for a staging channel;
   - `HAGGLE_BUILD_SHA`.

   Leave every `HAGGLE_ENABLE_*` channel off until it is tested.
4. **Before the first deploy,** keep the same variables in a local staging env file outside the repository, and run:
   ```bash
   node apps/mcp/scripts/launch-gate.ts --target staging --env-file <staging env file> --db-url-env SUPABASE_DB_URL
   ```
5. **Deploy and smoke.** Deploy (section 5, with the staging link), then:
   ```bash
   HAGGLE_SMOKE_TOKEN=<staging workspace bearer> node apps/mcp/scripts/smoke.ts https://<staging server> --live-readonly --expect-build <sha>
   ```
6. **Create a staging workspace** with `workspace-create.ts`, run against the staging database (`HAGGLE_ENV=staging` in its env file). The guard refuses the production database there.

**Production stays as it is.** Production uses `HAGGLE_ENV=production` and the production database, and refuses mock flags. Run the same launch gate with `--target production` and its own env file before each production deploy.
