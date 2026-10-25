# Plan: Production hardening, items 1–8

## Summary
Eight production-hardening items for Haggle, to run unattended on a branch off `aarnav-prod`:
1. Keep each workspace's learned business data separate.
2. Make the rate limits shared across processes.
3. Remove the legacy Primitive/x402 code.
4. Bring the `call_back` docs in line with the code.
5. Make the test suite green on Windows.
6. Refresh `CHECKLIST.md`.
7. Show the manual-payment and booking states in the MCP App views.
8. Add a nonce-based CSP and Playwright browser tests for the web app.

Everything is local: no push, no deploy, no live migration, no real email, call, text or charge.

## User story
As the Haggle founder taking the product to a multi-customer production pilot, I want the known production gaps closed and verified locally, so that the next deploy is safe for more than one customer and the docs say what is true.

## Problem → solution
Today:
- Learned business profiles are shared across workspaces.
- Web and some MCP limits live in process memory.
- Dead Primitive/x402 code still ships in `packages/engine`.
- Docs claim `call_back` still trusts board/form authorization (it doesn't).
- About 18 tests fail on Windows.
- The MCP views don't render the manual payment handoff.
- The web CSP allows `'unsafe-inline'` scripts and has no browser tests.

After this plan:
- Profiles are workspace-scoped.
- Limits are durable and shared across processes.
- The legacy code is gone, or reduced to a documented minimum.
- The docs are accurate and the suite is green on Windows.
- The views show the handoff.
- The CSP is nonce-based and checked in a real browser.

## Metadata
- **Complexity:** XL (8 independent sub-projects). Execute in the phase order below, with one commit or more per phase.
- **Source PRD:** N/A. Sources: `docs/production-deploy.md` §12, `docs/production-readiness.md`, `docs/aarnav-handoff.md`, `CHECKLIST.md`.
- **Baseline:** `aarnav-prod` @ `a3f634e`.
- **Estimated files:** about 60–90.
- **Line numbers** below were taken at `a3f634e`. They are pointers, not guarantees: re-read the code around them before editing.

---

## 0. Ground rules for the executing agent (read first)

1. **Read `CLAUDE.md` (root), `apps/mcp/CLAUDE.md` and `packages/engine/CLAUDE.md` first.** Root `CLAUDE.md` wins on conflicts.
2. **Branch:** `git switch -c aarnav-hardening aarnav-prod`. Commit after each phase, using the message style of `git log` (a summary line, then a body of what changed and how it was verified). End every commit body with `Co-Authored-By: Claude <noreply@anthropic.com>`.
3. **Never:**
   - `git push`
   - `mcp-use deploy`
   - apply a migration to any non-throwaway database
   - call Inkbox, Stripe, Anthropic, Google or Supabase cloud
   - print or commit a secret
   - edit `.env` / `.env.local` files

   Unit tests make no real external calls (CLAUDE.md §4 rule 4).
4. **`packages/core` stays unchanged.** Every item below is designed to need no change to `packages/core/*`. If you find you need one, stop that item, write it down under "Needs a decision" in the final report and move on.
5. **Tests first** (CLAUDE.md §4 rule 4). For each behaviour change, write or extend a test and see it fail before you fix it.
6. **Stop conditions.** Stop a phase, revert its uncommitted work (`git stash` or `git checkout -- <files>`, never `reset --hard` over committed work), record why in the final report and continue with the next phase if:
   - the phase breaks more than 10 unrelated tests and you can't see why within about 30 minutes, or
   - it needs an external account, or
   - it needs a `packages/core` change.
7. **Docker.** `scripts/test-postgres.sh`, `scripts/verify-migrations.sh` and the local Supabase stack (Phase 7b) need Docker Desktop running. Check with `docker version`. If the daemon isn't running, skip those commands and say so in the report. **Never claim a Postgres run you didn't do.**
8. **Shell.** This is Windows 11 with Git Bash. Run `.sh` scripts with `bash scripts/<name>.sh`. Paths contain spaces (`Aarnav Agrawal`, `Coding Files`): quote them.
9. **Timing.** The full `npx vitest run` takes about 6 minutes here. Use a 600000 ms timeout, or `run_in_background`.

### Phase order (risk-ascending; each phase independent unless noted)

| Phase | Item | Why this order |
|---|---|---|
| P0 | Setup and baseline | Need a trustworthy red/green signal |
| P1 | 5: Windows test failures | Makes the suite a clean signal for everything after |
| P2 | 4: `call_back` docs | Tiny; the code is already correct |
| P3 | 1: brain tenancy | Highest product value |
| P4 | 7: views for manual handoff | apps/mcp-local, no core change |
| P5 | 2: durable limits | New migration + async limiter |
| P6 | 3: legacy Primitive/x402 removal | Wide, mechanical; 6b is optional |
| P7 | 8: CSP nonces (7a), then Playwright (7b) | 7b may be blocked by Docker |
| P8 | 6: `CHECKLIST.md` + docs + final report | Last, so it records what actually happened |

---

## Validation commands (used throughout)

```bash
# from the repo root, Git Bash
npm run typecheck                      # EXPECT: zero errors
npm run build -w @haggle/mcp           # needed before any apps/mcp/tests/*.e2e* and apps/web/tests/approval.e2e.test.ts
npx vitest run <path or dir>           # targeted tests
npx vitest run                         # full suite (~6 min)
bash scripts/verify-migrations.sh      # Docker: every migration applies, SQL assertions, re-runnable files re-run, isolation
bash scripts/migration-compat.sh       # Docker: upgrade path, applies 2xx brain files at every engine checkpoint
bash scripts/test-postgres.sh          # Docker: engine suite + apps/mcp/tests/*.pg.test.ts on Postgres 17
node apps/mcp/scripts/env-manifest.ts --check docs/env-manifest.md   # if you add an env var
node apps/mcp/scripts/secret-scan.ts   # before each commit that touches docs
npm run build                          # P7: includes `next build` of apps/web
```

---

## P0: Setup and baseline

1. `git switch -c aarnav-hardening aarnav-prod`.
2. `git status`: only `apps/bench/mcp-env.d.ts` may show as modified (a line-ending-only change). Leave it unstaged.
3. `npm run build -w @haggle/mcp`. About 15 e2e test files fail with "server did not start (run mcp-use build first)" without this.
4. `docker version`, and record whether the daemon is up.
5. Run `npx vitest run` and save the failing test list to the scratchpad. **Expected baseline:** after the build, about 18 deterministic Windows failures (see P1), plus a few load timeouts that pass in isolation (`scriptsPlainNode`, `releaseStaging` "real CLI", `channels`, `approvalLifecycle`, `evalCorpus`, the `release.test.ts` beforeAll).

---

## P1 (item 5): make the suite green on Windows

There are 18 deterministic failures, with 5 root causes. Re-run the failing files on their own with `npx vitest run <files> --maxWorkers=2` to confirm them.

| Root cause | Tests | Code | Fix |
|---|---|---|---|
| **R1** `spawnSync` of `node_modules/.bin/tsx` fails with ENOENT on Windows (status `null`) | `apps/mcp/tests/config.test.ts:115,122` (helper `:111`); `apps/mcp/tests/scriptsDbGuard.test.ts:105,112,126` (helper `:99-100`, `TSX` const `:14`) | test helpers | `const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")`, then `spawnSync(process.execPath, [TSX_CLI, script, ...args], …)`. Raise the helper timeout from 30 s to 60 s (tsx start-up takes up to ~23 s here) |
| **R2** The repo root comes from `new URL("../../..", import.meta.url).pathname`, which gives `/C:/…%20…` on Windows and also breaks on POSIX paths with spaces | `scriptsPlainNode.test.ts:26` (secret-scan); `scriptsDbGuard.test.ts:126` (launch-gate, hidden behind R1) | `apps/mcp/scripts/secret-scan.ts:56`, `launch-gate.ts:235`, `migrations.ts:82`, `pilot-preflight.ts:206`, `staging-release.ts:331` | Use `fileURLToPath(new URL("../../..", import.meta.url))`, the pattern already in `apps/mcp/scripts/email-trial.ts:44`. **This is a real bug fix, not a test fix** |
| **R3** POSIX path literals in pure-function tests, while the code uses `path.resolve`/`join` | `emailTrial.test.ts:36`, `emailTrialModes.test.ts:53`, `emailTrialHardening.test.ts:69,75,83`, `releaseStaging.test.ts:130,164,203` | `apps/mcp/scripts/email-trial-lib.ts:111,155-172,238,294`; `staging-release.ts:211,216,226,268,274` | In the lib, change `${runDir}/run.json` (`:238`, `:294`) to `join(runDir, "run.json")`. In the tests, build expectations with `resolve(...)`, key fake-fs maps on `resolve(p)`, use `base = (p) => p.split(/[\\/]/).pop()` and `/[\\/]mcp-use$/`, and use `[\\/]` in path regexes |
| **R4** POSIX mode bits: `statSync().mode & 0o777` is `0o666` on Windows | `emailTrialHardening.test.ts:192,241,264` (helper `:182`) | `apps/mcp/scripts/email-trial-io.ts:26-31` (`chmodSync`) | Guard **only the mode assertions** with `if (process.platform !== "win32")`; the rest of each test still runs. Add a one-line note to `docs/email-trial-checklist.md` that the trial tool is POSIX-only for permission checks |
| **R5** CRLF checkout (`core.autocrlf=true`, no `.gitattributes`) | `apps/mcp/tests/envManifest.test.ts:69-71` | test | `readFileSync(...).replace(/\r\n/g, "\n")` at `:69`. **Do not** add a repo-wide `.gitattributes` / renormalize; that creates a huge diff and is the user's call. Mention it in the report |

Also add timeout hardening for the load flakes: give the spawn-heavy tests explicit timeouts, e.g. `it(name, fn, 90_000)` in `apps/mcp/tests/scriptsPlainNode.test.ts:14,23` and the `releaseStaging` "real CLI" cases.

**GOTCHA:** `staging-release.ts:274` executes `.bin/mcp-use` directly (the same shim problem as R1). It runs only on POSIX operator hosts, so leave the code and note it in the report.

**VALIDATE:**
- `npx vitest run apps/mcp/tests` gives 0 deterministic failures.
- The full run gives 0 failures, or only load timeouts that pass in isolation. List any that remain.

**Commit:** `Tests portable on Windows: tsx via node, fileURLToPath repo roots, path-agnostic fixtures, POSIX-only mode checks`

---

## P2 (item 4): `call_back` authorization is already correct; fix the docs

**Verified at `a3f634e`:**
- `apps/mcp/index.ts:947`: `if (engine.callbacksNeedApproverText)`. In live mode (or mock with `HAGGLE_APPROVALS=out_of_band`) the tool only texts the approver a one-time code and returns `pending_human`. No form, board tap or model call places a real call.
- `WorkspaceEngine.placeCallback` (`packages/engine/src/workflow/engine.ts:7610-7612`) throws `callback_needs_approver_text` in that mode.
- `call_back_in_view` refuses with `callback_not_authorized` (`index.ts:993`).

All of this is covered by `packages/engine/tests/security.test.ts:90-235` and `apps/mcp/tests/security.tenancy.e2e.test.ts:133-170`.

**Do NOT add a gate to `HaggleEngine.placeCallback`** (`engine.ts:3427`). The web route (`authorizeCallbackByWeb`), the operator path and the `CALL <code>` text all go through it, and `packages/engine/tests/channels.test.ts:264-417` would break.

**Tasks:**
1. **Description.** Update the `call_back` tool description (`apps/mcp/index.ts:927-929`) to mention the second live human path: the signed-in owner can authorize in the Haggle web app (`/internal/callbacks/authorize`). Keep the description short, matching the surrounding style.
2. **Docs.** Fix the stale claims:
   - `docs/production-readiness.md:62` and `:125` ("`call_back` still accepts the board or form authorization"). Change them to resolved, citing commits `2adea66` and `e42d1b8` and the tests above.
   - `docs/production-deploy.md:346` and `docs/web-app.md:205-206` ("all web traffic shares one MCP rate-limit bucket"). Already false: `apps/mcp/src/limits.ts:111-116` keys service-token traffic as `service-token + "\n" + x-haggle-workspace`, tested at `apps/mcp/tests/limits.test.ts:12-20`.
3. **Test.** Add one regression test to `apps/mcp/tests/limits.test.ts`, if it doesn't already exist: two different `x-haggle-workspace` values with the same service token produce different `credentialKey`s. Check `:12-20` first; if it already asserts this, skip.

**VALIDATE:** `npx vitest run apps/mcp/tests/limits.test.ts packages/engine/tests/security.test.ts`; then the secret scan.

**Commit:** `call_back: document the web-owner path; docs no longer claim board/form authorization or a shared web rate bucket`

---

## P3 (item 1): keep each workspace's learned business data separate (brain tenancy)

### What exists
- **Table.** `brain_profiles` (`supabase/migrations/200_brain_profiles.sql:5-18`):
  - columns `business_id text primary key`, `name`, `category`, `area`, `profile jsonb`, `updated_at`
  - index `(category, area)`
  - RLS enabled and forced, no policies
  - grants in `201_brain_profiles_grants.sql:26-27`: revoke anon/authenticated, grant service_role
- **Stores.** `packages/brain/src/store.ts`:
  ```ts
  export interface ProfileStore {            // :11-15
    get(businessId: string): Promise<Profile | null>;
    list(): Promise<Profile[]>;
    put(profile: Profile): Promise<void>;
  }
  ```
  - `MemoryStore` (`:17-29`, a `Map<business_id, Profile>`)
  - `FileStore` (`:31-74`, `{profiles:[...]}`, atomic tmp+rename write at `:62-73`)
  - `SupabaseStore` (`:78-113`, supabase-js/PostgREST; `.eq("business_id", id).maybeSingle()` at `:90`, `list` selects everything at `:95`, upsert with no `onConflict` at `:103-110`, schema from `HAGGLE_DB_SCHEMA`)
  - `storeFromEnv` (`:115-121`)
- **`createBrain`** (`packages/brain/src/brain.ts:48-288`):
  - `withLock` is keyed by businessId (`:55-62`); `learnFromReply` is `:61-67`.
  - Seeding when the store is empty: `:69-86`. Mock only: `makeBrain` sets `seed: !observed`.
  - `getProfile` falls back to a name scan over `list()` (`:93-99`).
  - `estimate` (`:101-141`), `checkPrice` (`:143-204`, samples **all** profiles in the category) and `discover` (`:253-285`) all read `store.list()`.
- **Engine.**
  - It always knows the workspace: `JobRow.workspace_id` (`packages/engine/src/store/types.ts:38`), `DEFAULT_WORKSPACE_ID = "ws_default"` (`:15`).
  - Brain call sites in `packages/engine/src/workflow/engine.ts`:
    - learn: `:5473-5491` (with `job` in scope)
    - board price check: `:6069`
    - track record: `:763-764`
    - `ask` / `checkPrice` / `discover`: `:7139-7148`
    - `WorkspaceEngine` passthroughs: `:7600-7602`
    - `businessProfile(ref, workspaceId?)`: `:7189-7197`
  - Engine-internal `Brain` contract: `packages/engine/src/contract.ts:252-258`. `BrainAdapter`: `packages/engine/src/brain/adapter.ts:46-223` (`readonly core: CoreBrain` at `:48`).
- **MCP.**
  - `run()` (`apps/mcp/index.ts:148-160`) passes `brain: rt.brain`, which is process-wide.
  - Tools: `ask` (`:1107-1140`, uses `brain.core.estimate` / `brain.core.getProfile`), `check_price` (`:1254-1275`), `business_profile` (`:1277-1340`; already filters history to the workspace's own jobs via `historyOnly`, `apps/mcp/src/brain.ts:38-66`).
  - Brain construction: mock in `apps/mcp/src/runtime.ts:92` (memory or file, seeded), live in `apps/mcp/src/live.ts:86` (`observed: true`, Supabase, seeds stripped by `observedStore`, `apps/mcp/src/brain.ts:69-75`).
- **Simulated/heuristic learning is already gated:**
  ```ts
  // packages/engine/src/workflow/engine.ts:5476
  const teaches = msg.sender_trusted === true && !heuristicReading(record) && !(job.mode === "live" && msg.simulated);
  ```
  It's tested in `packages/engine/tests/security.test.ts:554-574`. Mock brains are memory/file-only and never Supabase, so mock simulated replies can't reach a live store. Mock **must keep** learning from simulated replies: the warm `ask` demo depends on it (root CLAUDE.md §9, "never cut: learning with ask").

### Design (no `packages/core` change)
Scope by **instance**, not by argument.
- `docs/aarnav-handoff.md` §1 proposed adding `workspaceId` to every core `Brain` method. That's a core contract change needing both founders, so don't do it.
- Instead, a workspace gets its own brain instance over a workspace-scoped store view. The core `Brain` interface is untouched.

1. **Store scoping (`packages/brain/src/store.ts`).** Add `forWorkspace(workspaceId: string): ProfileStore` to each store (new optional method on the interface, `forWorkspace?(ws): ProfileStore`):
   - **Memory:** a nested `Map<ws, Map<business_id, Profile>>`. The unscoped methods act on `ws_default`.
   - **File:** keep the file format `{profiles:[...]}` and add `workspace_id` to each entry. Entries without one are read as `ws_default` (backward compatible with existing files). A put replaces the matching `(workspace_id, business_id)` entry.
   - **Supabase:** `get`/`list` add `.eq("workspace_id", ws)`; `put` sends `workspace_id: ws` and uses `{ onConflict: "workspace_id,business_id" }`.
   - The unscoped `ProfileStore` methods keep working as `ws_default` views, so every existing caller and test still compiles.
2. **Brain factory (`packages/brain/src/brain.ts`).** Export `createWorkspaceBrains(opts) → { forWorkspace(ws): Brain }`:
   - Caches one `createBrain({ ...opts, store: store.forWorkspace(ws) })` per workspace, bounded (e.g. an LRU of 500, or a plain Map; workspaces are few).
   - Seeding stays mock-only and runs per workspace on first use.
   - `withLock` stays per instance, so it is now effectively keyed by workspace and business.
3. **Engine brain port.**
   - In `packages/engine/src/contract.ts`, add an optional `forWorkspace?(workspaceId: string): Brain` to the engine-internal `Brain` interface. This is engine-internal, not `packages/core`.
   - In `HaggleEngine`, add `private brainFor(ws: string) { return this.d.brain.forWorkspace?.(ws) ?? this.d.brain; }`.
   - Use `brainFor(job.workspace_id)` at the learn call (`:5473-5491`), the board price check (`:6069`) and the track record (`:763-764`).
   - Make `ask` / `checkPrice` / `discover` (`:7139-7148`) take an optional `workspaceId`, and have `WorkspaceEngine` (`:7600-7602`) pass `this.workspaceId`.
   - `businessProfile(ref, workspaceId?)` (`:7189-7197`) uses `brainFor(workspaceId ?? DEFAULT_WORKSPACE_ID)`.
   - Update the engine `StubBrain` (`packages/engine/src/brain/stubBrain.ts`) only if typecheck needs it; the method is optional.
4. **`BrainAdapter`** (`packages/engine/src/brain/adapter.ts`).
   - Constructor gains an optional `coreFor?: (ws) => CoreBrain`.
   - `forWorkspace(ws)` returns `new BrainAdapter({ ...same deps, core: coreFor(ws) })`, cached per workspace.
   - Keep `readonly core` as the `ws_default` brain, so the old API still works.
5. **MCP wiring.**
   - `makeBrain` (`apps/mcp/src/brain.ts`) builds the adapter with `coreFor` over `createWorkspaceBrains`. Live wraps each scoped store with `observedStore`.
   - In the `ask` and `business_profile` tool bodies, replace `brain.core` / `brain.coreProfile` / `brain.brainIdFor` with the workspace's adapter: `const wb = brain.forWorkspace(workspaceId)`, with `workspaceId` destructured from `run()`'s argument; `ask` doesn't destructure it today.
   - `check_price` already goes through `engine.checkPrice`, which is fixed in step 3.
6. **Defensive simulated guard.** In the observed (live) brain only, `learnFromReply` ignores `meta.simulated === true`. Pass a `dropSimulated: true` option from `makeBrain` when `observed`. Mock is unchanged.
7. **Migration** `supabase/migrations/202_brain_tenancy.sql`:
   - Add the header comment style of 200/201, and say it is safe to re-run **only if it really is**: `scripts/verify-migrations.sh:24-31` re-applies files whose first 20 lines match `safe to re-run|idempotent (re-running`.
   - `alter table public.brain_profiles add column if not exists workspace_id text not null default 'ws_default';` (the default backfills existing rows, like `103_engine_parity.sql:29-32`).
   - A check constraint `workspace_id ~ '^ws_[a-z0-9_]{3,40}$'` (the format from `103:12`), added inside a `do $$ … if not exists (select 1 from pg_constraint where conname = …) …` guard.
   - **No foreign key to `public.workspaces`:** `scripts/migration-compat.sh:56-66` applies every `2*_brain_*.sql` at engine checkpoint 100, before 103 creates `workspaces`.
   - Swap the primary key: drop `brain_profiles_pkey`, then `add primary key (workspace_id, business_id)`, guarded so it can re-run.
   - Replace the index with `(workspace_id, category, area)`.
   - The file name must match `^\d{3}_[a-z0-9_]+\.sql$` and the `2*_brain_*.sql` glob.
8. **SQL assertions.** Extend `supabase/tests/brain_profiles_assertions.sql`:
   - existing inserts still work through the default
   - the same `business_id` in two workspaces gives two rows
   - a duplicate `(workspace_id, business_id)` fails
   - anon/authenticated still have no privileges
9. **Preflight.** `apps/mcp/scripts/pilot-preflight.ts:123` currently always WARNs "brain tenancy". Change it to PASS with detail "learned profiles are scoped per workspace (202_brain_tenancy)", and update `apps/mcp/tests/pilotPreflight.test.ts:62`. The check is env-only and has no DB handle, so it can't verify the migration. Say that in the detail.
10. **Docs and comments.** Update:
    - `docs/production-readiness.md:54`
    - `docs/security-review-s5.md:59` (H5)
    - `docs/sprint-4-report.md:320`
    - `docs/production-deploy.md:351`
    - `docs/pilot-launch-checklist.md:20`
    - `docs/pilot-onboarding.md:226`
    - `docs/aarnav-handoff.md` §1–2 (mark done, describe the instance-scoping choice)
    - the comments at `engine.ts:5473-5475`, `apps/mcp/src/brain.ts:35` and `apps/mcp/index.ts:1314`
    - `docs/deployment.md`'s per-migration table: add a row for 202 (operator step: apply 202 before deploying this build)

### Tests (write first)
| Test file | Case | Expected |
|---|---|---|
| `packages/brain/tests/store.test.ts` (extend) | MemoryStore and FileStore (tmp dir): put the same business_id in `ws_alpha` and `ws_beta` with different prices | each scoped `get`/`list` sees only its own; the unscoped API equals `ws_default`; a legacy file without `workspace_id` reads as `ws_default` |
| `packages/brain/tests/brain.test.ts` (extend) | `createWorkspaceBrains`: learn a reply in A | B's `estimate`, `checkPrice`, `getProfile`, `discover` ranking show nothing from A; A's do |
| `packages/brain/tests/brain.test.ts` | observed brain with `dropSimulated` | `learnFromReply(…, {simulated:true})` leaves the profile unchanged; non-observed still learns |
| `packages/engine/tests/brainAdapter.test.ts` (extend; it already uses real `createBrain` + `MemoryStore`, `:10-13`) | Two jobs in two workspaces, trusted replies | `WorkspaceEngine` A vs B: `ask` / `checkPrice` / `businessProfile` scoped |
| `packages/engine/tests/security.test.ts:554-574` | existing learn gate | still green |
| `apps/mcp/tests/security.tenancy.e2e.test.ts` (two-workspace HTTP harness: `HAGGLE_MOCK_WORKSPACES` `ws_alpha`/`ws_beta`, bearer tokens, `:24-36`) | run a mock deal in alpha to quotes, then call `ask` and `business_profile` as beta | beta's estimate/profile has no learned history from alpha (seed samples may still appear, labelled) |
| `apps/mcp/tests/brainObserved.test.ts` | observedStore over a scoped store | seeds still stripped |

Test setup pattern to mirror:
```ts
// packages/brain/tests/brain.test.ts:5-9
const brain = createBrain({ store: new MemoryStore(), seed: true, now: () => new Date("2026-10-17T12:00:00-07:00") });
await brain.ready;
```

**GOTCHAS:**
- `SupabaseStore` can't be exercised offline (no PostgREST in the throwaway Postgres). Cover it with a unit test that injects a fake supabase client and asserts the `.eq("workspace_id", …)` / `onConflict` calls (check how `store.test.ts` builds stores), plus the SQL assertions.
- `withHeuristicFallback` / `meta.simulated` behaviour must not change for mock.
- `getProfile`'s name-scan fallback must use the scoped `list()`.

**VALIDATE:**
- `npx vitest run packages/brain packages/engine/tests/brainAdapter.test.ts packages/engine/tests/security.test.ts apps/mcp/tests/pilotPreflight.test.ts apps/mcp/tests/brainObserved.test.ts`
- `npm run build -w @haggle/mcp`, then `npx vitest run apps/mcp/tests/security.tenancy.e2e.test.ts`
- typecheck
- Docker: `bash scripts/verify-migrations.sh && bash scripts/migration-compat.sh`

**Commit:** `Brain tenancy: profiles scoped per workspace (202_brain_tenancy), workspace brains through the engine and MCP tools; preflight PASS`

---

## P4 (item 7): MCP App views render the manual payment handoff and booking stages

**No `packages/core` change is needed:**
- The deal board's `purchase` object already exists in the apps/mcp-local schema `DealBoardPlus.purchase` (`apps/mcp/src/views.ts:118-127`). Its fields: `stage`, `rail: "manual"`, `booked`, `booked_by_human?`, `money_verified`, `amount_usd`, `total_usd`, `vendor_reply?{text, untrusted:true, has_link}`, `instructions?{text, untrusted:true, has_link}`, `reported_paid_at?`, `verified_at?`, `stalled?`, `operator_attention?`, `summary`, `next`, `order?`, `must_haves?`, `confirm_only?`.
- It's filled by `fullDealBoardPlus` (`:300`) and kept by `compactBoard` (`:205`).
- The approval card's `payment` is a `z.looseObject` (`views.ts:22`), so `rail`/`reason` already pass through. `ApprovalOut.reason` is set to `"<stage>: <summary>"` under manual (`apps/mcp/index.ts:736-737`).

**Stage strings** (`packages/engine/src/payments/purchase.ts:9-12`): `awaiting_vendor_confirmation`, `order_confirmed`, `handoff_refused`, `booking_declined`, `booking_changed`, `instructions_requested`, `instructions_received`, `human_reported_paid`, `settled_verified`, `cancelled`, `cancel_requested_after_payment`.

**Wording to mirror** (web app, `apps/web/components/approval/PurchaseSteps.tsx`):
- Steps (`:14-20`): "Vendor confirms the booking in writing" / "Vendor sends how to pay" / "You pay the vendor directly" / "Vendor confirms it received the money" / "Done". The stage→step map is at `:21-23`, the stop-polling set at `:25`.
- Untrusted text box (`VendorWords`, `:32-40`): plain text, plus "This contains a link. Haggle never opens payment links; don't pay through a link you didn't expect."
- Labels:
  - `:142`: `Payment instructions from ${business}: unverified, confirm them with ${business} on a number you already know before paying`
  - `:143`: `${business}'s reply (unverified)`
  - confirm-only, `:119`: "Confirm-only order: nothing is paid through Haggle; you arrange payment with {business} under its terms."
- CSS for the untrusted box: `apps/web/components/approval/approval.css:149-172` (warning left border, `white-space: pre-wrap`, `overflow-wrap: anywhere`).

### Tasks
1. **Pure helper.** Create `apps/mcp/views/deal-board/purchase.ts`, mirroring the pure-module style of `views/deal-board/options.ts`:
   - `purchaseStep(stage) → 0..4`
   - `purchaseSettled(stage)`: true only for `settled_verified` / `cancelled`
   - `purchaseDone(stage)`
   - `STEP_LABELS`
2. **Deal board** (`apps/mcp/views/deal-board/view.tsx`).
   - Add `purchase?: …` to the `Extras` type (`:37-61`).
   - In `DealAction` (`:933-998`), `facts()` (`:293-314`) and `headline()` (`:318-347`), **branch on `board.purchase?.rail === "manual"` before** any `payment` check. Otherwise an approved manual deal shows a **Pay button** and "Nothing is charged until you tap Pay." (`:967-977`), and a verified one says "Stripe test mode" (`:949`).
   - Render the stepper, `summary`, "Next: {next}", `instructions` / `vendor_reply` as plain text in an untrusted box (**no auto-linking, no `useOpenExternal`, nothing into model context**; the model context built in `options.ts:20` must stay names/totals/ids/states only), the `has_link` warning, `booked_by_human` ("booking confirmed by you"), and `confirm_only`.
   - Next step text: "reply PAID <code> to Haggle's text, or use the Haggle web app". **Never show or ask for a code:** the engine passes `approvalCode: undefined`.
   - **There is no "I've paid" button in the MCP view.** Only the PAID/BOOKED texts or the web service routes record that.
   - **Polling:** `TERMINAL` (`:26`) includes `"paid"`. Under manual, job state `paid` means "customer reports paying", not verified (`engine.ts:1031-1033`). Keep polling while `purchase.stage === "human_reported_paid"`.
3. **`payments_enabled` is wrong under manual.** `engine.ts:6259` ignores `manualPaymentHandoff`, so the board says "Payments are off on this server…" (`view.tsx:447`, `:960`).
   - Fix it at the MCP layer: pass `extra: { payments_enabled: engine.paymentsEnabled }` where the board is built (`apps/mcp/index.ts:510`, `:586`, `:1391`; check the getter at `engine.ts:7125`).
   - Also make the view check `purchase` first.
   - Don't edit the engine's board read model for this.
4. **Approval card** (`apps/mcp/views/approval/view.tsx`).
   - Widen the local `Approval` type (`:14-20`) to `payment?: {status, simulated, rail?, reason?}`.
   - When `payment?.rail === "manual"`: show `reason` (the stage summary; today it's hidden unless pending/refused, `:230-231`), hide the Pay button and "Nothing is charged until you tap Pay." (`:242-247`, `:269`), and drop "Stripe test mode" (`:250-256`, `:263-268`).
5. **Pending wording.** When live approvals are out of band, the board shows `s.next` from `choose_in_view` (`apps/mcp/index.ts:1044-1052`): "Sent to the approver's phone: they approve by replying YES <code> to Haggle's text." When web approvals are on (`HAGGLE_WEB_APPROVALS`, default on; read via `apps/mcp/src/service/approvals.ts:19-21`), append " or approve it in the Haggle web app."
6. **Mock can't produce manual states.** `HAGGLE_PAYMENTS=manual` is wired only in live (`apps/mcp/src/live.ts:147`). Add the same opt-in to the mock engine config (`apps/mcp/src/runtime.ts:101`): `manualPaymentHandoff: env.HAGGLE_PAYMENTS === "manual"`. Add the variable to the mock column of `apps/mcp/src/envManifest.ts` if it lists per-mode vars, and run the env-manifest `--check`.
7. **Fixture** for screenshots and tests: add `fixtures/views/deal-board-manual.json`, a board with `purchase` at `instructions_received`, `instructions.has_link: true`. Validate it against `DealBoardPlus` (apps/mcp) in a new test, **not** against the core `DealBoard` in `fixtures/fixtures.test.ts` (core strips `purchase`).

### Tests
- **`apps/mcp/tests/dealBoard.test.ts`** (it already imports the deal-board fixture and tests `options.ts`):
  - `purchaseStep` for every stage
  - `purchaseSettled` false for `human_reported_paid`
  - the manual fixture parses with `DealBoardPlus`
- **Engine flow** (already covered with `manualPaymentHandoff: true` in `packages/engine/tests/purchaseFlow.test.ts`, `e2ePurchase.test.ts`, `helpers/purchaseKit.ts`): no change, keep green.
- **Screenshots** (definition of done for views, CLAUDE.md §10):
  - Start a mock server with `HAGGLE_PAYMENTS=manual HAGGLE_MODE=mock HAGGLE_SIM_DELAY_SCALE=0`, drive a deal to approval, then `npx mcp-use screenshot --server local --tool get_quotes job_id=<id> --output docs/screenshots/deal-board-manual-<state>.png`, in light and dark, 400 px wide. The pattern is in `apps/bench/scripts/screenshots.ts`.
  - If mock can't reach `instructions_received` without a vendor text, screenshot the stages it can reach and record which ones you couldn't.

**VALIDATE:** typecheck; `npx vitest run apps/mcp/tests/dealBoard.test.ts fixtures`; build; the screenshots exist and you've looked at them (Read the PNGs).

**Commit:** `Views: manual payment handoff and booking stages on the deal board and approval card (untrusted vendor text, no Pay button, polls until verified)`

---

## P5 (item 2): durable, shared rate limits

### Inventory
| # | Limiter | Where | Today | Plan |
|---|---|---|---|---|
| 1 | Web chat per user, 20 turns / 10 min sliding | `apps/web/lib/chat/limits.ts:9-30`; `app/api/chat/route.ts:42-45` | `Map<userId, number[]>` | **Durable** (fixed 10-min window is acceptable) |
| 2 | Web chat site-wide daily cap (`WEB_CHAT_DAILY_CAP`) | `limits.ts:36-51`; route `:47-49` | closure counters | **Durable**, key `"site"`, window 86400 aligned to the UTC day |
| 3 | Approval routes, 30 / 60 s per user | `apps/web/lib/approval/route.ts:27-44` (`class RateLimiter`), used `:104` | Map | **Durable** |
| 4 | Double-click joining | `approval/route.ts:46-54`, key `:121` | `Map<string, Promise>` | **Keep in memory.** Cross-instance repeats are already idempotent in the engine (`transitionApproval` CAS, outbox). Document it |
| 5 | Web vendor routes, writes 20/min, discover 10/min | `apps/web/lib/vendors/route.ts:25-27`, `:76,94,112` | `RateLimiter` | **Durable** (same limiter) |
| 6 | Web account routes, delete 3 / 10 min, export 5 / 10 min | `apps/web/lib/account/request.ts:18-33`; `app/api/account/{delete,export}/route.ts` | own `Limiter` | **Durable** (same limiter) |
| 7 | MCP vendor daily additions, 25 / workspace / UTC day | `apps/mcp/src/service/vendors.ts:15-35` (`DailyAdds`), `:75,94,128,134` | `Map<ws,{day,n}>` | **Durable** via the repository |
| 8 | AI usage meter (`HAGGLE_AI_DAILY_TOKEN_BUDGET`, `HAGGLE_AI_MAX_CALLS_PER_JOB`) | `packages/engine/src/live/aiUsage.ts:74-208`; wired `apps/mcp/src/live.ts:91-97` | in memory; `admit()` is **synchronous** | **Rehydrate** (see below); don't make `admit` async |
| 9 | Alert dedupe / rate | `packages/engine/src/live/alerts.ts:48-90` | in memory | **Keep.** Duplicate alerts across replicas are acceptable; document |
| 10 | MCP tool-call bucket | `apps/mcp/src/limits.ts:41-66,111-156` | `TokenBucket`, **already per workspace** | **Keep** (single-replica guidance stays; document) |

### Design
**One SQL primitive.** It's used by the MCP server through `postgres` and by the web app through `supabase.rpc`. Both share the same Supabase database (see `apps/web/.env.example`: "the same project as the server's SUPABASE_URL").

**Migration** `supabase/migrations/124_engine_rate_limits.sql` (the next engine number; names must match `1NN_engine_<area>.sql`, enforced by `packages/engine/src/ops/migrations.ts:47`):
```sql
create table if not exists public.rate_limit_slots (
  bucket text not null,
  key text not null,
  window_start timestamptz not null,
  n integer not null default 0,
  primary key (bucket, key, window_start)
);
create index if not exists rate_limit_slots_window_idx on public.rate_limit_slots (window_start);
-- RLS idiom used by 111/117/122:
alter table public.rate_limit_slots enable row level security;
alter table public.rate_limit_slots force row level security;
revoke all on public.rate_limit_slots from anon, authenticated;

-- Atomic take: fixed window aligned to the epoch (86400 → UTC day). Returns whether the slot was granted.
create or replace function public.take_rate_slot(p_bucket text, p_key text, p_window_s integer, p_max integer)
returns table (allowed boolean, used integer, retry_after_s integer)
language plpgsql security definer set search_path = public as $$
declare ws timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s); cur integer;
begin
  insert into rate_limit_slots(bucket, key, window_start, n) values (p_bucket, p_key, ws, 1)
  on conflict (bucket, key, window_start) do update set n = rate_limit_slots.n + 1
  where rate_limit_slots.n < p_max
  returning n into cur;
  if cur is null then
    select n into cur from rate_limit_slots where bucket = p_bucket and key = p_key and window_start = ws;
    return query select false, cur, greatest(1, ceil(extract(epoch from (ws + make_interval(secs => p_window_s) - now())))::int);
  else
    return query select true, cur, 0;
  end if;
end $$;
revoke all on function public.take_rate_slot(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.take_rate_slot(text, text, integer, integer) to service_role;
```
- Add cleanup to the existing tick housekeeping only if one exists (search `apps/mcp/src` for a periodic prune); otherwise delete rows older than 2 days inside the function at a 1% random rate.
- **Constraints:**
  - The isolation check (`scripts/verify-migrations.sh`, `ISOLATION_BASES="111 117"`) applies 124 alone on 100..117. It must not depend on 118–123 objects. It doesn't.
  - Make it re-runnable (`if not exists`, `create or replace`) and say so in the header.
  - `pg-common.sh` creates the `anon` / `authenticated` / `service_role` roles, so the grants apply.
- **SQL assertions:** `supabase/tests/engine_rate_limits_assertions.sql`. Mirror `engine_metrics_assertions.sql`: `\set ON_ERROR_STOP 1`, `pg_temp.expect_fail` helper, `has_table_privilege('anon', …)` checks, ending with `\echo '… assertions OK'`. Cover:
  - `p_max` grants, then the next call refuses with `retry_after_s > 0`
  - different keys are independent
  - anon can't execute the function
- **Ledger:** a new 1xx is "pending" for `/ready` until the operator applies it and records it (`apps/mcp/scripts/migrations.ts record`). Add a row to the per-migration table in `docs/deployment.md`.

**MCP / engine.**
- Add an optional `takeRateSlot?(bucket, key, windowS, max): Promise<{allowed:boolean; used:number; retryAfterS:number}>` to `Repository` (`packages/engine/src/store/types.ts:562-596`, the optional-method convention: "optional so a repository without it still runs").
- Implement it in `PostgresRepository` (`store/postgres.ts`; call the function with the `postgres` tagged template, mirroring `:115-123`) and in `InMemoryRepository` (`store/memory.ts`, a Map with the same window maths).
- In `apps/mcp/src/service/vendors.ts`, replace `DailyAdds` with `repo.takeRateSlot?.("vendor_adds", ws, 86400, 25)`, falling back to the existing in-memory `DailyAdds` when the method is absent.
  - **Take the slot before the insert** (today the counter increments after a successful insert at `:134`, which lets concurrent adds overshoot).
  - Keep the 429 `DAILY_LIMIT` shape and message.
  - A re-authorization of an existing vendor must not consume a slot: keep the current semantics tested at `apps/mcp/tests/serviceVendors.test.ts:134-135`, and check existence first.

**AI meter (item 8 of the inventory): rehydrate, don't make `admit()` async.**
- `admit()` is sync and has sync callers and tests (`packages/engine/tests/aiLimitsE2E.test.ts:23,65`; `snapshot()` in `apps/mcp/src/health.ts:102`, `live.ts:209`).
- Add `meter.hydrate({ totalTokens, byJob, byWorkspace })`, filled at live start-up and every 60 s from `repo.listAiUsage({ since: startOfUtcDay })`. That function exists (`postgres.ts:596`) over `ai_usage_events` (`122_engine_metrics.sql`, already written for every call via `aiUsageSink`, `live.ts:94`).
- Hydrate takes the **max** of the in-memory and DB tallies, so a restart doesn't reset the budget and replicas converge within 60 s.
- Test in `packages/engine/tests/aiUsage.test.ts`: hydrate, then `admit` refuses past the budget; max semantics.

**Web.**
- Create `apps/web/lib/rateLimit.ts`:
  - `interface Limiter { take(key: string): Promise<{ ok: true } | { ok: false; retryAfterS: number }> }`
  - `memoryLimiter(max, windowMs)`: wrap the existing logic.
  - `durableLimiter(bucket, max, windowS, client = supabaseAdmin())`: calls `client.rpc("take_rate_slot", { p_bucket, p_key, p_window_s, p_max })`. **On any RPC error it falls back to an in-memory limiter for that process and logs once** (fail open to the memory limiter, never fail closed on a DB hiccup).
  - This is the first `.rpc(` call in apps/web.
- Convert limiters 1, 2, 3, 5 and 6 to `Limiter` with `await`. The deps are already injected (`RouteDeps.limiter`, `VendorDeps.writeLimiter` / `discoverLimiter`), so tests pass a `memoryLimiter`.
- Keep the 429 bodies and `retry-after` headers exactly as they are, including `{error:{code:"daily_limit",…}}`.
- **Ordering fixes (cheap, do them):**
  - Chat: ~~check the daily cap **before** the per-user turn~~ (reverted in review: that let one user's refused requests burn the shared daily budget). The per-user turn is taken first, then the daily cap (`lib/chat/limits.ts` `takeChatTurn`).
  - Approval route: validate the body before taking a slot (`approval/route.ts:104`).
- Optional: give `/api/deals/[jobId]/actions` (answer/message/negotiate/cancel) the approval limiter. It has none today.

### Tests
- `apps/web/tests/rateLimit.test.ts` (new):
  - `memoryLimiter` windows
  - `durableLimiter` with a fake client returning `{data:[{allowed:false,retry_after_s:42}]}` gives `{ok:false, retryAfterS:42}`
  - an RPC error falls back to memory and logs once
- Update `apps/web/tests/{chat.store,demo,approval.routes,vendors.routes}.test.ts` for async limiters. Assertions stay the same.
- Engine: `packages/engine/tests/rateSlots.test.ts`:
  - memory repo semantics
  - the Postgres variant gated by `describe.skipIf(!process.env.HAGGLE_TEST_DATABASE_URL)`, the pattern in `packages/engine/tests/pilotSafety.test.ts:349-354`
  - two `PostgresRepository` instances share one budget
  - `scripts/test-postgres.sh` runs engine tests automatically
- `apps/mcp/tests/serviceVendors.test.ts`: the 26th add is refused, as today; a re-authorization doesn't count.

**Docs:**
- `docs/production-deploy.md` §12 "Per-process, in-memory limits": rewrite to say which limits are now shared (1, 2, 3, 5, 6, 7, AI budget within 60 s) and which stay per process (double-click join, alerts, MCP tool bucket). Keep "run one MCP replica".
- `docs/web-app.md:205-206`, `docs/operator-recovery.md:105`, `docs/pilot-metrics.md:99-101` (stale: the sink is already wired).

**VALIDATE:** typecheck; `npx vitest run apps/web/tests packages/engine/tests/aiUsage.test.ts packages/engine/tests/rateSlots.test.ts apps/mcp/tests/serviceVendors.test.ts`; build; Docker: `bash scripts/verify-migrations.sh && bash scripts/test-postgres.sh`.

**Commit:** `Durable rate limits: take_rate_slot (124_engine_rate_limits) for web chat/approval/vendor/account limits and MCP vendor additions; AI budget rehydrated from ai_usage_events`

---

## P6 (item 3): remove legacy Primitive/x402 code

This phase is **split in two.** Finish 6a and commit it. Start 6b only if 6a is green and you have time. 6b is optional, and its stop condition is strict.

### 6a: Primitive email/webhook removal (mechanical, low risk)

1. **Move the generic pieces to neutral modules first,** keeping the export names identical: everything is re-exported from `packages/engine/src/index.ts`, and the apps import from `@haggle/engine`.

   | From | Generic exports to move | To (new file) |
   |---|---|---|
   | `src/inbound/primitive.ts` | types `InboundMessage`, `TrustVerdict`, `AuthEvidence`, `InboundAttachmentMeta`, `InkboxTrustReason` | `src/inbound/types.ts` |
   | `src/outbound/primitiveSender.ts` | `OutboundEmail`, `SendOutcome`, `OutboundAttachment`, `replySubject`, `sendKeys` | `src/outbound/email.ts` |
   | `src/live/adapters.ts` | `claudeExtractor`, `heuristicExtractor`, `withHeuristicFallback` | `src/live/extractors.ts` |
   | `src/live/adapters.ts` | `disabledPayer` | `src/payments/disabledPayer.ts` |
   | `src/live/adapters.ts` | `parseFleet` | `src/live/fleet.ts` |

   - Update every importer: `live/inkbox.ts:14-15`, `sim/fleet.ts:10-11`, `workflow/engine.ts:28,36`, `workflow/ports.ts:7`, `workflow/deadLetter.ts`, `inbound/senderAuth.ts:13`, `eval/harness.ts:9,12`, `apps/mcp/src/live.ts:9-10,31`, `apps/mcp/scripts/{pilot-preflight,email-trial-replay}.ts`, and about 17 engine tests plus 2 apps/mcp tests that `import type { TrustVerdict } from "../src/inbound/primitive.ts"`.
   - Grep: `grep -rn "inbound/primitive\|outbound/primitiveSender\|live/adapters" packages apps --include=*.ts | grep -v node_modules`.
2. **Delete the Primitive-only code:**
   - `primitiveEmail`, `isPrimitiveHost`, `primitiveAttachments` (and `src/inbound/attachments.ts`'s tar `extractAttachments` **only if** `grep -rn "extractAttachments\|ExtractedFile"` shows no Inkbox user; `ExtractedFile` is used by `ports.ts` `AttachmentPort`, so keep the type and move it if needed)
   - `sendEmail` / `SenderClient` / `SendRejected`
   - Primitive `verifyWebhook` / `toInbound` / `senderTrust` / `WebhookVerdict`
   - the files `inbound/primitive.ts` and `outbound/primitiveSender.ts` once they're empty
3. **Delete or port the tests:**
   - `tests/primitiveWebhook.test.ts`
   - `tests/helpers/primitiveEvent.ts`
   - the Primitive cases in `tests/liveAdapters.test.ts` (keep its `parseFleet` cases, pointed at the new module)
   - `tests/liveInbound.test.ts`: keep whatever tests Inkbox mapping, delete the Primitive mapping
   - `tests/goldenChain.test.ts`: read it first. If it is a Primitive-signed end-to-end chain, delete it only if `workflow.e2e.test.ts` covers the same chain; otherwise port it to Inkbox-shaped events (`live/inkbox.ts` `inkboxToInbound`)
   - Some tests (deliveryStatus, failureDrill, reconcile*) use the Primitive helpers only as event builders. Switch them to an Inkbox-shaped builder.
4. **Grep traps (not legacy):** `contract.ts:7` "primitives" (type primitives); `primitive.email` domains in `matching.ts:58`, `matching.test.ts`, `verifyApproval.test.ts` (fixture strings); the `senderTrust` property name in `apps/mcp` and `reconcile.ts`.

**Commit 6a:** `Engine: Primitive email/webhook code removed; inbound/outbound types, extractors, fleet parser and disabled payer in neutral modules`

### 6b (optional): retire the x402 rail
- **Scope:**
  - `src/payments/x402Challenge.ts`
  - `x402Payer`
  - `checkX402PaymentAllowed` and the x402 constants in `payments/guard.ts` (keep `checkApprovedPayment`, which Stripe uses)
  - the x402 branch of `sendAccept` (`engine.ts:4120-4138`)
  - `handleInteraction` (`engine.ts:5668-5860`)
  - the x402 payer in `src/mock.ts:20-61`
  - `sim/fleet.ts:71-81`
  - `PayerPort.client` (`ports.ts:123-130`, typed on x402's `PayerClient`)
  - the deps `@primitivedotdev/sdk` and `viem` in `packages/engine/package.json` (viem is only used in `adapters.ts:7`); then `npm install` to update the lockfile
- **Keep:**
  - **The safety behaviour at `engine.ts:5679-5681`:** an `interaction.json` / payment challenge from a business must still be flagged `external_payment_link` and never acted on. Keep a minimal detector, with a test.
  - `PaymentRow.rail: "x402" | "stripe"` in the DB (migration 102: historic rows).
  - `packages/core` `"primitive_x402"` (core, don't touch).
  - `deadLetter.ts:125` refusing `pay:` keys.
- **Changes:**
  - `PayerPort` becomes `{ disabledReason?: string; simulated?: boolean }`.
  - A non-Stripe, non-manual payment is refused with the existing "payments off" path (`engine.ts:4113-4118`).
  - Mock's default rail is already `simulatedStripe()` (`mock.ts:20-43`).
  - The `paymentStatus` defaults `rail:"x402", network:"base-sepolia"` (`engine.ts:7111,7120,7741`) feed board output: change them only if no view or test depends on them (grep the views for `base-sepolia`).
- **Tests to delete or adjust:** `x402AndSender.test.ts`, the x402 cases in `guard.test.ts`, `workflow.e2e.test.ts:47,131` (`rail: "x402"`; delete that case), `continuityVsIdentity.test.ts:133-141` (an x402 payment row; rewrite with stripe), `stripe.test.ts:179` (keep: it asserts no x402 email).
- **Stop condition for 6b:** if removing `handleInteraction` / `PayerPort.client` cascades into more than about 25 test edits outside the files listed, or touches approval/payment guard semantics, stop. Keep 6a, revert 6b and report.

**Docs (6a/6b):** `packages/engine/CLAUDE.md` lines about "talk to sellers only by email" and "x402 uses USDC base units" become "through Inkbox" and remove the x402 mention. Update `CHECKLIST.md`'s "Inkbox migration" status. Mark `docs/buyer-runbook.md`, `docs/preflight-readiness.md` and `docs/progress.md` Primitive sections as historical, with a one-line banner (don't rewrite them).

**VALIDATE:** typecheck; `npx vitest run packages/engine apps/mcp/tests`; build; `bash scripts/test-postgres.sh` (Docker); `grep -rln "primitivedotdev\|x402" packages apps --include=*.ts | grep -v node_modules` shows only the intentionally kept references, listed in the report.

**Commit 6b:** `Engine: x402 rail retired (payer port without a client, payment-challenge emails still flagged); Primitive SDK and viem removed`

---

## P7 (item 8): nonce-based CSP, then Playwright browser tests

### 7a: CSP nonces (offline; do this first)
**Now:**
- The CSP is static, built at build time in `apps/web/next.config.ts`: `buildCsp` at `:20-43`, `securityHeaders` at `:46-55`, `headers()` at `:67-74` for `/(.*)`.
- `script-src 'self' 'unsafe-inline'` (+ `'unsafe-eval'` in dev, + `https://challenges.cloudflare.com` with Turnstile); `style-src 'self' 'unsafe-inline'`.
- The comment at `:3-4`: next.config.ts can't reliably import local TS files.
- `apps/web/proxy.ts` exists. In Next 16 middleware is named `proxy`; it runs on Node by default and the `runtime` config isn't allowed.
- Read `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md` (and `node_modules/next/AGENTS.md`: "This is NOT the Next.js you know").

**Next 16 mechanics (verified in node_modules):**
- Next reads the nonce from the **request's** `content-security-policy` header (`next/dist/server/route-modules/app-page/parse-request-headers.js:30-31`; regex `/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/`, taken from `script-src`, falling back to `default-src`).
- `x-nonce` is only for your own `headers().get('x-nonce')`.
- Nonces require dynamic rendering. Currently static: `/_global-error`, `/_not-found`, `/acceptable-use`, `/onboarding`, `/privacy`, `/terms`.

**Tasks:**
1. **Builder.** Move `buildCsp` into `apps/web/lib/csp.ts`: a pure function with no imports, taking `{ nonce?, dev, supabaseUrl, turnstile }`.
   - With a nonce: `script-src 'self' 'nonce-<n>' 'strict-dynamic'` (+ `'unsafe-eval'` in dev; drop `'unsafe-inline'`; keep the Turnstile host for browsers without strict-dynamic).
   - Keep **`style-src 'self' 'unsafe-inline'` with no nonce.** There are 50 React `style={{…}}` attributes in 19 files, and once a nonce is in `style-src`, `'unsafe-inline'` is ignored and style attributes break. Script injection is the XSS risk that matters; record the trade-off in a comment and in the docs.
   - `frame-src` (Turnstile), `connect-src` (Supabase https + wss; dev `ws:`), `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` stay as today.
2. **Proxy.** In `proxy.ts`, mint `nonce = Buffer.from(crypto.randomUUID()).toString("base64")` per request:
   - Set `content-security-policy` on the **request** headers (so Next picks the nonce up), plus `x-nonce`.
   - Pass `NextResponse.next({ request: { headers: requestHeaders } })` in **both** places where the response is built: the initial one, **and** inside the Supabase `setAll` callback (`proxy.ts:14-17`), which recreates the response.
   - Set the CSP header on the final response **and** on the redirect (`:22-27`).
   - Consider the guide's matcher `missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }]`.
3. **Remove the CSP from `next.config.ts` `headers()`** (keep HSTS, nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy), so responses don't carry two policies. Static assets excluded by the proxy matcher (`_next/static`, images) don't need a CSP.
4. **Dynamic rendering.** Force it everywhere: make the root layout `apps/web/app/layout.tsx` `async` and `await connection()` (from `next/server`).
5. **Tests.** Update `apps/web/tests/hardening.test.ts`:
   - it imports `buildCsp` / `securityHeaders` from `../next.config.ts` (`:4`); point it at `../lib/csp.ts`
   - keep all existing directive assertions (`:11-46`)
   - add: with a nonce, `script-src` contains `'nonce-…'` and `'strict-dynamic'` and **not** `'unsafe-inline'`; `style-src` still has `'unsafe-inline'`; no CSP in `securityHeaders`
   - add `apps/web/tests/proxy.test.ts`, if `proxy` can be imported without Next's runtime: call it with a `NextRequest` and a stubbed Supabase env, and assert a CSP with a fresh nonce per request on both pass-through and redirect. If it can't run outside Next, cover it in 7b instead and say so.
6. **Docs.** `docs/production-deploy.md` §12 "CSP uses 'unsafe-inline'" becomes: scripts nonce-based with strict-dynamic; styles still allow inline because of style attributes.

**VALIDATE:**
- `npx vitest run apps/web/tests`
- `NEXT_PUBLIC_SUPABASE_URL=https://ci-placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-placeholder-anon-key NEXT_PUBLIC_HAGGLE_DEMO=false npm run build -w @haggle/web`. The build succeeds, and `.next/prerender-manifest.json` no longer lists the legal pages as static.
- `next start` locally, then `curl -sI http://localhost:3200/terms`: one CSP header, a nonce that changes between requests, and the `<script>` tags in the HTML carry `nonce=`. This works without Supabase credentials if the proxy tolerates placeholder values; if it doesn't, use the placeholders above.

**Commit:** `Web: per-request CSP nonce (script-src strict-dynamic, no unsafe-inline scripts), pages render dynamically`

### 7b: Playwright browser tests
**Hard facts:**
- The guest flow needs a real Supabase Auth with anonymous sign-ins: `GuestButton` calls `supabaseBrowser().auth.signInAnonymously()` (`apps/web/components/GuestButton.tsx:27`).
- The chat needs Anthropic: `app/api/chat/route.ts:96-101`.
- `NEXT_PUBLIC_HAGGLE_DEMO` is inlined at build time (`lib/demo.ts:5`).
- No Playwright is installed, and there are no `data-testid`s: use roles and labels.

**Two tiers. Do tier 1 fully; tier 2 only if Docker is up.**

**Tier 1 (offline, always):**
1. **Install and configure.**
   - `npm i -D -w @haggle/web @playwright/test@<pin the current stable version and write it in package.json exactly>`, then `npx playwright install chromium`.
   - Create `apps/web/playwright.config.ts` with `testDir: "e2e"`. Specs go in `apps/web/e2e/*.spec.ts`, **not** `tests/`: the root `vitest.config.ts` includes `apps/*/tests/**/*.test.ts`.
   - `webServer` runs `next start --port 3200` on a build made with demo off and placeholder Supabase values.
   - Script `"e2e": "playwright test"` in `apps/web/package.json`.
2. **`e2e/public.spec.ts`.**
   - For `/`, `/login`, `/terms`, `/privacy`, `/acceptable-use`: the page renders (heading visible); **no `securitypolicyviolation` events** (`page.addInitScript` to collect them into `window.__csp`) and no console errors containing "Content Security Policy".
   - The response CSP has a nonce, and two loads have different nonces.
   - A protected route (`/chat`) redirects to `/login`, and the redirect carries a CSP.
   - This proves 7a in a real browser.

**Tier 2 (Docker + local Supabase; skip with a clear message if it's unavailable):**
1. **Local Supabase.**
   - `npx supabase@<pin> init` (writes `supabase/config.toml`, **check it doesn't clash with `supabase/migrations`**).
   - Set `[auth] enable_anonymous_sign_ins = true` (verify the key name in the generated config).
   - `npx supabase start`.
   - Migration names like `100_engine_core.sql` may not fit the CLI's timestamp naming. Apply them yourself instead: `psql` against the local DB with `pg_apply_migrations` from `scripts/pg-common.sh`, or loop over the files with `psql -f`.
2. **Fake Anthropic.** `apps/web/e2e/fakeAnthropic.ts` is a tiny HTTP server that streams a scripted Messages SSE. Set `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`: the SDK reads it (`node_modules/@anthropic-ai/sdk/client.js:102`).
   - Script: first a `deal` tool call with `dry_run:true`, then a real `deal` after the user confirms (prompt contract: `apps/web/lib/chat/prompt.ts:15-17`).
   - **The exact SSE event shape for `beta.messages.stream` is unverified.** Read the SDK's stream parser and mirror the event sequence (`message_start`, `content_block_start`/`_delta`/`_stop`, `message_delta`, `message_stop`).
   - If the shape can't be matched within about 45 minutes, skip the chat steps and start the deal through the MCP server directly, reusing `apps/web/tests/approval.e2e.test.ts`'s helpers. Then drive only the deal page and approval in the browser.
3. **Mock MCP server.** Start it exactly as `apps/web/tests/approval.e2e.test.ts:15-49` does (resolved `mcp-use` bin, `.cmd` on Windows, random port, env `HAGGLE_MODE=mock HAGGLE_AUTH=required HAGGLE_SIM_DELAY_SCALE=0 HAGGLE_SERVICE_TOKEN=<32+ chars>`, `/health` poll, `taskkill /T /F` teardown).
   - **Also set `HAGGLE_MOCK_DATABASE_URL` to the local Supabase Postgres URL.** `workspace_members.workspace_id` references `public.workspaces(id)` (`300_web_accounts.sql:12`), and the in-memory mock wouldn't have the row.
4. **Web build.** `NEXT_PUBLIC_HAGGLE_DEMO=true` with the local Supabase URL and anon key. `SUPABASE_SERVICE_ROLE_KEY`, `HAGGLE_MCP_URL`, `HAGGLE_SERVICE_TOKEN`, `ANTHROPIC_API_KEY=fake` and `ANTHROPIC_BASE_URL` go in the env of `next start`, **never** in a committed file. Leave `NEXT_PUBLIC_TURNSTILE_SITE_KEY` unset; leave `WEB_CHAT_DAILY_CAP` unset.
5. **`e2e/guest-deal.spec.ts`:**
   1. Landing: the demo banner (`role="note"`) and the "Try the demo, no sign-up" button.
   2. `/chat`: the "Chat with Haggle" region.
   3. Type into the "Message Haggle" textbox and Send.
   4. The "Open deal board" link.
   5. Deal page: wait for the "Final" chip next to the "Quotes" heading; answer open questions if the form appears.
   6. "Approve $X", then "Yes, approve $X", then "Approved. Nothing is charged until you pay."
   7. "Pay $X", then "Paid $X to Bay Catering (simulated)."

   In mock, Bay Catering is recommended and the pay amount is $5 (`approval.e2e.test.ts:96-108`). On every page, no CSP violations.
6. **CI.** Add a separate job `web-e2e` to `.github/workflows/ci.yml` for **tier 1 only**: build with demo off and placeholder values, `npx playwright install --with-deps chromium`, `npm run e2e -w @haggle/web -- e2e/public.spec.ts`. Don't add tier 2 to CI; document how to run it in `docs/web-app.md`. Don't push. CI only runs when the user pushes.

**Docs:** `docs/web-app.md:204` ("No browser end-to-end test yet") and `docs/production-deploy.md:349`: replace with what now exists and how to run it.

**VALIDATE:** `npm run e2e -w @haggle/web` (tier 1 green; tier 2 green or explicitly skipped, with the reason); vitest still doesn't pick up `e2e/` (run `npx vitest run apps/web` and check the file count).

**Commit:** `Web: Playwright browser tests (public pages + CSP violations offline; demo guest deal → approve → pay against local Supabase and the mock server)`

---

## P8 (item 6): `CHECKLIST.md`, docs and the final report

1. **`CHECKLIST.md`.**
   - "Now working on": Aarnav: `aarnav-hardening` (this plan).
   - Statuses: Inkbox migration (after P6), Business learning / brain (tenancy, P3), Other views (P4).
   - Blockers: remove resolved ones, such as the brain-tenancy part of Yash's review notes, if P3 landed.
   - **Log lines** in the existing format `date · who · what changed`, newest first, under `## Log`: one line per phase that landed, stating what was verified and what wasn't (e.g. "Postgres suite not run: Docker off").
   - Keep entries short (CLAUDE.md §8 rule 6).
   - **Also add the missing log line for `aarnav-prod`'s production branch** (commits `23d1037`, `23a6b8a`, `506a46c`, 2026-10-22): web approvals, self-serve vendors, hardening, deploy/ops. The checklist's last entry predates it.
2. **`docs/production-readiness.md`.** Add a "Pass 6: hardening (aarnav-hardening)" section in the same style as passes 1–5: what changed, the verification counts, and what's still open.
3. **Final report.** Write it to `docs/hardening-report.md` and print a short version in chat:
   - **Per phase:** done / partial / skipped, with the commit hash.
   - **Test counts:** before and after (full vitest run; Postgres suite if it ran).
   - **Not verified,** and why. At minimum: Docker-dependent runs; real clients (Claude.ai / ChatGPT views); live migrations 124 and 202 **not applied anywhere real**.
   - **Operator steps before deploying this branch:** apply `202_brain_tenancy.sql` and `124_engine_rate_limits.sql`, record them in the ledger, and redeploy the MCP server and the web app together (the web rate limiter needs `take_rate_slot`; it falls back to memory if it's missing).
   - **Needs a decision:** anything that hit a `packages/core` or external-account wall; the optional `.gitattributes` renormalize.
4. Final full `npx vitest run` + typecheck + build. Commit `Checklist, readiness pass 6, hardening report`.

---

## NOT building
- Any `packages/core` change: new approval status, `manual` rail type, `"web"` approval channel, `ReplyMeta.extraction`.
- Brain cross-workspace aggregates (option (b) in `docs/aarnav-handoff.md`).
- Moving double-click joining, alert dedupe or the MCP tool bucket to a shared store.
- CSP nonces for styles, or rewriting the 50 inline style attributes.
- Tier-2 browser tests in CI; a hosted Supabase project.
- A repo-wide `.gitattributes` renormalize.
- Push, deploy, live migrations, real outreach, any secret handling.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Docker off, so Postgres/migration/Supabase checks can't run | High (it was off at plan time) | Migrations 124/202 unverified on a real Postgres | Report it explicitly; the user starts Docker Desktop before leaving it running |
| Brain PK swap breaks `migration-compat.sh` or re-run | Medium | CI red | No FK to workspaces; guarded `do $$` blocks; run both scripts |
| Async limiter refactor changes 429 bodies | Medium | Web regressions | Keep the bodies byte-identical; existing tests assert them |
| x402 removal cascades through `engine.ts` | Medium | Large diff, risk to payment safety | 6b is optional with a strict stop rule; keep the `external_payment_link` detector |
| Nonce CSP breaks a page (Turnstile, inline styles) | Medium | Broken login | `style-src` keeps `'unsafe-inline'`; strict-dynamic + host allowlist; Playwright CSP-violation check |
| Next 16 proxy differences | Medium | CSP not applied | Read `node_modules/next/dist/docs` first; verify with curl and Playwright |
| Fake Anthropic SSE shape is wrong | Medium | Chat step of tier 2 fails | Fall back to starting the deal through MCP and testing the deal page + approval only |
| Full vitest run is slow and flaky on Windows | High | False alarms | Re-run failures alone with `--maxWorkers=2` before treating them as real |

## Acceptance criteria
- [ ] Each phase committed on `aarnav-hardening`, or explicitly skipped with a reason in `docs/hardening-report.md`
- [ ] `npm run typecheck` clean; `npm run build` green
- [ ] `npx vitest run` passes on Windows (any remaining failures listed, each passing in isolation)
- [ ] Two-workspace test proves brain isolation (engine + MCP e2e)
- [ ] The manual handoff renders in the deal board and approval card, with screenshots in `docs/screenshots/`
- [ ] Web and MCP limits use `take_rate_slot`, with a memory fallback
- [ ] Primitive code gone (6a); x402 gone or its remaining references listed (6b)
- [ ] CSP has a per-request nonce and no `'unsafe-inline'` in `script-src`; the Playwright public suite passes
- [ ] `CHECKLIST.md`, `docs/production-readiness.md`, `docs/production-deploy.md` §12 and `docs/web-app.md` match the code
- [ ] Nothing pushed, deployed or sent; no secrets in the diff (`node apps/mcp/scripts/secret-scan.ts`)
