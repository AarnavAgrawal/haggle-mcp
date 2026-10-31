# Environment manifest

Every environment variable that the Haggle MCP server, the brain it hosts, the operator scripts and the test and eval harnesses read. The source of truth is `apps/mcp/src/envManifest.ts`. This table is generated from it with `npx tsx apps/mcp/scripts/env-manifest.ts`.

`apps/mcp/tests/envManifest.test.ts` keeps the manifest honest. It fails when:
- code in `apps/mcp/{index.ts,src,scripts}`, `packages/engine/{src,scripts,eval}` or `packages/brain/src` reads a variable the manifest doesn't list;
- the manifest lists a variable that no code reads;
- this table differs from the generated one;
- `.env.example` is missing a variable.

## How to read the table

**Targets:**
- **mock** is `HAGGLE_MODE=mock` in any environment: development, CI and demos.
- **dev live** is `HAGGLE_ENV=development` with `HAGGLE_MODE=live`, against dev accounts.
- **staging** is `HAGGLE_ENV=staging` (live).
- **production** is `HAGGLE_ENV=production`, which is live only.

**Requirement:**
- **required:** a missing value means the configuration is refused. `/health` and `/ready` answer 503, and tools return `CONFIG_MISSING`.
- **recommended:** `apps/mcp/scripts/launch-gate.ts` warns when it is missing. The server still starts.
- **refused:** setting it at all refuses the configuration in that target.
- **refused if true:** the value `true` refuses the configuration.
- **–:** not read in that target.

The `HAGGLE_CONTACT_*` variables (the vendor-contact business-hours window) are read by workstream A's `workflow/contactWindow.ts`, which arrives at the sprint-4 integration. Until then they are listed with `pendingIntegration`.

**Rule; when invalid:**
- **error:** a malformed value refuses the configuration, so the server never runs on a value it would silently replace.
- **warning:** the code falls back to its safe default, such as off, `info` or 9–20, and `config_warnings` is logged.
- **conditional:** the check depends on another variable, and `config.ts` handles it by hand. Examples: `SUPABASE_DB_URL` format in live mode, `HAGGLE_REPLY_TOKEN_SECRET` with `HAGGLE_EXTERNAL_SENDERS=reply_token`, and the three `STRIPE_*` variables with `HAGGLE_ENABLE_PAYMENTS=true`. Stripe accepts only an `sk_test_` key.

**Secret:**
- **yes:** a credential. It is never logged, echoed or committed. Set it in the Manufact dashboard (prefer pasting over `servers env set`, which leaves the value in shell history).
- **PII:** contact data, handled like a secret in any output.

Messages name the variable, never its value.

## Rules that cut across variables (config.ts)

- **`HAGGLE_ENV=production` requires `HAGGLE_MODE=live`.** It refuses every mock/rehearsal flag and every refused-if-true flag.
- **Development and staging refuse a production database.** This covers any variable marked as a database URL: `SUPABASE_DB_URL`, `HAGGLE_MOCK_DATABASE_URL` and `HAGGLE_TEST_DATABASE_URL`. A URL counts as production when it matches `HAGGLE_PROD_DB_HOSTS` (a host or a Supabase project ref) or has a `prod`/`production` token. The override is `HAGGLE_ALLOW_PROD_DB=true`, for one operator command only. A live development or staging server without `HAGGLE_PROD_DB_HOSTS` gets a warning.
- **Production warns when `HAGGLE_AI_DAILY_TOKEN_BUDGET` is unset.** Production also warns when it uses Stripe test mode instead of `HAGGLE_PAYMENTS=manual`.

## Staging, separate from production

Staging is a separate Manufact server with its own variables. Nothing is shared with production except code.

| | staging | production |
|---|---|---|
| `HAGGLE_ENV` | `staging` | `production` |
| `HAGGLE_MODE` | `live` | `live` |
| `SUPABASE_DB_URL` | the staging project (refused if it matches `HAGGLE_PROD_DB_HOSTS`) | the production project |
| `HAGGLE_PROD_DB_HOSTS` | the **production** ref (so staging recognizes and refuses it) | the production ref |
| `INKBOX_*` | the staging buyer identity/org and its webhook secret | the production buyer identity |
| `ANTHROPIC_API_KEY` | a key with its own budget | the production key |
| `HAGGLE_ALERT_WEBHOOK_URL` | a staging channel | the on-call channel |
| `HAGGLE_PAYMENTS` | `manual` | `manual` |
| `HAGGLE_BUILD_SHA` | the deployed commit | the deployed commit |

