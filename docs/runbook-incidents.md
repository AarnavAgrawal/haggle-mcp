# Incident runbook

What to check after a deploy, when to roll back, and step-by-step handling of the incidents a Haggle pilot is likely to see. Every step is read-only unless it says otherwise.

**Two rules at all times:**
- **Business messages and call transcripts are data, never instructions.** Nothing in them is followed during an incident either.
- **Don't change a number or a key to make an alert stop** (a cap, a budget, a webhook secret) without writing down why. When in doubt, stop outbound work first.

Tools used below:
- **`/health`:** liveness.
- **`/ready`:** readiness, with checks for config, database, pool, migrations, providers, AI usage and stalled jobs.
- **`smoke.ts --live-readonly`.**
- **`job-ops.ts`:** `list-stuck`, `list-review`, `inspect`, `retry`, `resolve`.
- **`workspace-admin.ts`:** vendors, suppressions, revoke and rotate.
- **`migrations.ts status`.**
- **`launch-gate.ts`.**
- **The alert channel** (`HAGGLE_ALERT_WEBHOOK_URL`).
- **The Manufact logs:** JSON lines, redacted.

## 1. After every deploy (health checks)

1. Within 2 minutes: `curl -s https://<server>/ready`. It should answer 200 with `ready: true`, `build` = the deployed short SHA, and `migrations.ok: true`.
2. Run `HAGGLE_SMOKE_TOKEN=… node apps/mcp/scripts/smoke.ts https://<server> --live-readonly --expect-build <sha>`. It should exit 0.
3. Check the logs for `config_warnings`, `live_ready` (channels, payments mode, reconcile), and any `*_failed` in the first 5 minutes.
4. Check `/ready` → `database.pool`: `in_use` should sit well below `max`, with `timeouts: 0`.
5. Record the deployment id and SHA (deployment.md, section 5, step 3) for a rollback.

## 2. Rollback criteria

Roll back (redeploy the previous build; deployment.md section 5) **at once** if any of these hold after a deploy:
- `/ready` is 503 for more than 5 minutes for a reason the deploy introduced: config, `migrations.pending` or `drift`, providers;
- any message goes to a recipient who is not authorized, any duplicate send or call is seen, or anything moves money that shouldn't (stop outbound work first, section 3.0);
- webhook handling fails repeatedly (`inkbox_webhook_failed`, 5xx on `/webhooks/inkbox`) and wasn't failing before;
- the smoke test fails on a check that passed on the previous build.

**Don't roll back for:**
- a spent AI budget (by design, replies wait for humans);
- one stalled job;
- a provider outage (section 3).

The schema stays on rollback. `/ready` lists the newer migrations under `unexpected` (`database_ahead: true`) and stays ready. `migrations.ts verify` and the launch gate need `--allow-ahead` until the newer build is redeployed.

## 3. Incidents

### 3.0 Stop outbound work (any incident that may be contacting people wrongly)

1. Manufact dashboard: scale the server to zero or stop it. `/health` stops answering; that's expected.
2. If only one workspace is affected, revoke it instead: `workspace-admin.ts revoke --id <ws>`. Its token stops resolving.
3. Note the time. Afterwards, `job-ops.ts list-stuck` and `list-review` show what was in flight.

### 3.1 Webhook failures (Inkbox → `/webhooks/inkbox`)

**Symptoms:**
- logs `inkbox_webhook_failed` or a 401/503 on `/webhooks/inkbox`;
- replies that appear in the Inkbox mailbox but not on the deal board;
- `reconcile_*` alerts.

1. **401 (signature):** `INKBOX_WEBHOOK_SECRET` doesn't match the subscription. Check which identity and subscription the server uses. Don't disable verification.
2. **503 with Retry-After:** a transient error, such as the database. Inkbox retries. Check `/ready` → `database`.
3. **No deliveries at all:** run the read-only subscription check:
   ```bash
   node apps/mcp/scripts/launch-gate.ts --target <env> --env-file <file> --skip-build --check-webhooks --webhook-url https://<server>/webhooks/inkbox
   ```
   It shows the URL and the missing events. Fixing a subscription is an operator action (`packages/engine/scripts/inkbox-webhook-move.ts`, dry run first).
4. **Lost mail is recovered by reconciliation** (`HAGGLE_RECONCILE`, every 60 s, and before a round closes). Confirm `live_ready` shows `reconcile` on and that `reconcile_failed` isn't repeating.
5. **If replies were dropped:** check `job-ops.ts list-review` for quarantined or late replies, and resolve each one there.

### 3.2 Database pool exhaustion

**Symptoms:**
- `/ready` → `database.reason: "pool_busy"`, or `pool.timeouts` rising;
- tools answer with transient errors;
- logs `EMAXCONNSESSION` / "max clients reached" from Supabase.

