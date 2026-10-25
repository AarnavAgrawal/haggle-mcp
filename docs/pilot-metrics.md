# Pilot metrics

How Haggle measures pilot usage, how it keeps simulated runs out of the real numbers, how it estimates Anthropic cost, and how to run the reproducible simulated benchmark. Owner: Yash (sprint 5, workstream E).

**No real-world evidence exists yet.** No real vendor has been contacted through Haggle, and no real approval, booking or payment has been recorded. Every number in this repository so far comes from simulated runs. `scripts/metrics.ts` will report real usage once pilot jobs exist; until then its REAL column is zero.

## 1. Where the numbers come from

`apps/mcp/scripts/metrics.ts` computes every number from rows in the engine database. Code: `packages/engine/src/ops/metrics.ts`.

| Source table | Used for |
| --- | --- |
| `jobs` | the window (`created_at`), mode, workspace, state, durations |
| `job_businesses` | vendor contacts, channel, `simulated`, escalation to a call |
| `messages` (no bodies) | inbound replies: verified sender, simulated flag |
| `quotes` | priced and valid quotes, time to first quote |
| `questions` | the human's answers to business questions |
| `approvals`, `bookings`, `payment_handoffs`, `handoff_receipts`, `payments` | approval, booking and payment milestones and timings |
| `job_events` (only the keys `to`, `from`, `status`, `by`, `kind`, `question_id`, `business_id`, `approval_id`, `total_usd`, `reason`, `cause`) | funnel, BOOKED attestations, released held texts, operator closes and retries |
| `operator_reviews`, `quarantine_resolutions`, `held_texts` | manual interventions |
| `analytics_test_marks` (migration 116) | test workspaces and test jobs |
| `ai_usage_events` (migration 122) | Claude calls and tokens per job, by model |

The report never reads in-memory counters, so a restart does not change it. Event summaries and message bodies are never loaded, because they can quote a vendor's own words. The script runs inside a single `READ ONLY` transaction, so the database rejects any write.

## 2. Simulated vs real: the rule

The rule is defined once, in `classifyJob` (`ops/metrics.ts`), and tested in `packages/engine/tests/metrics.test.ts`. A job counts as **real usage** only if all four conditions hold:

1. `jobs.mode = 'live'`. Mock mode (the DEMO fleet, simulated approvals and payments) never counts.
2. Its workspace is not marked as test. Operators mark workspaces with `scripts/traction.ts mark-test --workspace …`; the latest mark wins.
3. The job itself is not marked as test.
4. At least one of its businesses is not simulated. A live job that reached only the simulated fleet is a rehearsal.

A job that fails any condition is **simulated**. The report records the first condition it failed: `mock_mode`, `test_workspace`, `test_job` or `simulated_vendors_only`.

Inside a real job, the report also drops every row that belongs to a simulated business: its contacts, messages, quotes, approvals, bookings, handoffs, and the events that name it or its approval. It drops messages flagged `simulated` too. These dropped rows are counted under "Dropped from real jobs". The real numbers therefore never include a simulated row. A test checks this property directly: removing every simulated row from the input leaves the real bucket unchanged, and adding more simulated jobs changes only the simulated bucket.

The report shows both buckets side by side. The SIMULATED bucket keeps every row of its jobs, so a rehearsal can still be checked against the same measures.

How this relates to `scripts/traction.ts` (migration 116 views): traction counts every live, unmarked job as a deal (`deals_created`), even when all of its vendors were simulated. Metrics is stricter because of condition 4. Both exclude simulated vendors' replies, quotes and approvals.

## 3. Definitions

Every measure below is computed separately for each bucket.

- **Jobs**: jobs created in `[--since, --until)`, optionally limited to one `--workspace`.
- **Sourcing completion**:
  - jobs with ≥1 *priced* quote: a total from a verified sender;
  - jobs with ≥1 *valid* quote;
  - jobs with ≥N valid quotes from *distinct* businesses (`--min-quotes`, default 3).

  A valid quote is priced, comes from a verified sender, meets every stated must-have (`quotes.compliant`) and has not been withdrawn. Budget and the per-payment ceiling are checked separately, so a valid quote can still be unapprovable.
- **Quote response rate per vendor contact, by channel**: a contact is one business on one job with `contacted_at` set, grouped by the channel it was finally reached on (email, phone, imessage, a2a). *Replied* means a verified inbound message or a quote from that business on that job. *Quoted* means a priced quote. The report also counts escalations from email to a call.
- **Manual interventions**: every time a person had to step in beyond approving:
  - operator reviews opened (and resolved), by kind;
  - quarantined messages released or rejected;
  - held texts released (`text_released`), plus held texts still pending;
  - the human's answers to business questions (answers Haggle grounded in the request are counted separately as automatic);
  - `BOOKED` attestations (the human accepted a booking from a sender Haggle could not verify);
  - bookings the human confirmed directly (`not_in_writing`);
  - operator closes, operator retries and `operator_attention` events.

  The report gives the total and the total per job.