Before either one is deployed, check its env file with the launch gate. The operator passes the file. Nothing reads `.env` by default:
```bash
npx tsx apps/mcp/scripts/launch-gate.ts --target staging --env-file <staging env file>
```

## The variables

<!-- manifest:start -->
| Variable | Purpose | Secret | Read by | mock | dev live | staging | production | Rule; when invalid | Default |
|---|---|---|---|---|---|---|---|---|---|
| `HAGGLE_ENV` | Where the server runs: development (default), staging or production |  | server, script | optional | recommended | **required** | **required** | `development` \| `staging` \| `production` (conditional); **error** | `development` |
| `HAGGLE_MODE` | mock (simulated, DEMO-labelled) or live (real providers) |  | server | optional | **required** | **required** | **required** | `mock` \| `live` (conditional); **error** | `mock` |
| `HAGGLE_BUILD_SHA` | Deployed commit (short sha), shown as build_sha by /health and /ready and in serverInfo (set per deploy); a value that isn't label-shaped shows as invalid |  | server, script | optional | optional | recommended | recommended | a commit or release label (letters, digits, . _ -; ≤ 40); warning |  |
| `HAGGLE_BUILD_TIME` | When the deployed build was made (ISO 8601 UTC), shown as build_time by /health and /ready; unset = the build output's time |  | server, script | optional | optional | optional | optional | ISO 8601, e.g. 2026-10-22T18:00:00Z; warning |  |
| `HAGGLE_LOG_LEVEL` | Lowest log level written |  | server | – | optional | optional | optional | `debug` \| `info` \| `warn` \| `error`; warning | `info` |
| `PORT` | HTTP port (read by mcp-use; the hosting platform sets it) |  | platform | optional | optional | optional | optional | integer 1–65535; warning | `3000` |
| `HAGGLE_PROD_DB_HOSTS` | Production database hosts / Supabase project refs (comma-separated) so development and staging refuse them |  | server, script | optional | recommended | recommended | recommended | free text; warning |  |
| `HAGGLE_ALLOW_PROD_DB` | true for one deliberate operator command against production from outside production |  | server, script | – | optional | optional | – | `true` \| `false`; warning |  |
| `INKBOX_API_KEY` | Inkbox API key (buyer identity: email, calls, iMessage, A2A) | yes | server, script | – | **required** | **required** | **required** | free text (conditional); **error** |  |
| `INKBOX_WEBHOOK_SECRET` | Inkbox webhook signing secret (verifies /webhooks/inkbox) | yes | server | – | **required** | **required** | **required** | free text (conditional); **error** |  |
| `ANTHROPIC_API_KEY` | Claude API key (extraction, question answering, negotiation strategist) | yes | server, eval | – | **required** | **required** | **required** | free text (conditional); **error** |  |
| `SUPABASE_DB_URL` | Postgres connection string (session pooler, port 5432, BYPASSRLS role) | yes | server, script | – | **required** | **required** | **required** | `postgres://` URL (conditional); **error** |  |
| `HAGGLE_TICK_SECRET` | Bearer secret for POST /internal/tick (external cron); empty disables the route | yes | server | – | optional | optional | optional | ≥ 16 characters; **error** |  |
| `HAGGLE_SERVICE_TOKEN` | Shared secret with the web app (apps/web): /mcp with x-haggle-workspace, and POST /internal/workspaces; empty disables both | yes | server | – | optional | optional | optional | ≥ 32 characters; **error** |  |
| `HAGGLE_WEB_APPROVALS` | false turns off approving, paying and callbacks from the web app (service routes); default on |  | server | – | optional | optional | optional | `true` \| `false`; warning |  |
| `HAGGLE_ALERT_WEBHOOK_URL` | Slack-compatible incoming webhook for operator alerts (the URL is itself a secret) | yes | server | – | optional | recommended | recommended | `https://` URL; **error** |  |
| `HAGGLE_AI_MAX_CALLS_PER_JOB` | Claude calls allowed per job; over it, replies wait for a human |  | server | – | optional | recommended | recommended | integer > 0; **error** |  |
| `HAGGLE_AI_DAILY_TOKEN_BUDGET` | Claude tokens per UTC day per process; over it, replies wait for a human |  | server | – | optional | recommended | recommended | integer > 0; **error** |  |
| `HAGGLE_STALL_CHECK_EVERY_S` | Stalled-job check interval in seconds (0 = off) |  | server | – | optional | optional | optional | integer ≥ 0; **error** | `300` |
| `HAGGLE_DB_POOL_MAX` | Postgres connections per process (Supabase's session pooler allows 15 clients in total) |  | server | – | optional | optional | optional | integer 1–10; **error** | `4` |
| `HAGGLE_MCP_MAX_BODY_BYTES` | Largest MCP request body accepted (bytes); larger gets 413 |  | server | optional | optional | optional | optional | integer 1024–16777216; warning | `262144` |
| `HAGGLE_WEBHOOK_MAX_BODY_BYTES` | Largest Inkbox webhook body accepted (bytes); larger gets 413 |  | server | – | optional | optional | optional | integer 1024–33554432; warning | `2097152` |
| `HAGGLE_RATE_TOOL_CALLS_PER_MIN` | Tool calls per minute per credential (token bucket); 0 = off. Default 120 in live mode, off in mock |  | server | optional | optional | optional | optional | integer 0–100000; warning |  |
| `HAGGLE_RATE_TOOL_CALLS_BURST` | Burst size of the per-credential tool-call rate limit |  | server | optional | optional | optional | optional | integer 1–10000; warning | `30` |
| `HAGGLE_DB_QUEUE_TIMEOUT_MS` | How long a query waits for a free pool connection before failing as transient (ms) |  | server | – | optional | optional | optional | integer 100–60000; **error** | `5000` |
| `HAGGLE_DB_SCHEMA` | Schema the migrations were applied to, when not public |  | server, brain, script | – | optional | optional | optional | a lower-case schema name ([a-z_][a-z0-9_]*); **error** |  |
| `HAGGLE_PAYMENTS` | manual: approved deals end in a payment handoff to the vendor (no money moves through Haggle); in mock, rehearses the handoff stages (DEMO) |  | server | optional | optional | recommended | recommended | `manual`; **error** |  |
| `HAGGLE_GLOBAL_PAYMENT_CAP_CENTS` | Per-payment safety ceiling in cents (max 1,000,000) |  | server | – | optional | optional | optional | integer 1–1000000; **error** | `500000` |
| `HAGGLE_SPENDING_CAP_CEILING_CENTS` | Highest spending cap a workspace may set, in cents |  | server | – | optional | optional | optional | integer > 0; **error** | `500000` |
| `HAGGLE_EXTERNAL_SENDERS` | reply_token: accept replies from real vendors' own mail servers when they reply in Haggle's email thread (or pass aligned DMARC), and a new email from a vendor with one open deal (quote only) |  | server | – | optional | optional | optional | `off` \| `reply_token`; **error** | `off` |
| `HAGGLE_REPLY_TOKEN_SECRET` | Legacy and unused: Haggle no longer sends reply tokens (2026-10-30). Safe to leave set or remove | yes | server | – | optional | optional | optional | ≥ 16 characters; warning |  |
| `HAGGLE_ENABLE_PAYMENTS` | true: Stripe TEST-mode deposits (needs the three STRIPE_* variables) unless HAGGLE_PAYMENTS=manual |  | server | – | optional | optional | optional | `true` \| `false`; warning |  |
| `STRIPE_SECRET_KEY` | Stripe test-mode key (sk_test_ only; live keys are refused) | yes | server, script | – | optional | optional | optional | a test-mode key (sk_test_) (conditional); **error** |  |
| `STRIPE_CUSTOMER_ID` | Stripe test customer charged for deposits |  | server, script | – | optional | optional | optional | free text (conditional); **error** |  |
| `STRIPE_PAYMENT_METHOD_ID` | Stripe test card on that customer |  | server, script | – | optional | optional | optional | free text (conditional); **error** |  |
| `INKBOX_IDENTITY` | Inkbox buyer identity handle |  | server, script | – | optional | optional | optional | an Inkbox handle; warning | `haggle` |
| `INKBOX_SENDER_TRUST` | Seller-reply trust: outbound-verified (default) or pinned-org-identity |  | server | – | optional | optional | optional | `outbound-verified` \| `pinned-org-identity`; warning | `outbound-verified` |
| `ANTHROPIC_MODEL` | Claude model for extraction and the strategist |  | server, eval | – | optional | optional | optional | free text; warning |  |
| `ANTHROPIC_WORKSPACE_ID` | Anthropic workspace for usage attribution |  | server, eval | – | optional | optional | optional | free text; warning |  |
| `HAGGLE_ENABLE_CALLS` | true: Voice AI calls (only vendors who agreed) |  | server | – | optional | optional | optional | `true` \| `false`; warning |  |
| `HAGGLE_ENABLE_IMESSAGE` | true: iMessage (approvals and businesses that connected first) |  | server | – | optional | optional | optional | `true` \| `false`; warning |  |
| `HAGGLE_ENABLE_SMS` | true: SMS from the buyer's own number |  | server | – | optional | optional | optional | `true` \| `false`; warning |  |
| `HAGGLE_ENABLE_A2A` | true: A2A tasks to allowlisted Agent Cards |  | server | – | optional | optional | optional | `true` \| `false`; warning |  |
| `HAGGLE_SYNC_VOICE_CONTEXT` | false: don't sync deal context to the voice agent |  | server | – | optional | optional | optional | `true` \| `false`; warning |  |
| `HAGGLE_TRUST_INBOUND_CALLER_ID` | true: trust caller ID on inbound calls |  | server | – | optional | optional | optional | `true` \| `false`; warning |  |
| `HAGGLE_EMAIL_APPROVAL_BY_CODE` | true: accept APPROVE <code> by email (rests on a spoofable From address) |  | server | – | optional | optional | optional | `true` \| `false`; warning |  |
| `HAGGLE_RECONCILE` | false: turn off the lost-webhook reconciliation sweep |  | server | – | optional | optional | optional | `true` \| `false`; warning |  |
| `HAGGLE_RECONCILE_EVERY_S` | Reconciliation sweep interval (seconds) |  | server | – | optional | optional | optional | number > 0; warning | `60` |
| `HAGGLE_CALL_DELAY_S` | Delay before a Voice AI call (seconds) |  | server | – | optional | optional | optional | number > 0; warning |  |
| `HAGGLE_ESCALATE_EMAIL_TO_CALL_S` | Unanswered email escalates to a call after this many seconds |  | server | – | optional | optional | optional | number > 0; warning |  |
| `HAGGLE_CALL_HOURS` | Local call hours, start-end (24h) |  | server | – | optional | optional | optional | start-end hours, e.g. 9-20; warning | `9-20` |
| `HAGGLE_CONTACT_HOURS` | Business-hours window for contacting vendors, HH:MM-HH:MM local; off disables the window |  | server | – | optional | optional | optional | HH:MM-HH:MM (e.g. 08:00-19:00) or off; warning |  |
| `HAGGLE_CONTACT_DAYS` | Weekdays vendors may be contacted, e.g. Mon-Sat or Mon,Wed,Fri |  | server | – | optional | optional | optional | weekday names, e.g. Mon-Sat or Mon,Wed,Fri; warning |  |
| `HAGGLE_CONTACT_TIMEZONE` | Time zone of the vendor-contact window |  | server | – | optional | optional | optional | IANA time zone; warning | `America/Los_Angeles` |
| `HAGGLE_CUSTOMER_NAME` | Customer name used in outreach (40 characters max) |  | server | – | optional | optional | optional | free text; warning |  |
| `HAGGLE_VOICE_WORKSPACE` | Workspace whose settings the voice line uses |  | server | – | optional | optional | optional | free text; warning |  |
| `HAGGLE_NOTIFY_PHONE` | Phone (E.164) for update texts, else the settings approver | PII | server | – | optional | optional | optional | a phone number; warning |  |
| `HAGGLE_ALLOWED_RECIPIENTS` | Extra contacts outreach may reach (comma-separated); discovery is not permission | PII | server | optional | optional | optional | optional | free text; warning |  |
| `HAGGLE_DEMO_FLEET` | Simulated fleet offered by discover in live mode | PII | server | – | optional | optional | optional | free text; warning |  |
| `HAGGLE_DEMO_VENDORS` | Operator-configured demo vendor contacts | PII | server | – | optional | optional | optional | free text; warning |  |
| `GOOGLE_PLACES_API_KEY` | Google Places key for public discovery/reputation (absent = off) | yes | server | – | optional | optional | optional | free text; warning |  |
| `HAGGLE_MIGRATIONS_DIR` | Where /ready finds supabase/migrations when not found by walking up |  | server | optional | optional | optional | optional | free text; warning |  |
| `HAGGLE_AUTH` | Mock only: required turns on workspace auth (live always requires it) |  | server | optional | – | – | – | `open` \| `required`; warning |  |
| `SUPABASE_URL` | Brain profile store (Supabase REST URL); with SUPABASE_SERVICE_ROLE_KEY |  | brain | – | optional | optional | optional | http(s) URL; warning |  |
| `SUPABASE_SERVICE_ROLE_KEY` | Brain profile store service-role key | yes | brain | – | optional | optional | optional | free text; warning |  |
| `HAGGLE_BRAIN_STORE` | memory: keep brain profiles in memory (wins over Supabase) |  | brain | optional | optional | optional | optional | `memory`; warning |  |
| `HAGGLE_BRAIN_FILE` | Brain profile file when Supabase isn't configured |  | brain | optional | optional | optional | optional | free text; warning | `.haggle-data/brain.json` |
| `HAGGLE_DIRECTORY_FILE` | Business directory override file (brain) |  | brain | optional | optional | optional | optional | free text; warning |  |
| `HAGGLE_DIRECTORY_JSON` | Inline business directory JSON (brain) |  | brain | optional | optional | optional | optional | JSON; warning |  |
| `HAGGLE_SIM_DELAY_SCALE` | Simulated seller reply delay multiplier (0 = instant) |  | server | optional | optional | optional | **refused** | free text; warning |  |
| `HAGGLE_MOCK_VENDORS` | none: rehearse a server with no vendor set up |  | server | optional | optional | optional | **refused** | free text; warning |  |
| `HAGGLE_MOCK_PERSONAS_FILE` | Scripted simulated vendors (JSON file) |  | server | optional | optional | optional | **refused** | free text; warning |  |
| `HAGGLE_PLACES_FIXTURE` | Recorded Places/website responses for discovery rehearsals |  | server | optional | optional | optional | **refused** | free text; warning |  |
| `HAGGLE_MOCK_DATABASE_URL` | Throwaway Postgres for mock restart rehearsals (never a real database) | yes | server | optional | optional | optional | **refused** | `postgres://` URL (conditional); **error** |  |
| `HAGGLE_MOCK_BRAIN_FILE` | Brain file kept across mock restarts |  | server | optional | optional | optional | **refused** | free text; warning |  |
| `HAGGLE_MOCK_WORKSPACES` | Mock workspaces JSON (tests and rehearsals of auth/isolation) | yes | server | optional | optional | optional | **refused** | free text; warning |  |
| `HAGGLE_APPROVALS` | out_of_band: mock servers accept only out-of-band approvals (live always does) |  | server | optional | optional | optional | **refused** | free text; warning |  |
| `HAGGLE_DEMO_SPEED` | true: shorter windows for a demo video |  | server | optional | optional | optional | **refused if true** | `true` \| `false`; warning |  |
| `HAGGLE_ALLOW_ANY_RECIPIENT` | Ignored in live mode (logged); refused in production |  | server | optional | optional | optional | **refused if true** | `true` \| `false`; warning |  |
| `SELLERS_ALLOW_UNSIGNED` | Simulated sellers (apps/sellers) accept unsigned webhooks; refused in production |  | sellers | optional | optional | optional | **refused if true** | `true` \| `false`; warning |  |
| `HAGGLE_SMOKE_TOKEN` | Workspace bearer for smoke.ts (never echoed) | yes | script | optional | optional | optional | optional | free text; warning |  |
| `PUBLIC_BASE_URL` | Server URL printed by workspace-create / workspace-admin rotate |  | script | optional | optional | optional | optional | http(s) URL; warning |  |
| `HAGGLE_EMAIL_TRIAL` | 1: allow one email-trial run (scripts/email-trial.ts) |  | script | – | optional | optional | – | free text; warning |  |
| `HAGGLE_EMAIL_TRIAL_MAILBOXES` | Mailboxes the email trial may write to (comma-separated) | PII | script | – | optional | optional | – | free text; warning |  |
| `HAGGLE_TEST_DATABASE_URL` | Throwaway Postgres for the PG-gated tests (scripts/test-postgres.sh sets it) | yes | test | optional | – | – | – | `postgres://` URL; warning |  |
| `HAGGLE_EVAL_MAX_USD` | Spending cap in USD for an opt-in live eval run (required with HAGGLE_EVAL_LIVE=1) |  | eval | optional | – | – | – | free text; warning |  |
| `HAGGLE_EVAL_LIVE` | 1: the eval harness also runs the Claude extractor (calls Anthropic) |  | eval | optional | – | – | – | free text; warning |  |
<!-- manifest:end -->
