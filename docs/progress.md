# Buyer-side progress (actual status only)

## 2026-10-16 (Friday, pre-event)

| Item | Status | Evidence |
|---|---|---|
| Event-rules check | **Unresolved** — no public rule on pre-event code | `docs/buyer-implementation-plan.md` § Event-rules gate |
| Nested git repo + `yash/buyer-foundation` | Done | `git log` |
| Core schemas, job/seller state machines, protocol parts (PROPOSED) | Locally verified | `pnpm test`: 34 passed; `tsc` clean |
| Supabase migration + DB-level payment invariants | Locally verified | `scripts/verify-migrations.sh`: 17 negative assertions rejected for the intended reason, Postgres 17 |
| `apps/mcp` scaffold (mcp-use 2.10.0) + `/health` | Locally verified | build OK; `/health` and `tools/list` answered over HTTP |
| CONTRACTS.md, CLAUDE.md, .env.example, plan | Done | — |
| Buyer fixtures: 15 emails (6 benchmark traps + 9 edge cases), 2 PDFs, scenario | Locally verified | fixture-integrity tests: 6 passed |
| Integration handoff draft | Done | `docs/integration-handoff.md` |
| Primitive round-trip spike script | Implemented, **not run** (no credentials) | refuses without key; typechecks |
| Primitive / Anthropic / Supabase / Manufact real calls | **Blocked** — no credentials in environment | — |
| Parsing, negotiation, tools, deal board, approval/payment, demo | **Not started** — user chose to hold until organizers confirm pre-event work is allowed | — |

## 2026-10-17 (Saturday, before kickoff) — infrastructure readiness

| Item | Status | Evidence |
|---|---|---|
| Event-rules check | **Unresolved** — product work held until 10:30 AM | — |
| Root scripts fixed to `corepack pnpm -r` | Locally verified | `corepack pnpm test`: 40 passed |
| Read-only preflight script (`@haggle/spikes preflight`) | Implemented | `docs/preflight-readiness.md` |
| `.env` (chmod 600, ignored) + `SUPABASE_DB_URL`/`HAGGLE_BUYER_INBOX`/`ANTHROPIC_MODEL` in template | Done; values pending | — |
| Prod start on `$PORT`, `/health`, `tools/list`; core bundled into build | Locally verified | probe build |
| Manufact CLI | Available, not logged in | `mcp-use whoami` |
