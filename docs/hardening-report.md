# Hardening report: production hardening items 1-8 (2026-10-25)

Branch `aarnav-hardening`, cut from `aarnav-prod` (`a3f634e`). `main` and `aarnav-prod` are untouched. Nothing is pushed or deployed. No migration has been applied to any non-throwaway database. No real email, text, call, payment or cloud API call was made. Plan: `.claude/PRPs/plans/production-hardening.plan.md`. Each phase was built in an isolated worktree, cherry-picked here, reviewed by a multi-agent security and correctness review (findings adversarially verified), and the review's findings were fixed.

## 1. Summary

All eight items are done in code and verified locally (simulated providers, in-memory store, throwaway Postgres 17, local Supabase in Docker). Two operator steps stand between this branch and production: apply migrations **124** and **202**, then redeploy the MCP server and the web app together (§4). No verified CRITICAL or HIGH finding is open.

## 2. Per phase

| # | Item | Commits | Status |
| --- | --- | --- | --- |
| P1 | Windows-only test failures (19 ops-script tests) | `d22aae6`, `6e90472` | Done. Tests spawn `tsx` through `node`, repo roots use `fileURLToPath`, fixtures are path-agnostic, POSIX mode-bit checks are skipped on win32, CRLF is normalized. The full suite passes on Windows |
| P2 | `call_back` hardening | `fb8369c` | The code already required the web owner or the approver's `CALL <code>` (`2adea66`, `e42d1b8`). The tool description and docs now say so, and stale "board/form authorization" and "shared web rate bucket" claims are removed |
| P3 | Brain tenancy | `8e4e2c5`, `c7a5690`, `82b6101` | Done. `brain_profiles` keyed by `(workspace_id, business_id)` (migration 202). Every MCP tool gets its workspace's brain (`forWorkspace`), and the engine learns per workspace (`brainFor`). Pre-202 profiles are parked in the reserved `ws_legacy_pooled`, which no workspace can be created as or read. `/ready` reports `checks.brain`. Live servers no longer learn from simulated demo vendors (`dropSimulated`) |
| P4 | Views for manual payment handoff | `76e9ef8`, `81c46dd` | Done. The deal board and approval card show the booking and handoff stages. Vendor payment instructions are plain untrusted text with a link warning. There is no Pay button on the manual rail. The view polls every 30 s while it waits for the vendor's receipt and stops once payment is verified. Screenshots: `docs/screenshots/*manual*` (light/dark, inline/fullscreen) |
| P5 | Durable, shared rate limits | `4d7f50a`, `4cbd8d9` | Done. `take_rate_slot()` (migration 124: SECURITY DEFINER, `search_path = ''`, validated input, execute for `service_role` only) backs the web limits for chat, approval, vendor and account, plus the MCP's 25 vendor additions per workspace per day. The AI daily budget is rehydrated from `ai_usage_events` every 60 s. If the database can't answer, each instance falls back to its own memory count. The chat takes the per-user limit before the site-wide cap |
| P6 | Legacy Primitive/x402 removal | `b603ff6`, `c7932b9` | Done. The Primitive email/webhook code and the x402 rail are deleted, as are `@primitivedotdev/sdk`, `viem` and `tar`. Shared types moved to neutral modules under the same export names. A business's payment request is still flagged `external_payment_link` and never acted on |
| P7 | CSP nonces + Playwright | `72a6a03`, `8d8506f`, `45ae8ff` | Done. Each request gets a CSP nonce with `'strict-dynamic'`, so there is no `'unsafe-inline'` for scripts (styles keep it). The pages render dynamically. Tier 1 (offline public pages + zero CSP violations) runs in CI as `web-e2e`. Tier 2 (`node apps/web/e2e/tier2.ts`: local Supabase + fake Anthropic + mock MCP; guest -> chat -> deal -> approve $5 -> pay $5) passes locally. Tier 2 found a real race, workspace provisioning on two concurrent first requests, now fixed (`8d8506f`, tightened in `b16d04a`) |
| P8 | Docs | this commit | `CHECKLIST.md`, production-readiness Pass 6, this report |

## 3. Verification (final tree `82b6101`, Windows 11, Node 22)

