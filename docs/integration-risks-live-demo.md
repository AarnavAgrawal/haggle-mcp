# Integration risks: feat/live-demo → release/rc1 (read-only note)

Analyzed: `origin/feat/live-demo` @ `9b91a645850a3278f3ad211cfd3c8d38941f93a5` vs `release/rc1` @ `272dbd0`. Merge bases (criss-cross): `7934438`, `22ee9ea`. Not merged; nothing integrated. A trial merge (discarded) conflicted in 12 files, 27 hunks in `engine.ts` alone: both sides rewrote the engine in parallel.

## Database / migrations
- **New `103_engine_parity.sql`** (Yash lane, written on Aarnav's branch). Production is on 100–102 + 200–201; a 103 is NOT applied there. His engine writes `jobs.workspace_id`, `job_businesses.send_attempts/next_attempt_at/escalated_at`, `approvals.action/attempts`, so his engine against our DB fails on insert.
- 103 widens CHECKs: `jobs.state` + `confirmed`; `messages.kind` + `message`, `confirmation`; `approvals.status` + `locked`; `approvals.payment_cents >= 0` (0 allowed for confirm-only); drops `jobs_client_request_id_key` for `(workspace_id, client_request_id)`; adds `workspaces` (hashed bearer tokens) and replaces `haggle_payment_matches_approval()`.
- It hard-codes `public.` but his live DB keeps engine tables in a `haggle` schema (`HAGGLE_DB_SCHEMA`, new Supabase project). Two Supabase projects with different schemas; the migration does not run as written on his.
- Rounds: 103 leaves `jobs.max_rounds` at 1..2 and `round` at 1..3. His `negotiate` tool opens a manual round `MAX_ROUND` (3) beyond `max_rounds`, which the DB allows but our `MAX_ROUNDS = 2` policy forbids. `deal.max_rounds` stays ≤ 2 on both sides.
- Number clash: any 103 we add later collides with his file name.

## Extraction schema (Anthropic grammar limit)
- His `QuoteExtraction` adds `tax_rate_percent` and `answers[]` ({key,value,source,excerpt}) and still parses with **one** schema (`zodOutputFormat(QuoteExtraction)`). Our two-schema split (`CoreExtraction` + `ExtractionDetails`, aa688b7) is gone on his side, and the schema is *larger* than the one that already failed live with "compiled grammar is too large". If ported: put both new fields in `ExtractionDetails`, never in core.

## Ranking / safety policy (design conflict)
- 44b8ad5 "preferences are soft": `rejectReason` no longer rejects `requirement_unmet` or `over_budget`; negotiation runs on every safe quote. Ours rejects unmet/unconfirmed hard requirements, `all_in_unknown`, and over a `budget_kind: "limit"`. Choose one policy before merging.
- Duplicate implementations of call safety: his `parsing/heuristic.ts` + `workflow/callPolicy.ts` vs our `parsing/callSafety.ts` (`dropAgentOnlyAmounts`, `answeredSomething`, `businessText` defined twice).

## Inkbox identities / org / webhooks
- New buyer event `text.received` (SMS) → `engine.ingestText`; sellers `live.ts` *updates an existing* buyer subscription to add it. Fine only for the identity/org it targets (buyer `haggle` is in Yash's org; sellers + `haggle-buyer` phone in Aarnav's).
- `packages/engine/scripts/inkbox-webhook-move.ts` repoints the `haggle` identity's `/webhooks/inkbox` subscription to any URL (with `--confirm`) and prints a newly minted signing key to stdout. Running it against our org would move production webhooks away from Manufact.
- `TEXT_VENDOR_PHONE` turns one email persona into an SMS vendor and adds that number to `HAGGLE_ALLOWED_RECIPIENTS`.

## MCP tool contracts
- Adds `negotiate`, `send_message`, `get_conversation`, `get_identity`, `cancel_deal`; lacks our `list_deals`, `call_back`, `call_back_in_view`, plus `src/businesses.ts`, `vendors.ts`, `fixtures.ts` (Google Places discovery, named-vendor resolution).
- `Request.date` and `quantity` become optional, and `ask`/`compare_by`/`payable_field`/`details` are new. Ours keeps `date` required with `date_until`/`time`/`venue`/`budget_kind`/`preferences`.
- `HAGGLE_AUTH` + workspaces: with auth on, every MCP client needs a bearer token or `/c/<secret>/mcp`, which breaks the current one-click installs.

## Embedded views / shared contracts
- `packages/core` bumped to `haggle.contracts/6` (shared surface; needs both owners): `JobState.confirmed`, `Quote.fields/missing_fields/total_known`, `DealBoard.job.ask/compare_by`, `Approval.action`, `ApprovalStatus "confirmed"`, new Conversation and Identity views (`views/conversation`, `views/identity-card`), `deal-board/keepChat.ts`. The deal-board/approval views conflict with our board (stages, caveats, Can't win).
