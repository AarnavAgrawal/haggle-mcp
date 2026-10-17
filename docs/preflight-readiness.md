# Pre-kickoff infrastructure readiness

Checked 2026-10-17 00:15–00:45 PDT (Saturday, before 10:30 AM kickoff). Infrastructure only: no
product code, no migration applied to the hosted project, no email sent, nothing deployed.

Re-run any time: `corepack pnpm --filter @haggle/spikes preflight [env|primitive|anthropic|supabase]`
(read-only; never prints secret values; exits 1 on any BLOCKED).

## Status

| Dependency | Status | Evidence / what's left |
|---|---|---|
| Event eligibility | **BLOCKED until 10:30 AM** | No published pre-event code rule; product work (tools, email orchestration, parsing, negotiation, payment, UI) waits for kickoff |
| Local toolchain (Node 24.21, pnpm 10.34.7 via corepack, Docker 29.5) | PASS | `node -v`, `docker info` |
| Root scripts (`corepack pnpm test` etc.) | PASS (fixed) | root scripts called bare `pnpm`, which isn't on PATH; now `corepack pnpm -r …` |
| Typecheck (core, mcp, spikes) | PASS | clean |
| Tests | PASS | 40/40 (`packages/core`, 4 files) |
| MCP scaffold build + prod start | PASS | `mcp-use build`; `PORT=… mcp-use start` serves `/health` → `{"ok":true,"mode":"mock"}` and `tools/list` over HTTP |
| `@haggle/core` in the server bundle | PASS | probe build inlined core from workspace source; only `zod`/`mcp-use` stay external |
| Migrations on throwaway Postgres 17 | PASS | `scripts/verify-migrations.sh`: all assertions passed |
| Migration security posture | PASS (reviewed) | 14 tables, RLS enabled **and forced**, no policies, `revoke all` from anon/authenticated, `haggle_append_event` not executable by them, audit log append-only trigger |
| `.env` | ACTION REQUIRED | created from template, `chmod 600`, git-ignored; values not yet filled |
| Primitive key, inbox domain, outbound/reply-only, x402 | ACTION REQUIRED | run `preflight primitive` after filling `.env` |
| Anthropic key | ACTION REQUIRED | run `preflight anthropic` (one max_tokens=1 Haiku call) |
| Supabase project connectivity | ACTION REQUIRED | run `preflight supabase` (read-only session via Dockerized psql) |
| Manufact CLI | PASS (available) / ACTION REQUIRED (auth) | `mcp-use` 2.10 CLI in `apps/mcp`; `whoami` → not logged in |
| Git remote / shared repo | ACTION REQUIRED | no remote configured; partner has no access yet; Manufact's default deploy mode is GitHub |
| Person 2 directories | PASS | `apps/sellers`, `sell-cli`, `wall`, `raw-email-mcp` absent and untouched |
| Secrets in history | PASS | no `.env` tracked; no `prim_…`/`sk-ant-…`/JWT strings in tracked files |

## What the checks will tell us (and why)

- **Primitive** (`/whoami`, `/account`, `/domains`, `/inbox/status`, `/outbound/status`,
  `/send-permissions`, `/endpoints`, `/credits/balance`, `/x402/spend-policy`; all GET): key
  validity, that `HAGGLE_INBOX_DOMAIN` belongs to this org, whether the org is **reply-only**
  (new accounts can't email unknown recipients → RFQs fail `recipient_not_allowed`), and whether
  x402 spend policy is readable (entitlement is invite-only). The configured webhook secret is
  compared to the org's by SHA-256; neither value is printed.
- **Supabase**: that `SUPABASE_DB_URL` and `SUPABASE_URL` refer to the same project ref, server
  version, existing public tables / tables without RLS, applied migrations, and that the
  connecting role has **BYPASSRLS**. That last one matters: every Haggle table forces RLS with no
  policies, so a role without BYPASSRLS would read and write nothing.
- **Anthropic**: the extraction model (`ANTHROPIC_MODEL`, default `claude-sonnet-5-5`) is
  visible to the key, plus one minimal Haiku request.

## Manufact deployment configuration (prepared, not deployed)

- Deploy from GitHub with the monorepo root dir: `mcp-use deploy --root-dir apps/mcp --branch yash/<branch>`.
  Non-production branches get a preview URL; copy it from the dashboard instead of guessing it.
- The build needs `packages/core` source (it is bundled at build time). The docs don't say whether
  the cloud install runs at the repo root. If the first build can't resolve `@haggle/core`, set
  `--build-command "cd ../.. && corepack pnpm install --frozen-lockfile && corepack pnpm --filter @haggle/mcp build"`.
  **Unverified until the first deploy.**
- pnpm version comes from the root `packageManager` (`pnpm@10.34.7`). The docs don't cover how the
  Node version is chosen; mcp-use needs ≥ 22.22.2, so check the first build log.
- Runtime env vars go through `mcp-use servers env set <server> KEY=VALUE` (values are never
  listed back) and need a redeploy to apply. `--no-github` uploads exclude `.env*`.
- The server binds `$PORT` (verified locally). `/health` exists; `POST /inbound` is added at kickoff.
- The link file lives under `.mcp-use/` (git-ignored), so each machine links separately.

## At kickoff (10:30 AM), in order

```bash
cd ~/Desktop/haggle
git status -sb                                             # clean, on yash/buyer-foundation
corepack pnpm --filter @haggle/spikes preflight            # all PASS except known BLOCKED items
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
scripts/verify-migrations.sh                               # local DB invariants
git switch -c yash/pass2-email-transport                   # start Pass 2 milestone 3
# when the repository layer is ready, apply the migration to the hosted project:
#   docker run --rm -i -e PGURL postgres:17-alpine sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1' \
#     < supabase/migrations/20261016000000_buyer_core.sql      (PGURL from .env)
# controlled real email round trip (only to an inbox you own):
#   SPIKE_TO=<your inbox> SPIKE_CONFIRM_RECIPIENT_IS_MINE=yes corepack pnpm --filter @haggle/spikes primitive-roundtrip
```

## Still needed from the team

1. Fill in `.env` and run `preflight`.
2. `cd apps/mcp && ./node_modules/.bin/mcp-use login` (interactive).
3. Create a private GitHub repo, add the partner, `git remote add origin …`, push `main` + `yash/*`.
4. Primitive: request an outbound upgrade if reply-only, and x402 + interactions entitlements.
5. Base Sepolia buyer wallet + test USDC → `HAGGLE_PAYER_PRIVATE_KEY` (testnet only).
