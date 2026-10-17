# quote-broker integration progress

Branch `yash/integrate-quote-broker` (from `yash/buyer-foundation` at `93e2fc2`). Not pushed or
merged. Source of every port: `AarnavAgrawal/quote-broker@8a68559`.

## Commits

| Commit | Contents |
|---|---|
| `1d68f7c` | inbound matching, attachment extraction, approval verification; money helpers moved from Pass 1 core |
| `8ae9f8c` | quote extraction schema, validation, requirement evaluator, Claude parser |
| `02bc8ac` | honest counteroffers; x402 payment guard |
| `1a327d1` | Primitive webhook edge (verify, strict From, sender trust) + signed-event test builder |
| `8953454` | RFQ email builder; quote ranking; engine exports |
| `65362ed` | apps/mcp: template demo tools/view removed, Haggle metadata, engine dependency |
| `e0d8724` | Primitive outbound sender (pinned-recipient replies) and x402 challenge processing |
| `0d647e0` | fix: counteroffers never cite a quote the ranker rejects; golden module-chain test |

## Files (all in `packages/engine/`, Yash's lane)

| Haggle file | Source file(s) | Kind |
|---|---|---|
| `src/money.ts` | Pass 1 `packages/core/src/schemas/money.ts` | moved (core copy removed at freeze) |
| `src/inbound/matching.ts` | `src/channels/matching.ts` | adapted |
| `src/inbound/attachments.ts` | `src/parser/attachments.ts` | adapted |
| `src/inbound/primitive.ts` | `src/webhooks/primitive.ts` (verify/map/trust only) | adapted |
| `src/parsing/extraction.ts` | `src/parser/quoteSchema.ts` | adapted |
| `src/parsing/validate.ts` | `src/parser/validate.ts` | adapted |
| `src/parsing/requirements.ts` | `src/tools/best.ts` (`dietaryOk` idea) | new, v3 |
| `src/parsing/parseReply.ts` | `src/parser/parseReply.ts` | adapted |
| `src/approvals/verifyApproval.ts` | `src/approvals/verifyApproval.ts` | reused unchanged |
| `src/negotiation/counteroffer.ts` | `src/negotiator/counteroffer.ts` | adapted |
| `src/payments/guard.ts` | `src/payments/guard.ts` | adapted (x402) |
| `src/outbound/rfq.ts` | `src/channels/outreach.ts` | adapted |
| `src/ranking/rank.ts` | `src/tools/best.ts` (`pickBest`) | adapted |
| `tests/*.test.ts` (10 files), `tests/helpers/primitiveEvent.ts` | corresponding `tests/*.test.ts`, `tests/fixtures/primitiveEvent.ts` | ported + v3 cases |
| `package.json`, `pnpm-lock.yaml` | — | deps: `tar@^7.5.22`, `@anthropic-ai/sdk@^0.135.0`, `@primitivedotdev/sdk@2.4.0` |

No changes outside `packages/engine/`, `pnpm-lock.yaml` and these two docs. `packages/core`,
`fixtures/`, root `CLAUDE.md` (still your uncommitted edit) and all Partner paths are untouched.

## Results (09:27 PDT)

| Command | Result |
|---|---|
| `corepack pnpm typecheck` | clean: core, engine, mcp, spikes |
| `corepack pnpm test` | core **40/40**, engine **98/98** (10 files) |
| `corepack pnpm build` | `apps/mcp` built |
| `scripts/verify-migrations.sh` | all assertions passed |
| Source copy (`quote-broker`) | 144/144 tests, typecheck clean, build OK |
| Secret scan | 0 hits (both repos) |

These are unit tests with fakes: the SDK's real signature check and trust logic on synthetic
signed events, a fake Anthropic client and in-memory tar archives. **No live email, LLM,
database or payment path was exercised.** Nothing here is an end-to-end demonstration.

Golden-scenario traps now covered by engine tests: Golden Grill 6/12 vegetarian → `requirement_unmet`;
Harbor Table deposit on `pdf p.2` → `hidden_deposit` (not added to total); Mission Eats vague
price → `missing` + `low_confidence`, never 0; Sunset Kitchen question → `question_pending`;
QuickQuote Deli → `external_payment_link` + `prompt_injection`, rejected from ranking; Bay
Catering $1,150 → countered with Harbor's real $1,120 → $995 revision recommended.

## Blockers

1. **Contracts not frozen** (`packages/core/contracts.ts` doesn't exist). Persistence, tools,
   ingestion and brain calls are deliberately not built against speculative types.
2. x402 entitlement missing; buyer wallet 0 test USDC (see `docs/v3-prekickoff-readiness.md`).
3. Reuse permission: the source has no LICENSE; get the partner's explicit OK (§6 of the audit).

## Partner handoff

- Confirm reuse permission for the ported files (credited in headers and commits).
- Port `sim/` into `apps/sellers` with the v3 personas (Bay Catering, Harbor Table, Mission
  Eats, Golden Grill, Sunset Kitchen, QuickQuote Deli). Its "code decides numbers, Claude
  phrases" design is exactly what the golden matrix needs. Emit `quote.json` for Bay Catering
  and a page-2 deposit PDF for Harbor Table (reuse `sim/menuPdf.ts`).
- Port `eval/` ideas into `apps/bench` (Manufact suites per v3).
- Contract inputs from the source: `Quote` needs `delivery_usd`/`tax_usd`, and `dietary`
  coverage needs counts (proposal D3 already has both).
- The simulator inboxes are separate Primitive agent accounts; v3 wants one Function on the
  seller org. Pick one before 11:30.

## Recommended next steps (after 11:30 freeze)

1. Write `supabase/migrations/100_engine_core.sql` (proposal §7C plus quote-broker's unique indexes) and run `verify-migrations.sh`.
2. Repository layer + `ingestInbound()` wiring the ported matcher, `senderTrust`, attachments and parser.
3. Primitive outbound adapter with per-job From and idempotency keys (adapt `email.ts`).
4. Job driver with CAS + after-commit effects (pattern from `advanceJob`).
5. `deal`, `wait_for_update`, `get_quotes` on mcp-use with the frozen result types; deploy a preview; register the webhook endpoint → **2 PM gate**.
6. `answer_seller`, counteroffers, `approve` (elicitation + `verifyApproval`), x402 payer behind `checkX402PaymentAllowed`, deal board from `quote-board` → **8 PM gate**.


## Update 09:30 PDT

See `docs/kickoff-baseline-and-parity.md` for the verified baseline, parity matrix and handoff. Tests now: core 40, engine 114.
