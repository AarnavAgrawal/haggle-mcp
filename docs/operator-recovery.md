# Operator recovery: failed and stuck jobs

How to find and recover a failed or stuck job without contacting a business twice, retrying unsafely, or editing the database by hand. Everything here uses two scripts, both run from `apps/mcp`:

- `scripts/ops-report.ts` only reads. It shows what is waiting on a person.
- `scripts/job-ops.ts` re-arms an action or records an operator decision. It never calls Inkbox, Stripe or Anthropic. The running server does the work on its next advance, and every normal check runs again first.

Both scripts refuse a production database unless `HAGGLE_ENV=production` (dbGuard). Both need `SUPABASE_DB_URL`.

## 1. Rules that never bend

1. **A call that may have rung is never redialed.** That covers a claimed call with no result, and one whose outcome is `unknown` after a 5xx or a timeout. No flag overrides this. Check the Inkbox call log, tell the human if needed, then `resolve` the review.
2. **Never re-send by hand.** Don't send from the Inkbox dashboard, and don't edit `outbox` or `job_businesses` in SQL. Use `job-ops retry`, which keeps the same provider idempotency key. Inkbox then replays an earlier send instead of delivering it a second time.
3. **Keys older than 6 days are never re-sent.** Inkbox remembers an idempotency key for 7 days. After that, a re-send could arrive twice. Check the sent folder. If the message never went out, contact the business in a new deal.
4. **Obligations need proof first.** An acceptance, a booking confirmation, or a "the customer paid" notice is re-sent only with `--override-obligation`, and only after you've confirmed the business never got it: the Inkbox sent folder, or the business's own reply.
5. **Money needs the Stripe dashboard first.** A held Stripe charge is released only with `--override-financial`, after the Stripe dashboard shows no PaymentIntent for the approval (metadata `approval_id`). The full payment guard runs again before anything is charged.
6. **A retry is refused, not forced,** when the business has opted out or bounced since, or has been removed from the workspace's vendors. Fix the cause first (`workspace-admin.ts remove-suppression`, or `add-vendor --consent ...`), then retry.

## 2. Daily check

```
node --env-file=.env scripts/ops-report.ts             # every workspace, plain text
node --env-file=.env scripts/ops-report.ts --json      # for a dashboard or a ticket
node --env-file=.env scripts/ops-report.ts --workspace ws_acme --days 3
```

| Section | What it means | Do |
| --- | --- | --- |
| Pending approvals | The human hasn't answered. EXPIRED means the server is about to clear it. | Nothing, or remind the human |
| Operator reviews | Something Haggle stopped retrying, or must never retry on its own | §3 by kind |
| Failed / bounced communications | `not_sent`: retried automatically until reviewed. `unknown`: never retried. `bounced`: the vendor was given up on. | §3 `outbox` |
| Quarantined replies | Mail that Haggle wouldn't read as a quote | `quarantine.ts` (workstream A) |
| Stalled jobs | Open longer than its state should take | `inspect`, then §4 |
| Recovery findings | What the server's stuck-job sweep plans to do: `advance` it does itself; `review` needs you | Usually nothing for `advance` |
| Handoffs awaiting action | The manual-rail booking or payment instructions are waiting on the business. STALLED means it was reminded once and the human was told. | Call the business, or §4 fail-safe close |

## 3. Reviews, by kind

Start every review with `job-ops inspect --job <job_id>`. It shows the businesses (contacts masked), the outbox, approvals, payments, reviews, the recovery plan and the last events.

| Kind / subject | Cause | Safe action |
| --- | --- | --- |
| `outbox` `rfq:…`, `imsg-rfq:…` (`not_sent`, retries exhausted) | The provider refused it repeatedly | Once the cause is fixed: `retry --key <key> --by <you>`. It is sent once, under the same key. |
| `outbox` `…` with `unknown` (email or text) | The provider may have accepted it, e.g. an idempotency conflict | Check the Inkbox sent folder. Sent: `resolve`. Never sent and under 6 days old: `retry --key`. |
| `outbox` `a2a:…` | The A2A task's outcome is unknown, and the business agent's dedupe is unverified | Check with the business. Then `resolve`, or start a new deal. Never re-sent automatically. |
| `outbox` `call:…` | It may have rung | Rule 1: check the Inkbox call log, then `resolve`. |
| `outbox` `confirm:…`, `accept:…`, `handoff:…` | An obligation whose outcome is unknown | Rule 4: `retry --key <key> --override-obligation`. |
| `outbox` `sms:approval:…` / `imsg:approval:…` | The approval request never reached the human (`approval_undelivered`) | Fix the approver's number (`workspace-admin.ts set-approver`), then ask the agent to `approve` again, or tell the human. |
| `payment` `pay_…` | A Stripe charge was held: too old for Stripe's 24 h idempotency, or failing repeatedly | Rule 5: `retry --payment <id> --override-financial`, or `resolve` after settling it in Stripe. |
| `parse` `msg_…` | A reply couldn't be read: an AI limit was hit, or the reply was malformed | Read it on the deal board. The human can decide from the board. `resolve`. |
| `reconcile` `mail:…` | The reconciler gave up ingesting an item | Look the item up in Inkbox. Replaying the webhook from the Inkbox delivery log is safe: ingest is idempotent. `resolve`. |
| `stuck_job` `<job>:collection_overdue` etc. | The deadline passed and the advance couldn't move the job (often a wedged lease) | `inspect`. If no instance is advancing it, the lease expires on its own (TTL). If it keeps recurring, see §4. |
| `stuck_job` `<job>:booking_unconfirmed` / `handoff_instructions_overdue` | The business went quiet after approval | Phone the business. If the deal is dead, §4 fail-safe close. |
| `stuck_job` `hold:<job>` | Your own hold | `resume` |
| `stuck_job` `close:<job>` | Your close request, waiting for the server | Nothing to do. The server resolves it when it closes the job. |
| `confirmation` `confirm:…` | The deal closed but the business was never told to go ahead | Rule 4. |
| `late_reply` | A reply arrived after the deal closed | Read it. The human was texted if the deal went ahead. `resolve`. |

