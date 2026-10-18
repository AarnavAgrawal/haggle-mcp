# Release rc1: progress checkpoint (lead: Claude Code)

Base: yashnil-integrate @ 70f003e (deployed 99a000c6). Branch: release/rc1 (local; nothing pushed or deployed).
Production job job_868e… is left untouched (no reset/replay); a fresh rehearsal replaces it.

## Ownership (one owner per file)
| Worker | Owns | Goal |
|---|---|---|
| A engine + negotiation | packages/engine/src/** (incl. workflow/engine.ts, negotiation, ranking, payments), packages/engine/tests/** | approximate/unknown handling + clarification, autonomous progression, schema/config guards, negotiation integrity |
| C infra + risks | read-only; docs/integration-risks-live-demo.md in its worktree | future-integration risk note (no merge of any kind), env/schema/deploy readiness for our branch |
| D UI | apps/mcp/views/** | board states, negotiation story, approval/payment clarity |
| E acceptance | scripts/acceptance/**, apps/mcp/tests/acceptance*.test.ts | independent acceptance matrix incl. real-Claude + real-provider |
| Lead | apps/mcp/index.ts, apps/mcp/src/**, docs, CHECKLIST | contracts, integration, release |

## Log
- rc1-0: two-part extraction fix (core + details schemas) committed; real API 3/3 on live replies.
- Policy (user, 2026-10-18): Aarnav's current work is origin/feat/live-demo (9b91a64). `yashnil` and `aarnav` are stale backups. No merge, cherry-pick or rebase of his branch; read-only inspection only; integrate only after both versions pass their own live demos and the user approves.
- rc1-1: get_quotes text lists every quote with its uncertainty; approve explains approximate totals (272dbd0).
