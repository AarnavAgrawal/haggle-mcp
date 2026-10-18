# Yash's branch (release/rc1): contracts, schema and invariants for integration

This branch is what runs on calm-spark. `packages/core` (contracts.ts, views.ts, v5) is **unchanged**: everything below
is an additive extension in Yash's lanes (`packages/engine`, `apps/mcp/index.ts`, `apps/mcp/src/**`), so the shared
seam with Aarnav's code is still core v5.

## MCP tools
| Tool | View | Notes |
|---|---|---|
| `deal` | deal-started (board) | `businesses`: names or refs (`"Mission Eats"`, `mission_eats`, `place:<id>`) resolved server-side; exact scoping, fail closed (`unknown_business`, `ambiguous_business`, `vendor_not_ready`, `not_authorized`, `no_contact_route`, `no_vendors_for_category`); `dry_run` → `would_contact` + `blocked`; no budget = none (never a settings value); `date_until` for "next week"; `max_rounds` ≤ 2 |
| `wait_for_update` | – | long-poll; quote lines name the business |
| `get_quotes` | deal-board | `job_id` required in practice: without it returns `job_id_required` + recent deals (never guesses a job) |
| `list_deals` | – | recent deals with start time; `leading` = the board's approvable recommendation |
| `discover` | – | demo roster (category `catering`) + Google Places `found` with contact states; `public_discovery.status` ok / not_configured / key_rejected / rate_limited / unavailable / no_area |
| `business_profile` | business-profile | evidence items `{kind, statement, source, observed_at, freshness, confidence, caveat}`, `unknowns`, `contact_status` |
| `approve` / `approve_in_view` (app-only) | approval | human-only approval of one exact quote version |
| `pay` | payment | Stripe test mode; exactly the approved amount; idempotent per approval |
| `call_back` / `call_back_in_view` (app-only) | – | human-authorized Voice AI callback |
| `ask`, `check_price`, `answer_business`, `open_haggle`, settings, `mention_businesses` | various | unchanged semantics |

## Board view model (`DealBoardPlus`, apps/mcp/src/views.ts; superset of core `DealBoard`)
- `request_details`, `payment_ceiling_usd`, `payments_enabled`, `value` (best-value factors), `callbacks`, `terms`, `contact_learning`, `setup`, `not_contacted`, `warnings`.
- `stages[business_id] = {stage, negotiation, first_total_usd, current_total_usd, quote_version, saved_usd}`. The stages are sending, waiting, calling, responded, reply_unreadable, asked_question, clarifying, quoted, countered, vendor_revised, held_firm, final, excluded, buyer_approved, paid, no_reply, unreachable and declined. `first_total_usd` is the business's first **firm** price, and `saved_usd` only measures a business's own revision of a firm price.
- `quote_status[quote_id] = {approvable, approximate?, block?: {code, reason}}`. The block codes are total_not_firm, over_cap, no_total, zero_total and quote_not_eligible.
- `recommended_quote_id` = the best value the human can approve. `best_value_quote_id` and `recommendation_note` are set when the overall best value can't be approved.
- `negotiation_estimates` = the basis quote ids that counters cited as estimates ("about $X").
- Quote flags (strings): the existing ones plus `approximate_total`.
- `dry_run`, `would_contact`, `blocked` (deal preview).

`ApprovalOut` = core `Approval` + `channel: "simulated"`, `order_total_usd`, `pay_now_basis: "deposit" | "full_total"`, and `payment`. `deposit_usd` is omitted when the business stated none: it is never shown as $0.

## Engine invariants (tests in packages/engine/tests)
- Quote extraction uses two structured-output schemas: `CoreExtraction` (required) and `ExtractionDetails` (optional; a failure leaves them unknown). A single schema exceeds Anthropic's compiled-grammar limit. Size budgets are enforced in `productionGuards.test.ts`. Never grow `CoreExtraction`.
- `MAX_ROUNDS = 2` (first quotes + one negotiation round), matching `jobs_max_rounds_check`.
- A quote without a total is stored `compliant = false` (`quotes_check1`). A $0 total is never approvable.
- Approximate totals ("around", "approximately", "prolly", spoken figures) are ranked and shown as ≈ but are not approvable or payable. Haggle asks once for a firm total by email or text. Phone vendors need a human-authorized callback.
- Transient parse failures are retried (3×, 30/60/120 s, recorded as `parse_retry` events). Permanent ones are `failed` and never re-read.
- Approvals bind one quote version and are voided on revision. Payment = the deposit, or the full total when no deposit was stated. It is capped by `HAGGLE_GLOBAL_PAYMENT_CAP_CENTS` (operator ceiling, separate from the budget). A budget is a target by default and never excludes a quote.
- Live business memory is observed-only (seed samples hidden). Identity is name + contact. Older ids are linked through Haggle's own job records (`businessAliases`).

## Database
Migrations: `100_engine_core`, `101_engine_channels`, `102_engine_stripe` (Yash), `200_brain_profiles`, `201_brain_profiles_grants` (Aarnav). This release adds **none**; production (schema `public`) has exactly these. The CHECK constraints the engine relies on, `jobs_max_rounds_check` (1..2), `quotes_check1`, the approval and payment amount checks (> 0) and the `parse_status` values, are guarded by `productionGuards.test.ts` and exercised on Postgres by `scripts/test-postgres.sh` (`noTotalQuotes`, `liveRounds`, `liveReplies`, …).

## Environment
See `.env.example`. Live mode requires `INKBOX_API_KEY`, `INKBOX_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `SUPABASE_DB_URL`. The roster is `HAGGLE_DEMO_VENDORS` (JSON keyed by vendor), and configuring a contact authorizes it. Other recipients come from `HAGGLE_ALLOWED_RECIPIENTS`. Deploy: clean worktree of the release commit + `.mcp-use/cloud/link.json` → `mcp-use deploy`, with `HAGGLE_BUILD_SHA` set to the commit.
