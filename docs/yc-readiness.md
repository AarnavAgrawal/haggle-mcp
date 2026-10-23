# YC product-readiness: buyer side (2026-10-23)

What Haggle's buyer side does today, and how we know. It separates what runs for real, what is only simulated, what has never touched a live system, and what blocks a first customer. Scope: Yashnil's lane (MCP tools, deal engine, migrations). The business brain, views and sellers are Aarnav's and are covered only where the buyer depends on them.

**Evidence rule.** "Verified" means a test or a measured run in this repository. Every number below is from **simulated** data (scripted vendors, a labelled corpus, a fake clock). **No real vendor, real reply, real approval or real payment has happened yet.**

## 1. The bottom line

- **The buyer journey works end to end, in simulation, without founder help.** An agent can request quotes, follow the deal, read a comparison, get a human's coded approval and carry the pilot's manual payment handoff through to a vendor-confirmed booking and a verified receipt. It does this in 6 of 6 corpus deals, picks the label's correct winner in 6 of 6, and has zero unsafe actions.
- **The biggest unknowns are live, not code:**
  - whether Claude reads real vendor mail as well as the perfect reader the simulation assumes;
  - whether real Gmail and Outlook replies thread back to the deal;
  - whether real vendors answer.
- **Product evidence for YC is zero real deals.** The staging email trial (`docs/staging-email-trial-runbook.md`) and one friendly-vendor deal are the next proof points.

## 2. Capability status

