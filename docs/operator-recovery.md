# Operator recovery: failed and stuck jobs

How to find and recover a failed or stuck job without contacting a business twice, retrying unsafely, or editing the database by hand. Everything here uses two scripts, both run from `apps/mcp`:

- `scripts/ops-report.ts` only reads. It shows what is waiting on a person.
- `scripts/job-ops.ts` re-arms an action or records an operator decision. It never calls Inkbox, Stripe or Anthropic. The running server does the work on its next advance, and every normal check runs again first.

Account-level actions (suspend, revoke, the vendor roster) are in `scripts/workspace-admin.ts`, and held mail and texts are in `scripts/quarantine.ts`. All of them refuse a production database unless `HAGGLE_ENV=production` (dbGuard), and all need `SUPABASE_DB_URL`. Every change they make is written to the operator log with `--by` (who) and a reason (§10). None of them can approve, pay or name a payee.

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
| `stuck_job` `opreq:callback:…`, `opreq:release-text:…` | Your callback (§9) or text-release (§8) request, waiting for the job's next advance | Nothing to do. The server resolves it with the outcome. If the job is held or suspended it waits; `resolve` it to withdraw it. |
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

`job-ops cancel` is the same command as `fail-safe-close`, under the name operators look for first (it also needs `--confirm`).

**Find stuck deals.** `job-ops list-stuck` prints every open (and recently closed) deal the recovery planner finds overdue, with what it will do (`advance`) or what needs you (`review`).

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

## 7. Suspend, revoke, cancel, hold: what each one does

| Action | Command | Tools | In-flight deals | Inbound replies | Undo |
| --- | --- | --- | --- | --- | --- |
| Suspend a workspace | `workspace-admin.ts suspend --id <ws> --by <you> --reason "<why>"` | Credentials still resolve, but every request except the MCP handshake gets HTTP 403 `WORKSPACE_SUSPENDED`, with a fix that says to contact the operator. | Every open deal gets an operator hold. The engine also refuses to advance any deal of a suspended workspace, even one whose hold was lifted by hand. No RFQ, follow-up, counteroffer, call, booking request or deadline close goes out, and no operator request runs. | Stored and kept for audit, but not read into the deal until resume. A human's own coded text (YES/NO/PAID) is still recorded, but nothing goes to a business until resume. | `resume --id <ws> --by <you> --reason "<why>"` lifts only the holds the suspension placed; a job you held yourself stays held. Deadlines that passed during the suspension apply on the next advance. |
| Revoke credentials | `workspace-admin.ts revoke --id <ws> --by <you> --reason "<why>"` | The token and connector URL fail on the very next request (401). | Not paused: the server keeps running them, and the human can still approve by text. Suspend as well to stop them. | Read as usual. | `rotate` issues new credentials. The old ones never work again. |
| Cancel one deal | The agent's `cancel_deal`, or `job-ops cancel` / `fail-safe-close` | Other deals are unaffected. | `cancel_deal`: the deal is `cancelled`. Each business that quoted gets one close-out note ("the customer has cancelled this request"), then nothing more. A new approval can't start, and a `YES <code>` for an earlier approval approves nothing. `fail-safe-close`: the deal is `failed` (operator_closed), and no business is contacted (§4). | Kept as late replies; never read into the deal. | None: start a new deal. |
| Hold one deal | `job-ops review-job` | Unaffected. | Nothing is sent for that deal (§4). | Stored, not read until `resume`. | `job-ops resume` |

These behaviours are tested in `apps/mcp/tests/lifecycleControls.test.ts` (simulated: in-memory store, fake providers).

## 8. Held texts (`ambiguous_workspace`)

Haggle has one text line. A text from a number that is on deals in more than one workspace, and that doesn't say which deal it answers (no `HG-<code>`, no approval code only one of them has), is never routed by guess. It is held for review, and the human is asked to resend it with the deal code.

If you know which open deal it answers (you phoned the vendor, or the human told you), route it:

```
quarantine.ts list                                   # held texts show reason ambiguous_workspace
quarantine.ts show --message msg_…
quarantine.ts release-text --message msg_… --job job_… --by <you> --why "<how you know>"
```

The script only records the request. On that deal's next advance, the server routes the text through the engine (`releaseHeldText`), which checks again that the number is that deal's approver or a business Haggle contacted on it, and that the deal is still open. Then the text is read as if it had carried the deal code. `job-ops inspect --job` shows the outcome (`operator_request_done`).

An approval, payment or callback reply (`YES`, `NO`, `PAY`, `PAID`, `CALL` with a code) is never released by an operator: the engine refuses it. The human resends it with the deal code. A request for a held or suspended deal is refused up front.

## 9. Operator-requested callback

When a phone vendor quoted more than a real competing quote on the same deal and the deal has a negotiation round left, Haggle can call it back once (Voice AI, which says it is an AI assistant). Normally the approver authorizes this by texting `CALL <code>`. An operator can request it instead, after reviewing the deal:

```
job-ops.ts callback --job job_… --business biz_… --by <you> --reason "<what you reviewed>"
```

- The script refuses at once if the job is closed, held or suspended, if the business isn't on the deal, or (live) if the callee has no recorded consent: a workspace vendor with consent, or a business that itself called Haggle on this deal from an authenticated line (caller ID alone never counts: decision H1). Never a suppressed number.
- Otherwise it records the request. On the job's next advance the engine (`operatorCallback`) re-checks the proposal (a cheaper real competing quote, a round left, not already called back) and the consent, then places at most one call, recorded as `operator:<you>`.
- A refusal at that point (for example, the number opted out meanwhile) closes the request with the reason. A transient failure is retried on the next two advances, then closed as failed. `job-ops inspect` shows each outcome.

A callback never approves, books or pays anything.

## 10. The operator log

Every change made through `workspace-create`, `workspace-admin`, `job-ops`, `quarantine release-text` and the roster is appended to `operator_actions` (migration 119). Each row records who did it (`--by`), why, when, and the workspace and job it concerns. The table refuses updates and deletes.

```
workspace-admin.ts history --id <ws> [--limit 50]     # newest first; contacts masked
```

Suspension and approver verification are read from this log: the latest `workspace_suspended`/`workspace_resumed` row decides, and an `approver_verified` row counts only for the exact phone number and only until the next approver change. If a script reports "done, but not recorded in the operator log", the change stands. Apply migration 119, then note the change in the ticket.