- **Timings**, measured from `jobs.created_at`, as median, p90, mean and n:
  - to the first priced quote;
  - to the first approval decision (`approved`/`used`);
  - to the first vendor-confirmed booking (`bookings.confirmed_at`);
  - total duration of finished jobs (the last state event into `paid`, `confirmed`, `cancelled` or `failed`).

  A milestone that never happened is shown as `-`, never 0.
- **Funnel and drop-off**: the furthest milestone each job reached, from its own events. The milestones, in order, are created, contacted, replied, quoted, approval requested, approved, booked, payment reported and completed (`ops/traction.ts`). Drop-off is the number of jobs lost between consecutive milestones, plus where unfinished jobs stopped.
- **AI usage**: Claude calls, tokens (input including cache reads and writes, output) and approximate USD per bucket, per job and per model (section 4). Usage rows not tied to a job in the window are reported separately.

## 4. Anthropic cost: pricing assumptions (APPROXIMATE)

`packages/engine/src/ops/costs.ts` multiplies the token counts each Claude response reported (`ai_usage_events`) by list prices. The result is an estimate, not an invoice. It ignores discounts, batch pricing, partner-platform pricing (Bedrock, Vertex) and taxes.

Source: the Claude API model table, cached 2026-10-06 (the claude-api skill) and checked 2026-10-22. Prices are USD per million tokens on the Anthropic first-party API.