| Capability | Status | Evidence |
| --- | --- | --- |
| `deal` from plain words (headcount, date, budget, dietary, area) | **Implemented, tested** | `mcp.e2e`, `requestNormalize` tests; audit journey (a): words read correctly |
| Vendor outreach by email, with follow-ups and negotiation on real competing quotes only | **Implemented; simulated only** | orchestration eval (corpus + fleet arms) |
| Reading replies (Claude structured outputs; keyword fallback) | **Implemented, measured on the corpus** | Claude: 54/54 totals, 317/328 fields; deterministic money check after extraction; 0 incorrect financial quotes approvable (was 3) on the same readings (`docs/financial-integrity.md`) |
| Comparison, recommendation, explained refusal | **Implemented, tested** | Benchmark: 10/10 deals end where a careful buyer would (4 bought, 6 handed to the human with reasons) |
| Human approval (coded text from the approver's phone only, in live mode) | **Implemented, tested; never live** | `security*`, `purchaseFlow.e2e`; the code never reaches the model |
| Manual payment handoff (vendor confirms, human pays directly, PAID, verified receipt) | **Implemented, tested; never live** | New `pilot:manual` arm: 6/6 settled_verified, 2 human texts per deal, no charge |
| Stripe test-mode payment | **Implemented; off in the pilot** | Unit tests; `HAGGLE_PAYMENTS=manual` in the pilot |
| Voice calls, iMessage/SMS, A2A | **Implemented; off by default, untested live** | Unit tests with fake ports; carrier-keyword handling (`docs/carrier-keywords.md`) |
| Non-catering requests (plumbing, rentals) | **Partial** | `ask[]` works; discovery needs `GOOGLE_PLACES_API_KEY` (not set), so the agent must name the business |
| Learning from past deals (`ask`, profiles) | **Aarnav's brain** | Shared across workspaces until brain tenancy lands (`docs/aarnav-handoff.md`) |
| Operations: ops report, quarantine review, stuck-job recovery, migration ledger, launch gate | **Implemented, tested** | `ops*`, `releaseStaging.pg`, `migration-compat.sh` |

## 3. Measured, simulated (`npx tsx apps/mcp/scripts/scorecard.ts --n 10 --seed 1`)

"Before" is commit `396c52f`. "After" is this pass. Both were measured with the same, improved benchmark.

| Metric | Before | After |
| --- | --- | --- |
| Pilot path completed (manual handoff, perfect reader) | 6/6 | 6/6 |
| Benchmark deals ending correctly (bought or explained escalation) | 10/10 | 10/10 |
| Escalations naming the cheapest quote that meets every requirement | **1/4** | **4/4** |
| Extraction, keyword fallback reader: totals correct | 38/55 | 38/55 |
| Money errors shown to the human / approvable | 5 / 0 | 5 / 0 |
| Simulated minutes: first quote, quotes final (median); pilot paid (mean) | 0.1, 10.4; 82.2 | same |
| Human steps per deal: benchmark / pilot texts | 1.1 / 2.2 | same |
| Agent tool calls per deal: benchmark / pilot | 32.2 / 66.5 | same |
| Output to the agent per deal (est. tokens) | 5,662 | 5,740 (+1.4%) |
| Safety violations (all detectors) | 0 | 0 |

**Reading:**
- **What the benchmark shows:** before this pass, the benchmark couldn't distinguish a correct refusal from a failure; it reported only "4 paid, 6 nothing approvable". It also never ran the manual payment path the pilot actually uses. Both are measured now.
- **Most of this pass's fixes don't move these numbers.** They change what the agent is told, and tests guard them (§4).
- **Tool calls:** the pilot path costs about 2× the agent calls of the Stripe path. The scripted agent polls `wait_for_update` every minute while the vendor and the human act. That's an agent-experience cost to reduce (§5).

## 4. Fixed in this pass (buyer-experience audit of the mock server, then tests)

1. **Safety:** `list_deals` echoed a vendor's untrusted payment-instructions text into the model's context. It now points to `structuredContent` the way `get_quotes` does.
2. **Wrong wording on manual-payment pilots:**
   - `deal` told the agent "Payments are off on this server", so the agent told the user nothing could be bought.
   - Hints and approval caveats said "charged now" and "PAY <code>", although the pilot never charges.
   - All of these now say what happens: the business confirms the booking, the human pays it directly, and Haggle moves no money.
3. **Hidden option:** with nothing recommended, a cheaper quote that meets every requirement but is held back by the per-payment ceiling disappeared from the summary. It's now named, with its fix (ask for a smaller deposit).
4. **Hints that pointed the wrong way:**
   - `area_required` pointed to settings the agent can't change.
   - `job_not_found` sent the agent to start a new deal instead of `list_deals`.
   - A hint referred to a cursor `get_quotes` doesn't return.
   - Several errors said "set the approver or cap in settings", which is operator-only.
5. **Non-catering requests:** a plumbing request got "needs a headcount" and then a second error. It now gets one error, saying what to pass (`ask[]`) and that the configured caterers are never substituted. Listings no longer print "undefined" for requests with no headcount or date.
6. **A cursor from another deal** silently hid every update. It now replays from the start and says so.
7. **Approving before quotes are final** is still the human's call, but the approval now says it ends the comparison with the other businesses.

Tests:
- New: `packages/engine/tests/buyerHints.test.ts` (each test fails on the previous engine).
- New: `apps/mcp/tests/scorecard.test.ts`.
- Extended: `mcp.e2e` (area, non-catering, approve-early), `purchaseFlow.e2e` (manual wording), `acceptancePilot` (no vendor text in model output), `evalCorpus` (`pilot:manual` arm) and `benchmark` (verdicts, regression for the hidden option).

## 5. Open findings (not fixed here)

- **Context cost.**
  - `tools/list` is about 100 KB.
  - `deal`'s input schema is about 10 KB, and three tools carry about 14 KB output schemas.
  - `get_quotes` returns about 9 KB of structured content, against CLAUDE.md's target of about 1,500 tokens for six quotes.

  Trimming the schemas is the largest agent-experience win left. It touches view schemas, so it needs agreement on `packages/core/views.ts`.
- **Polling during the pilot handoff:**
  - Long waits for the vendor or the human have no "check back later" exit, so the scripted agent makes about 66 calls per deal.
  - A hint that says who is expected to act next, and when it's worth checking again, would cut this.
- **Wording:**
  - Flags such as `hidden_deposit` and `unsourced_figure` are never explained in the text.
  - "Spending cap" is used where the per-payment ceiling is what binds.
- **Demo servers only:** a raw client can approve its own quote through the view tools (labelled DEMO). Live servers refuse this.
- **Benchmark limitations:**
  - Mock vendors quote fixed prices regardless of headcount.
  - The reference agent is a script, not an LLM.
  - Extraction is measured only with the offline fallback reader.

## 5b. Since this report

- Financial integrity and vendor alternatives (`docs/financial-integrity.md`): 0 incorrect financial quotes approvable on the recorded Claude readings (was 3); other-date offers and priced options are kept for the human, never approvable until confirmed.
- What changes for staging, and what Aarnav must review: `docs/release-delta-staging-rc.md` (no migration, env or shared-contract delta since `396c52f`).

## 6. Remaining blockers to a first real customer

1. **Staging** (in progress): Aarnav's Manufact server and Inkbox identity, then migrations, deploy, and the Gmail/Outlook trial with a `READY` verdict (`docs/staging-handoff.md`).
2. **Claude extraction measured on the corpus:** done 2026-10-23 (`docs/financial-integrity.md` §3). To re-measure:
   ```bash
   HAGGLE_EVAL_LIVE=1 HAGGLE_EVAL_MAX_USD=5 npx tsx apps/mcp/scripts/eval-report.ts --stdout
   ```
   It uses the staging Anthropic key, needs approval, and costs about $1–3 by the price table. This is the single most important missing number.
3. **One friendly-vendor deal on staging**, end to end, with recorded consent.
4. **Brain tenancy** (Aarnav) before a second customer.
5. **Legal:** commercial-email requirements and pilot terms (`docs/manual-actions.md` §5).
