# Integration readiness: release/rc1 vs Aarnav's feat/live-demo (read-only analysis, 2026-10-18)

Compared Yash's rc1 at `50d25a3` with `origin/feat/live-demo` at `9b91a645`. Merge bases: `7934438`, `22ee9ea`. `origin/yashnil` and `origin/aarnav` are stale backups. Nothing was merged, cherry-picked or changed on either branch. This supersedes `integration-risks-live-demo.md`, which was written against an earlier rc1.

## Feature differences
**live-demo only:**
- **Tools:** `negotiate` (manual round 3), `send_message`, `get_conversation`, `get_identity`, `cancel_deal`.
- **Views:** conversation and identity-card.
- **Workspaces and auth:** `HAGGLE_AUTH`, `/c/:secret/mcp`.
- **Scheduling and channels:** `POST /internal/tick`, SMS (`text.received`, `HAGGLE_ENABLE_SMS`), call hours.
- **Engine:** custom asks (`ask`, `compare_by`, `payable_field`, `fields`), confirm-only approvals (`confirmed`), follow-up and escalation scheduling, `messageGuard`, a heuristic parser fallback.
- **Bench:** run-eval with catering and plumbing tasks.

**rc1 only:**
- **Discovery and identity:** Google Places discovery, reputation and website evidence; named-vendor resolution (`HAGGLE_DEMO_VENDORS`); observed-only live memory with record-based aliases.
- **Quote handling:** two-part extraction (under the Anthropic grammar limit), `MAX_ROUNDS = 2`, approximate totals, parse retries.
- **Recommendation and negotiation:** approvable recommendations (`best_value_quote_id`), value ranking with a strategist, call safety, `call_back`.
- **Contact and board:** contact states and stages, `list_deals`, the redesigned board and approval card (`pay_now_basis`).
- **Tests:** production-constraint guards.

**Likely defect on live-demo:** a quote with no total but marked compliant violates `quotes_check1` (`engine.ts`, around lines 1630–1647), the Postgres error rc1 fixed in `1218d0e`.

## Conflicts (trial `git merge-tree`, nothing written)
17 files, 102 hunks:

| Subsystem | Files (hunks) | Severity |
|---|---|---|
| Engine | `engine.ts` (30), `stateMachine.ts` (1), `contract.ts` (2) | Design |
| Parsing | `parseReply.ts` (3), `requirements.ts` (1) | Design: one schema vs two; soft vs hard requirements |
| Ranking / negotiation | `rank.ts` (2), `counteroffer.ts` (2) | Design |
| Outbound | `rfq.ts` (4) | Mixed |
| MCP server | `index.ts` (17), `live.ts` (4), `views.ts` (3) | Design |
| Views | `deal-board/view.tsx` (14), `view.css` (3), `approval/view.tsx` (9) | Design: two board redesigns |
| Tests and docs | 2 test files, `CHECKLIST.md` | Mechanical |

`packages/core` merges cleanly. live-demo bumps it from v5 to v6, additive, which needs sign-off from both owners.

## Database and schema
- **Shared migrations:** both branches have 100–102 and 200–201, identical.
- **live-demo adds `103_engine_parity.sql`:**
  - workspaces, plus `jobs.workspace_id`;
  - send attempts and escalation columns;
  - approval actions;
  - widened CHECKs: `confirmed` state, more message kinds, `locked` approvals, payments ≥ 0;
  - `client_request_id` made unique per workspace.

  103 is not applied to production (`public`), and live-demo's engine writes those columns. It also hard-codes `public.`, while live-demo's own server uses `HAGGLE_DB_SCHEMA=haggle` on a different Supabase project.
- **Rounds:** `jobs.max_rounds` stays 1..2 on both. live-demo's `negotiate` opens round 3.

## Identities, roster and webhooks
- **Buyer identity:** production uses `haggle` in Yash's Inkbox org. live-demo uses `haggle-buyer` plus a phone number in Aarnav's org, where its sellers live. Sender trust needs the buyer and sellers in the same org.
- **Roster:** rc1 uses `HAGGLE_DEMO_VENDORS`. live-demo uses `HAGGLE_DIRECTORY_JSON` plus `TEXT_VENDOR(_PHONE)`.
- **Webhooks:** both serve `POST /webhooks/inkbox` with the same signature check. live-demo adds `text.received`, `/internal/tick` and `/c/:secret/mcp`.
- **A script not to port as-is:** live-demo's `inkbox-webhook-move.ts` repoints the `haggle` subscription and prints a new signing key. Never run it against Yash's org.

## MCP contract differences
- **`deal`:** live-demo makes `date` and `quantity` optional and adds `ask`, `compare_by`, `payable_field` and `details`. rc1 has `date_until`, `time`, `venue`, `budget_kind`, `preferences`, `dry_run` and name/ref resolution.
- **The board:** rc1 returns `DealBoardPlus`. live-demo returns core v6 plus `total_known` and shows unknown totals as 0; rc1 never shows an unknown as $0.
- **`approve` / `pay`:** live-demo adds `action` (confirm / pay / confirm_and_pay) and a `confirmed` status.

## Safest integration path (when both demos pass and Yash approves)
1. **Base on rc1, on a new `integrate/*` branch.** Pin live-demo at the analysed sha and port one subsystem per commit, never a wholesale merge.
2. **Accept core v6** in one commit agreed by both owners. Keep rc1's extensions in `apps/mcp/src/views.ts`, and map "unknown" to unknown, never $0.
3. **Re-issue 103 as a new schema-neutral migration** (e.g. `104_engine_workspaces.sql`). Apply it to production and to Aarnav's schema, keeping `max_rounds` 1..2 and `quotes_check1`.
4. **Port low-risk additions behind flags, default off:** SMS and `text.received`, `/internal/tick`, `get_conversation`, `get_identity` and `cancel_deal` (with their views), and `send_message` only together with `messageGuard`.
5. **Port custom asks into `ExtractionDetails` only.** Add a schema-size budget, and keep "no total ⇒ not compliant".
6. **Cap `negotiate` at `MAX_ROUNDS`.**
7. **Workspaces and auth:** port them, defaulting to open so one-click installs keep working.
8. **Keep the `HAGGLE_DEMO_VENDORS` roster.** Express `TEXT_VENDOR` as a vendor entry with `channel: sms`.
9. **Do not port `inkbox-webhook-move.ts`** as written.

**To decide together:**
- requirement policy (hard vs soft);
- the `negotiate` round cap;
- core v6 sign-off;
- which board and approval design wins;
- one Supabase project and schema;
- one buyer identity and org;
- the roster mechanism;
- whether hosted servers require auth.

**Must pass after integration:**
- **rc1 engine suites:** productionGuards, noTotalQuotes, paymentSafety, quoteIntegrity, approximateTotals, parseResilience, recommendation, liveRounds, liveReplies, negotiationStory, callSafety.
- **rc1 MCP suites:** brainObserved, businesses, vendors, discovery.e2e, journey.e2e, simJourney.e2e, acceptance.release.
- **live-demo suites:** parity, sms, callTranscript, keepChat, workspace, runEval.
- **A new test:** a no-total quote on the custom-asks path is stored as not compliant.
- **Real-provider checks:** extract-eval and strategy-eval.
- **Screenshots** of every view.