| Model id | Input | Output | Cache read | Notes |
| --- | --- | --- | --- | --- |
| `claude-fable-5-1` | 10.00 | 50.00 | 0.25 | listed |
| `claude-fable-5` | 10.00 | 50.00 | 1.00* | |
| `claude-opus-5-5` | 4.00 | 20.00 | 0.20 | listed |
| `claude-opus-5`, `claude-opus-4-8`, `-4-7`, `-4-6` | 5.00 | 25.00 | 0.50* | |
| `claude-sonnet-5-5` (the engine's default `ANTHROPIC_MODEL`) | 2.00 | 10.00 | 0.20 | listed |
| `claude-sonnet-5` | 2.00 | 10.00 | 0.20* | |
| `claude-sonnet-4-6` | 3.00 | 15.00 | 0.30* | |
| `claude-haiku-5-5` | 0.10 / 0.50 | 0.50 / 2.50 | 0.01* | the second price applies to prompts over 100K tokens (per call) |
| `claude-haiku-4-5` | 1.00 | 5.00 | 0.10* | |
| any other id | 10.00 | 50.00 | | fallback (the most expensive tier), and the report lists it as unpriced |

\* Assumed at 0.1× input, Anthropic's usual cache-read discount. Cache writes are assumed at 1.25× input (the 5-minute TTL); a 1-hour TTL write costs more.

To override prices for one run, pass `scripts/metrics.ts --prices '{"claude-sonnet-5-5":{"input":2,"output":10}}'` (merged over the table). Check the table against the current Anthropic price list before quoting a cost.

**How usage is recorded.**
- The live server meters every Claude call (`live/aiUsage.ts`) in memory, to enforce `HAGGLE_AI_MAX_CALLS_PER_JOB` and `HAGGLE_AI_DAILY_TOKEN_BUDGET`.
- Since migration 122 the meter also persists each call: job, workspace, purpose, model and the four token counts. `apps/mcp/src/live.ts` passes `sink: aiUsageSink(repo)` to its `AiUsageMeter`. No prompt or reply text is stored. A failed write is logged and never fails the call.
- Those rows also feed the limits back: at start-up and every 60 s the live server rehydrates the meter from today's rows (`hydrateAiMeter`, the larger of memory and the database per count), so a restart keeps today's usage and replicas converge within a minute.

## 5. How to run

```sh
# Usage metrics (read-only; refuses a production database outside HAGGLE_ENV=production)
cd apps/mcp
node --env-file=.env scripts/metrics.ts                       # text: REAL and SIMULATED side by side
node --env-file=.env scripts/metrics.ts --json --since 2026-11-01 --until 2026-12-01 --workspace ws_acme --min-quotes 3

# Mark traffic that must never count as real usage
node --env-file=.env scripts/traction.ts mark-test --workspace ws_internal --reason "internal demo" --by "<name>"
```

Needs `SUPABASE_DB_URL` with migrations through 116 applied (122 adds per-job AI usage; without it, AI usage reads as 0).

## 6. The simulated pilot benchmark

`apps/mcp/scripts/pilot-benchmark.ts` runs N catering deals in **mock mode** with fixed seeds. The DEMO vendors are scripted; approval is the simulated DEMO human and payment is the simulated Stripe rail. Nothing real is contacted.

```sh
cd apps/mcp
node scripts/pilot-benchmark.ts --n 10 --seed 1                 # markdown summary
node scripts/pilot-benchmark.ts --n 10 --seed 1 --json --out /tmp/bench   # + JSON and markdown files
HAGGLE_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55445/postgres \
  node scripts/pilot-benchmark.ts --n 3 --repo pg               # same deals on a throwaway local Postgres
```

**What one run does.**
- For each deal, a seeded PRNG chooses the headcount, budget, event day, must-haves and which of the six DEMO vendors are asked.
- A scripted reference agent then follows the tool descriptions: `deal`, then `wait_for_update` as 25 s long-polls passing back the cursor, then `answer_business` for each open question (the user answers in chat, a human step), then `get_quotes` once quotes are final, then `approve` the recommendation (the simulated human approves, a human step), then `pay`.

**What it records.**
- Per deal: tool calls, human steps, output size per tool (structuredContent JSON chars, ~tokens at 4 chars/token, built with the same `src/views.ts` constructors the tools use), and simulated minutes to the first quote, to final quotes and to paid. It also records wall-clock latency, the outcome, the recommended business and total, and recorded AI usage. Mock mode makes no Claude calls, so recorded usage is always 0.
- A *projected* live AI cost, which is an **assumption, not a measurement**: 4,000 input and 800 output tokens per vendor reply on `claude-sonnet-5-5` (`PROJECTION` in the script).
- The metrics rule applied to the benchmark's own jobs. Every job must land in the simulated bucket with reason `mock_mode`.

**Reproducibility.** The engine clock is simulated (it starts at 2026-10-01T16:00Z, one simulated day per deal), so outcomes, counts, sizes and simulated durations are identical for the same code and seed. `fingerprint` is a hash of everything except wall-clock time; compare fingerprints across commits. `apps/mcp/tests/benchmark.test.ts` runs a small N and checks determinism, the board budget and the metrics rule.

**What it cannot tell you.**
- Real vendor behaviour: the fleet's prices are fixed, so small budgets often end with nothing approvable.
- A real LLM agent's tool-call pattern: the reference agent polls more than a well-tuned agent would.
- Real latency.
- MCP transport framing and the content text that accompanies each structuredContent.

**Results at the time of writing** (`--n 10 --seed 1`, memory repo, SIMULATED):

| Measure | Before the sprint 5 output changes | After |
| --- | --- | --- |
| Fingerprint | `632e02bfa4ff87a2` | `759e38dc20f04470` |
| Outcomes | paid 4, nothing approvable 6 (budgets below the fleet's fixed prices or the $500 mock per-payment ceiling) | same |
| Tool calls per deal (mean / max) | 32.2 / 46 | same |
| Human steps per deal (mean / max) | 1.1 / 2 | same |
| Agent-facing output per deal (structuredContent chars, mean) | 25,807 (~6,452 tokens) | 22,646 (~5,662 tokens), −12.2% |
| `wait_for_update` mean chars (287 calls) | 459 | 371 (−19%) |
| `get_quotes` mean / max chars | 8,841 / 11,497 | 8,397 / 10,851 |
| Simulated minutes to first quote / final quotes / paid (median) | 0.1 / 10.4 / 10.4 | same |
| Metrics rule on the benchmark's jobs | real 0, simulated 10 (`mock_mode` 10) | same |

**What changed in the output (lossless for the agent and the view).**
- A `wait_for_update` poll that times out with nothing new after a cursor the agent already holds now carries a one-line `next` ("Nothing new since cursor N; the previous hint stands…"). With no new event nothing changed, so the hint the agent received with that cursor still stands. Cursor 0 and any update keep the engine's full hint.
- The compact board no longer repeats a `not_selectable` selection reason that restates `quote_status[id].block` or `rejected[].detail` word for word.
- The compact board drops the contact-history fields that the view never shows and that can be derived (`response_rate` = replied/contacted, `quotes`, `confidence`). `detail: true` still returns all three.
- The compact board drops empty `assumed` lists (absent means nothing was assumed).

**Open:** a busy workspace's six-vendor board in which every quote is noncompliant and negotiation reached round 2 still measures 10,851 chars, above `BOARD_CHAR_BUDGET` (10,000). The golden six-quote board stays under it, as `boardSize.test.ts` checks. Further cuts would change what the view renders or the core `DealBoard` schema (for example, each quote's `job_id`), so they are left to a shared-contract decision.
