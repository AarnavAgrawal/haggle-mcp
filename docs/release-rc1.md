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
- rc1-2: workers integrated (C risk note ecb8b68; E acceptance acde269; D views a90efa3; A engine 1218d0e) + lead integration (61c974c, 89efc64, 3deebbe, 5f3a69f).

## Release candidate (local, unpushed)
- Branch release/rc1 @ the commit containing this line; base 70f003e (deployed 99a000c6). Aarnav's feat/live-demo (9b91a64) not merged.
- Local evidence: 470 tests (+1 skipped); Postgres 306/306; release acceptance on Postgres 14/14; simulated journey 1/1;
  real Anthropic: extract-eval 11/11 (3 live replies + 8 adversarial), strategy-eval 4/4; real-Claude agent scenarios 7/7
  (no Places key) and 7/7 (discovery fixture); real-Claude two-chat journey on rehearsal vendors 17/18 (row 14 PARTIAL:
  ambiguous same-date deals are compared, never confused). Visual: board/approval/paid at 760 light, 400 dark.
- Deploy (needs approval): set HAGGLE_BUILD_SHA=<sha>; clean worktree of release/rc1 → `mcp-use deploy`; then
  live-readonly.mjs + agent-scenarios.mjs (dry-run) on the hosted server. Rollback: previous deployment 99a000c6 (70f003e).
- After deploy (separate approval): one fresh rehearsal (exact one-sentence request; contacts the 3 demo vendors), then
  one Stripe test charge only after the human approves the current quote and taps Pay.
