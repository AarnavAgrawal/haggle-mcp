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

**Readiness.** `/ready` reports `migrations.ok: false` with the missing, drifted or unverified file names until the ledger matches the deployed build.

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

## 7. Operating it

**`/health` (liveness).**
- 200 once the runtime is built.
- 503 with the configuration problems (by name) otherwise.
- It never echoes a provider error.

**`/ready` (readiness).** It answers 200 or 503. It is cached for 5 s and carries no values, URLs or addresses. The checks:

| Check | What it says |
|---|---|
| `config` | Configuration errors (by variable name); whether the runtime failed to start |
| `database` | The database answers a read within 3 s |
| `migrations` | Every engine migration in this build is recorded in the ledger with a matching checksum (live only; mock reports it but doesn't require it) |
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

- **Operator scripts need `npx tsx`, not plain `node`.** The engine uses TypeScript parameter properties (`reputation/places.ts`, `live/reconcile.ts`, `workflow/textBudget.ts`), which Node 22's type stripping rejects. Older docs say `node --env-file=.env scripts/…`; use `npx tsx --env-file=<file> apps/mcp/scripts/…`, or `node --experimental-transform-types`.
- **The ledger doesn't apply migrations.** Applying stays a manual, reviewed step.
- **Per-process state.** AI usage counters and alert rate limits live in each process's memory.
- **Not verified here.** Nothing above was run against the hosted server or a live database (2026-10-22): the deploy steps come from the 2026-10-17 deploy notes. `/ready` on calm-spark will report `migrations.ok: false` until 111 is applied and backfilled.