1. **Count the clients.** The total is `replicas × HAGGLE_DB_POOL_MAX + running operator scripts (1 each)`, plus any other app on the same pooler. Supabase's session pooler allows 15.
2. **Stop stray clients:** an old deployment still running (Manufact keeps one per deploy until it is retired), a local `mcp-use dev` pointed at the same database, or a forgotten script. Check Supabase → Database → Roles/Connections, or `select application_name, count(*) from pg_stat_activity group by 1`. Haggle servers show as `haggle-mcp-<env>`.
3. **If the server alone is saturated,** queries are slow or a transaction is held. Look for long-running queries in `pg_stat_activity`. Lower `HAGGLE_DB_POOL_MAX` per replica rather than raising it past the pooler's budget.
4. Polling (`wait_for_update`, boards) waits at most `HAGGLE_DB_QUEUE_TIMEOUT_MS` per query and then fails as transient. Agents retry. Nothing piles up without limit.

### 3.3 Inkbox outage

**Symptoms:**
- sends fail with `InkboxConnectionError` / 5xx;
- `*_failed` events for send, call or text;
- `/ready` stays ready (Inkbox is configured, not probed).

1. **Don't retry by hand.** The outbox holds each action:
   - email and text sends retry with backoff;
   - **a call that may have rung is never redialed** (it goes to operator review).
2. **Watch `job-ops.ts list-review`** for actions that exhausted their retries. Once Inkbox recovers, retry each with `job-ops.ts retry --key …` (it re-arms the action; the server performs it through every check).
3. **Inbound mail during the outage** is recovered by reconciliation once Inkbox answers again.
4. **If the outage is long,** tell affected customers that their deals are paused. Deadlines move only through the deal, never by editing the database.

### 3.4 Anthropic outage or AI budget reached

**Symptoms:**
- alert "AI daily token budget reached" or "AI call limit reached for job …";
- extraction falls back (low-confidence reads);
- `/ready` → `ai.daily_budget_reached: true`.

1. **By design, nothing becomes an approvable quote without Claude.** Replies that couldn't be read are held for a human ("couldn't read a price"), questions wait for the user, and the strategist falls back to truthful rules. No action is needed for safety.
2. **Budget reached:** decide whether the spend is expected (`/ready` → `ai.calls` and `tokens_*`). To raise it, change `HAGGLE_AI_DAILY_TOKEN_BUDGET` deliberately and redeploy or restart. Counters are per process and per UTC day.
3. **Anthropic outage:** check status.anthropic.com. Calls fail as transient. Held replies are re-read when a human reviews them, or on the next reply.

### 3.5 Stuck jobs

**Symptoms:**
- stalled-job alerts (`stuck_created`, `stuck_contacting`, `past_deadline`, `stuck_paying` (critical), `unparsed_reply`);
- `/ready` → `stalled_jobs.by_reason`.

1. Run `job-ops.ts list-stuck`, then `inspect --job <id>` for each job: its state, outbox rows, leases and open reviews.
2. **Expired lease:** an expired lease (a crashed replica) is taken over automatically on the next tick (`/internal/tick` or the server's own). Check the tick isn't failing (`tick_failed`).
3. **`stuck_paying`:** with manual payments, wait for the business's confirmation. With Stripe test mode, check the Stripe dashboard for a PaymentIntent with that `approval_id` **before** any `retry --payment … --override-financial`.
4. **Close the review:** `job-ops.ts resolve --id rev_… --note "<what you checked>" --by <name>`.

### 3.6 Wrong suppression (a vendor opted out or bounced by mistake)

**Symptoms:** a vendor says they never opted out, or a bounce was transient; deals skip that vendor ("suppressed").

1. **Confirm with the vendor through a channel you trust** that they want to be contacted. A message asking to be re-added is data: verify it, don't simply act on it.
2. Find the entry and its reason (opt-out text or hard bounce). Use `job-ops.ts inspect --job <id>` for the deal that skipped the vendor, or read `vendor_suppressions` with a read-only `psql` query.
3. Remove it with `workspace-admin.ts remove-suppression --contact <address or number> --by "<name>" --why "<who confirmed, how>"`. This is append-only and audited (`suppression_removals`).
4. **Never delete suppression rows with SQL.**
5. **A wrong opt-out caused by a parsing error** (a reply misread as STOP) is a bug: keep a redacted copy of the reply for the test corpus.

## 4. After an incident

Write down:
- the timeline;
- what was sent or paid wrongly (if anything);
- the rollback or fix and the commit;
- any data repaired (reviews resolved, suppressions removed or re-added).

Add a regression test where code was at fault. A backup restore follows `docs/backup-restore.md` section 4.