| Check | Result |
| --- | --- |
| `npm ci`, `npm run typecheck`, MCP build | OK |
| `npx vitest run` (full suite, clean worktree with no `.env`) | 207 files passed / 6 skipped; 1,889 tests passed / 35 skipped; 0 failed (run twice independently) |
| `scripts/test-postgres.sh` (PG17) | engine 1,082 passed / 3 skipped; apps/mcp Postgres 6 passed / 2 skipped |
| `scripts/verify-migrations.sh` | OK, including a new upgrade-path step: 200-201 + existing rows -> 202 -> re-run, rows stay parked |
| `scripts/migration-compat.sh` | OK: live path and 21 checkpoints (run from a `subst` drive, see §5) |
| Secret scan | clean |
| Playwright tier 1 / tier 2 | 9 passed / passed |
| Multi-agent review | 5 areas x (security + correctness). Every CRITICAL/HIGH finding adversarially verified; none survived as CRITICAL/HIGH. 6 MEDIUM/LOW fixed (`4cbd8d9`..`82b6101`), then re-reviewed by a fresh security reviewer: no CRITICAL/HIGH. Its one MEDIUM: a database that ran the earlier 202 draft keeps pooled rows under `ws_default`. That draft never left this unpushed branch and was applied only to throwaway databases; `docs/deployment.md` documents the case |

**Not verified:**
- Any real provider: Inkbox, Stripe, Anthropic, Supabase cloud.
- A hosted Supabase with forced RLS. `take_rate_slot` relies on its owner bypassing RLS, like the other engine tables. If it doesn't, the apps fall back to memory counts and log `rate_limit_fallback`.
- The views inside ChatGPT or Claude (Inspector and screenshots only).
- Tier 2 on a Postgres-backed mock: deal pages reached "Final" slowly and needed reloads. Not investigated.

## 4. Operator steps to ship

1. Merge `aarnav-hardening` into `aarnav-prod` after review.
2. On each database, apply and record `124_engine_rate_limits.sql` (engine ledger) and `202_brain_tenancy.sql` (brain; outside the ledger). Commands and rollback notes are in `docs/deployment.md` §4 and `docs/production-deploy.md` §3.2.
   - **202 must be applied before the new MCP build.** Until it is, `/ready` reports `checks.brain: schema_missing`.
3. Redeploy the MCP server and the web app together. Don't run old and new MCP builds side by side after 202 (`docs/deployment.md`, 202 row).
4. Single-tenant deployments only: optionally hand the pooled pre-202 profiles to their workspace (one UPDATE, `docs/production-deploy.md` §12).
5. Check `GET /ready`: `checks.brain: ok`. Check that the logs show no `rate_limit_fallback`.

## 5. Needs a decision

- **Demo vendors no longer teach a live brain.** On live servers with `HAGGLE_DEMO_VENDORS`, replies from simulated demo vendors are dropped before learning. Mock mode is unchanged.
- **Accepted limiter trade-offs** (documented in `docs/web-app.md` and `docs/production-deploy.md` §12):
  - During a database outage, limits multiply by the instance count.
  - Re-authorizing a vendor takes no daily slot.
  - A vendor slot isn't refunded if the insert fails.
  - Each replica reads the day's `ai_usage_events` every minute.
- **`/_global-error` has no nonce.** Next 16 always prerenders it into the last-resort `500.html`, so its scripts are blocked by the CSP. Its message and "Home" link still work (`docs/web-app.md`).
- **Local `apps/mcp/.env` breaks the local e2e tests.** Your local `apps/mcp/.env` sets `HAGGLE_ENV=production`, and `mcp-use start` loads it over the shell env. The mock server then refuses to start, so 15 e2e files fail in the main checkout. Run the suite in a worktree without `.env` (as CI does) or rename it while testing. The file was not read or changed.
- **`scripts/migration-compat.sh` breaks on paths with spaces** (`for f in $(engine_files)`). Pre-existing, and not fixed here. Workaround: `subst` a drive letter.
- **Line endings.** `apps/*/mcp-env.d.ts` show as modified after a build, with line-ending changes only. A `.gitattributes` renormalize would stop that; not done here.
- **Low, not fixed:**
  - Legacy x402 rows in old databases are orphaned (nothing reads them).
  - The approval card is a static snapshot (the deal board polls).
  - Contact learning uses a per-render job cache, not a batched read; a batch would need a new repository method.
  - `ws_default`'s brain adapter is the root. Contacts it registers (name, email, phone for an engine business id) are a read-only fallback for other workspaces that already hold that id. That's harmless while `ws_default` is the shared demo or operator workspace, but not if it becomes a real tenant.
  - The engine's `insertWorkspace` and the `workspaces` table don't refuse `ws_legacy_pooled`; only direct SQL could create it. It would fail closed, because the brain refuses that id. A check constraint in a later migration would close it.
  - A brain outage makes `/ready` false for the whole server, even though deals keep working. That's intentional, but it matters if `/ready` gates traffic.
