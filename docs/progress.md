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
| Primitive / Anthropic / Supabase / Manufact real calls | **Blocked** — no credentials in environment | — |
| Parsing, negotiation, tools, deal board, approval/payment, demo | **Not started** — held pending the rules decision | — |
