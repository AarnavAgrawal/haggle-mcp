# Release delta: frozen staging `396c52f` → staging release candidate (2026-10-23)

Non-secret. It compares the frozen staging checkout (`~/Desktop/haggle-staging`, detached at `396c52f`, untouched) with the latest verified `origin/yashnil`. Nothing here was deployed, migrated or sent.

## 1. Commits since `396c52f` (all buyer-side, Yashnil's lane)

| Commit | What |
| --- | --- |
| `39ae43c` | Buyer experience: no vendor text in `list_deals`, manual-payment wording, hidden options named, honest hints; pilot-path benchmark |
| `d212968` | Financial integrity after extraction: stated totals reconciled in cents, charges counted once, deposit shares, approval/ranking/negotiation/payment blocked until the vendor clarifies (`docs/financial-integrity.md`) |
| `b15cc9c` | `quote.json`'s headcount is the request's, never multiplied into food (caught by CI) |
| `f05d312` | Vendor alternatives: an offer for another date stays an alternative (never a decline); priced options kept for the human's choice; neither approvable, recommended or cited until confirmed |
| (head) | The brain learns a price only from a firm, consistent quote |

The diff is 40 files: engine, MCP tools, tests and docs.

## 2. What changes for staging

| Area | Delta since `396c52f` |
| --- | --- |
| **Migrations** | **None.** The staging plan (`100`…`122`, then Aarnav's `200`/`201`) is unchanged. Rehearsed offline on 2026-10-23. |
| **Env vars / config** | **None.** `.env.example` and `docs/env-manifest.md` are unchanged; the CI env-manifest check passes. |
| **Shared contracts** (`packages/core/*`, `CONTRACTS.md`, root `CLAUDE.md`, `PLAN.md`, `package.json`) | **None.** |
| **Aarnav-owned paths** (`apps/mcp/views/**`, `packages/brain/`, `apps/sellers/`, `apps/bench/`, `fixtures/`, `2xx` migrations) | **None.** |
| **Stored data** | `quotes.record` is `jsonb`. It gains optional `financial` and `options`, so no schema change is needed. Rows written before this release (none on staging; its DB is empty) are re-checked from their stored parts at approval and payment. |
| **Tool output** | Same schemas. New values only: block code `numbers_dont_add_up`, payment refusal `payment_refused_quote_inconsistent`, a pending question that now lists the business's priced options, and the flag `conflicting_numbers` (already in the contract) used more often. |
| **Behaviour an operator will see** | (a) A quote whose figures don't add up shows the business's figure, is held, and the business gets one clarification email. (b) A deal whose only quotes are held alternatives (figures, another date/time, options awaiting a choice) reaches "ready" with the reason instead of failing. (c) "Half up front" becomes a deposit amount; a deposit mentioned without an amount holds approval. |
| **Vendor-facing text** | One new follow-up line in the existing follow-up email: "your correct all-in total (the listed charges add up to $X, but the stated total is $Y)" or "the deposit amount due at booking (…)". It's sent once, only to a quote held for its figures, never to a pay-by-link or injection reply, and never by phone. |

## 3. Evidence (verified)

- **Local CI** (every `.github/workflows/ci.yml` step in a clean worktree of the candidate): typecheck, build, launch gate, the full test suite, skewed-clock tests, mock smoke, migration order, migration compatibility, and the Postgres 17 suite. Node 22.21 locally vs the required 22.22.2 is the one known gap; GitHub CI runs the required version.
- **Claude readings** (59 replies, recorded once under a $2 cap, replayed offline through each version):

  | | `39ae43c` | Candidate |
  | --- | --- | --- |
  | Financially incorrect quotes approvable | 3 | **0** |
  | Legitimate quotes approvable (of 33) | 31 | 32 |
  | Reply type correct | 56/59 | 58/59 |
  | Fields correct | 313/328 | 322/328 |
  | Unsafe replies approvable | 0 | 0 |

- **Offline scorecard:**
  - unchanged: pilot 6/6 settled and verified, benchmark 10/10 correct ends, 0 safety violations;
  - orchestration identical on all 20 deals;
  - fallback reader: reply types 40 → 41, fields 237 → 246.

All of this is simulated or synthetic. No real vendor reply has been processed by this release.

## 4. What needs Aarnav's review

**Required before this candidate reaches `main`.** These are things this release relies on or changes that touch his side; none of his files were edited.

1. **Brain input** (`packages/engine/src/workflow/engine.ts`, the `learnFromReply` call; contract unchanged). The brain no longer receives a `quote` item for a quote with no total or with held figures; questions and declines still arrive. Please confirm the brain doesn't depend on those items, for example to count replies.
2. **Deal-board view** (`apps/mcp/views/deal-board/view.tsx`, his file). There's no short label for the new block code `numbers_dont_add_up`; it falls back to "it can't be approved yet" plus the full reason. Suggested one line: `numbers_dont_add_up: "its figures don't add up"`. Pending-question text can now be up to 500 characters with the options list; please check it wraps inline at about 400 px.
3. **`.env.example` (shared) vs `main`:** 14 variables added by Yashnil's earlier passes (`HAGGLE_ENV`, `HAGGLE_PROD_DB_HOSTS`, `HAGGLE_ALLOW_PROD_DB`, `HAGGLE_ALERT_WEBHOOK_URL`, `HAGGLE_AI_MAX_CALLS_PER_JOB`, `HAGGLE_AI_DAILY_TOKEN_BUDGET`, `HAGGLE_STALL_CHECK_EVERY_S`, `HAGGLE_LOG_LEVEL`, `HAGGLE_APPROVALS`, `HAGGLE_VOICE_WORKSPACE`, `HAGGLE_PAYMENTS`, `HAGGLE_EXTERNAL_SENDERS`, `HAGGLE_REPLY_TOKEN_SECRET`, `HAGGLE_BUILD_TIME`), plus one default change, `HAGGLE_EMAIL_APPROVAL_BY_CODE` `true` → `false`. These already shipped in `396c52f`, the frozen staging commit, but `main` hasn't seen them. He should agree to them as part of the merge.
4. **`CHECKLIST.md`:** only Yashnil's items and log lines.
5. **Migration order on a shared database:** engine `105`…`122` are new relative to `main`. His `200`/`201` apply after `122` (staging plan §1). No engine migration touches brain tables.

**Not reviewable yet:** his `merged-working-demo` branch (see `docs/merge-decisions-working-demo.md`) isn't on `origin`. Until it's pushed, conflicts with `yashnil` can't be checked. `origin/main` is an ancestor of `yashnil` (0 commits ahead), so `yashnil` itself merges into `main` without conflict.

## 5. Shortest safe path to one staging release candidate

1. **GitHub CI green on the pushed `origin/yashnil` head.** That head is the candidate.
2. **Aarnav reviews §4 items 1–3** and either pushes `merged-working-demo` to `origin` or confirms it isn't going to staging now.
   - **If it isn't:** fast-forward `main` to the candidate. `main` is its ancestor, so there are no conflicts. This needs both owners' sign-off at a gate.
   - **If it is:** he rebases it onto the candidate, re-runs CI, and that branch becomes the candidate.
3. **Build a new staging worktree at the candidate sha** (never edit `~/Desktop/haggle-staging`), `npm ci`, `npm run build`. Re-run `staging-gates.sh g1`; nothing about the gates changes, since no env or migration delta exists.
4. **Continue `docs/staging-handoff.md` from G1.** It's still blocked on Aarnav's Inkbox variables and his Manufact `link.json`. Migrations, deploy and the Gmail/Outlook trial follow the existing runbook. The email trial checks matching only, so its checklist is unchanged. On the first staging deal (your own mailbox as the vendor), reply once with figures that don't add up ("40 x $26 = $1,040, Delivery $80, Total $1,050"). Check that `get_quotes` holds it with `numbers_dont_add_up`, and that the one clarification email reads correctly before any real vendor is contacted.