Close a review only once you've checked or done what it asks: `job-ops resolve --id rev_… --note "<what you checked>" --by <you>`. Resolving never re-sends anything.

## 4. Job-level actions

**Hold.** Use it when a business asks you to pause, or while you investigate:
```
job-ops review-job --job job_… --note "vendor asked us to pause" --by <you>
```
While a job is held, the server's background advance skips it: no sends, follow-ups, deadline closes or reply reads, and the stuck-job sweep leaves it alone. Inbound mail is still stored, and a human's own text decision (YES/NO/PAID) still applies. Lift the hold with `job-ops resume --job job_… --note "<what changed>" --by <you>`. The next advance carries on from the current state, and nothing already sent goes out again.

**Fail-safe close.** Use it when a deal can't be completed: the business is unreachable, a vendor backed out, or the human asked you to stop.
```
job-ops fail-safe-close --job job_… --reason "vendor unreachable" --by <you> --confirm
```
On its next advance, the server:
- marks the job `failed` (`operator_closed`);
- expires a pending or unpaid approval;
- withdraws an unpaid booking or payment handoff on Haggle's side;
- texts the human exactly what happened: that an operator closed it and why, that no business will be contacted again, that nothing was paid through Haggle, and which business had confirmed or replied and was **not** told.

No business is contacted: phone or email the ones holding something for this deal yourself. The close is refused while money may be moving (a Stripe charge `charging`, `signed` or `sent`), and refused after the customer reported paying (the server resolves the request with that reason). Settle the payment first.

`--reason` is what the human reads, so keep it short and plain.

## 5. After an outage or a restart

- **Lost webhooks.** The reconciler lists the buyer mailbox (plus texts and calls when enabled) every minute and ingests anything missing. After a long outage it catches up from each channel's high-water mark (`reconcile_cursors`, migration 117) in bounded slices, oldest first. A `reconcile_gap` alert means the server was down longer than the catch-up limit (14 days). Items older than that must be checked by hand in Inkbox: replay their webhooks from the Inkbox delivery log, which is safe because ingest is idempotent.
- **A crash mid-send.** A claimed send with no result is re-sent under the same key once it is 2 minutes stale (email and texts; Inkbox replays it). A call is recorded `unknown` and reviewed. An A2A task or an obligation is reviewed. Don't redo any of it by hand.
- **Database outage.** Sends that went out while their record failed are re-recorded under the same key; the business is not marked bounced. Replies whose webhook answered 503 are picked up by the reconciler.
- **Two replicas, or an old instance still running.** Job leases fence a stale instance before every send. A `lease_lost` alert is informational unless it keeps repeating, which points to slow advances (AI latency, a database stall).

Then run `ops-report.ts` and work through it top to bottom.

## 6. Limits that refuse requests

These are set in `apps/mcp/src/limits.ts`. They are per process, in memory.

| What | Default | When it's hit |
| --- | --- | --- |
| MCP request body | `HAGGLE_MCP_MAX_BODY_BYTES` = 256 KiB | 413 with a fix |
| Inkbox webhook body | `HAGGLE_WEBHOOK_MAX_BODY_BYTES` = 2 MiB | 413. The reconciler ingests the item from the mailbox instead. |
| Tool calls per credential | `HAGGLE_RATE_TOOL_CALLS_PER_MIN` = 120 (live; off in mock), burst `HAGGLE_RATE_TOOL_CALLS_BURST` = 30 | An MCP tool error `RATE_LIMITED` with a fix and `Retry-After` |
| Claude calls per job, tokens per day | `HAGGLE_AI_MAX_CALLS_PER_JOB`, `HAGGLE_AI_DAILY_TOKEN_BUDGET` | The reply is held: a `parse` review plus an alert |
