# Pre-kickoff infrastructure readiness

Checked 2026-10-17 00:15–00:55 PDT (Saturday, before 10:30 AM kickoff). Infrastructure only: no
product code, no migration applied to the hosted project, no email sent, nothing deployed.

Re-run any time: `corepack pnpm --filter @haggle/spikes preflight [env|primitive|anthropic|supabase]`
(read-only, no billable calls; never prints secret values; exits 1 on any BLOCKED).

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
| `.env` | PASS | `chmod 600`, git-ignored, all required keys set, `HAGGLE_MODE=mock`. Fixed in place: `SUPABASE_URL` ref typo (19-char ref didn't resolve), raw `@` in DB password → `%40` (backup `.env.bak`, also ignored) |
| Primitive API key | PASS | `/whoami` 200, org `ae53e147…`, plan `developer` |
| Buyer domain `brave-dog.primitive.email` | PASS | in `/domains`, verified, DNS healthy; `managed_inbox_address` |
| Send From `buyer@brave-dog.primitive.email` | PASS (non-sending) | `/outbound/status`: `ready`, domain `sendable`; `send_mail` entitlement present. `/send-mail` itself remains the final authority |
| Outbound recipient scope | **Restricted** (no `any_recipient`) | allowed: Primitive-managed zones (`*.primitive.email`, `*.email.works`, …), opted-in domains, org domains, org member emails, addresses that have emailed us. Arbitrary external seller addresses fail until they write first or the org is upgraded |
| Inbound processing | ACTION REQUIRED at deploy | `/inbox/status`: receiving ready, **no webhook endpoint** (`/endpoints` = []); create it pointing at the deployed `POST /inbound`, then set `PRIMITIVE_WEBHOOK_ENDPOINT_ID`. Org allows 1 webhook |
| Webhook secret | PASS | configured value equals org secret (SHA-256 compare) |
| `interactions_enabled` | PASS | in `/account` entitlements |
| x402 payer (`x402_payments`) | **BLOCKED** | `/x402/spend-policy` → 403 `feature_disabled`, invite-only: https://docs.primitive.dev/docs/collecting-payments#requesting-access |
| Payer private key | PASS (format) | `0x` + 64 hex, user-confirmed; no signing performed |
| Anthropic | **BLOCKED** | Models API → 400: key isn't scoped to a workspace; requests need `anthropic-workspace-id`. Set `ANTHROPIC_WORKSPACE_ID` (Console → Workspaces) or use a workspace-scoped key. Extraction code at kickoff must send the same header |
| Supabase project `behfuaxftitnzkkbnaia` | PASS | read-only session via session pooler; Postgres 17.11; `postgres` role BYPASSRLS; public schema empty, no migrations applied, extensions include pgcrypto |
| Supabase `sb_secret_` key | PASS | `GET /rest/v1/` → 200 (bad-key control → 401) |
| Manufact CLI | PASS | `mcp-use whoami` → logged in (Yashnil Mohanty's Projects); nothing deployed |
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

1. Set `ANTHROPIC_WORKSPACE_ID` in `.env`, then `preflight anthropic`.
2. Request x402 access from Primitive.
3. Create a private GitHub repo, add the partner, `git remote add origin …`, push `main` + `yash/*`.
4. Agree with the partner that demo seller inboxes live on Primitive-managed domains (in scope today); real external sellers need them to email first or an outbound upgrade.
5. Fund the buyer wallet with Base Sepolia test USDC (not checked).
