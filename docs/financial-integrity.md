# Financial integrity: buyer side (2026-10-23)

The live Claude Sonnet 5.5 eval on the 59-reply corpus found quotes a human could approve on wrong money. This pass adds a deterministic money check after extraction (`packages/engine/src/parsing/financialIntegrity.ts`, wired into `validate.ts` and the engine). Claude's prompt and schema are unchanged.

**Evidence rule.** Every number here is from the SIMULATED corpus (replies we wrote). No real vendor reply has been checked.

## 1. Rules

All arithmetic is in integer cents, with a tolerance of $1.00 for one rounding.

1. **Stated total vs the business's own parts.** The parts are food (a stated subtotal, or a per-unit price × the quantity the business stated), delivery, fees, discounts and tax.
   - A difference no reading can explain is an issue (`total_mismatch`). The quote is flagged `conflicting_numbers` and held until the business clarifies.
   - The stated total is never replaced with a computed one; the board shows the business's figure with the reason.
2. **Unknown is never zero.** A charge with no amount, an "included" delivery with no price, or "tax included" with no figure can only explain a stated total *above* the known parts (a minimum order, a folded-in fee). It can never explain one below them.
   - "Tax included" fits either 0 (tax-inclusive prices) or a real sales-tax share of 2–15%.
   - A stated rate must match.
3. **Placing unclear charges.** A delivery fee or fee whose relation to the total the reader left unclear is placed inside or outside the total only when the figures add up to the cent.
   - The reader's own `delivery_included` isn't trusted for this (eval c40 said "false" for a fee its own total included).
   - A looser fit leaves the all-in total unknown (`fees_unclear`, so Haggle asks); it is never guessed.
   - With no stated total, a priced fee line is a charge on top of the parts.
4. **Counted once.** An "other fee" that repeats the delivery fee or the stated tax (same label kind, same amount) is dropped, with a note. So are repeated identical lines.
5. **Deposits stated as a share.** "Half up front", "50% deposit", "a 25% non-refundable deposit", "deposit of 30%" and "a third to hold the date" are read from the business's own words (never a call transcript, which holds the agent's words).
   - The deposit is computed only from the business's own all-in total, and labelled `computed: …`.
   - A stated amount that contradicts its stated share is `deposit_mismatch`.
   - A deposit mentioned with no amount, or a share of an unclear total, is `deposit_unquantified`. Without this, the approval would say "the full total is due up front".
   - "No deposit required" is none.
6. **Also issues:**
   - a per-unit × quantity that contradicts the subtotal (`line_items_mismatch`);
   - a deposit larger than the total;
   - an attached quote whose total disagrees with the email's (`document_total_mismatch`, previously only a caveat);
   - a payable field above the total.
7. **A per-person price that multiplies out to the stated total exactly** is an all-in per-person price, not the food line (eval fx-01's `quote.json`).

## 2. Every path that can make a quote approvable

| Path | Now |
| --- | --- |
| Board `approvable` / `approval_block` | Hard block `numbers_dont_add_up` with the business's figures in the reason (`approvability()`, the single chokepoint) |
| `approve` / `requestApproval`, auto "all quotes are in" offer, stale-quote re-confirmation | All go through `openApproval` → `approvability()`; refused with a fix that says never to approve a Haggle-computed figure instead |
| Recommendation, best available, best value | An inconsistent total is rejected from ranking (`numbers_dont_add_up`); it's still listed under "not approvable yet" with its fix |
| Negotiation | Never the cited basis and never countered (`rejectReason`) |
| Quote updates (`mergeCarryOver`, the revision branch) | A reply that doesn't restate the total ("delivery is included", "yes, 45 vegetarian") carries the earlier issues with the total. A newly stated total is checked on its own. A newly stated deposit settles deposit issues. |
| Records stored before this check | Re-checked from their stored parts (`recordIssues`) at approval and at payment |
| Payment (Stripe, manual handoff start/resume, PAID text) | `paymentVerdict` → guard rule 5b `QUOTE_INCONSISTENT` |
| Deal lifecycle | A quote held for figures counts as "approvable once the business confirms", like an approximate total. Before this, the deal failed ("no eligible quote") at window close and the business's correction arrived as an ignored late reply. |
| Clarification | One follow-up to the business, in its own figures ("your correct all-in total (the listed charges add up to $1,120.00, but the stated total is $1,050.00)"), only when the figures are what holds the quote. A pay-by-link or injection reply is never asked. |
| Brain estimates (`ask`) | Never quotes, never approvable (unchanged) |

## 3. Measured: the same Claude readings, old code vs new

We recorded Claude's raw structured extractions for all 59 replies (one live run under a $2 in-process cap; $1.46 spent, 115 calls, 0 refused). We then replayed the identical readings through `39ae43c` and through this pass, offline. Differences are the code's alone.

"Financially incorrect and approvable" means an approvable quote whose total, or amount due up front, isn't the label's. It's stricter than `fields.ts`, which didn't count a dropped deposit; `fields.ts` now does.

| Metric (59 replies, Claude readings) | Before | After |
| --- | --- | --- |
| **Incorrect financial quotes approvable** | **3** (fx-08 total; c44, c17 amount due up front) | **0** |
| Legitimate quotes approvable (label: firm, compliant, right date and business; 33) | 31 | 32 |
| False rejections added | – | 0 (the one still blocked, fx-04, is the pre-existing identity check) |
| Approvable quotes | 36 | 37 |
| Totals correct | 52/54 | 54/54 |
| Deposits correct | 12/14 | 14/14 |
| All fields correct | 313/328 | 317/328 |
| Wrong figures shown (blocked, with a caveat or reason) | 7 | 4 (c21 approximate, c47 delivery TBD, fx-08 held, fx-14 tax on top) |
| Unsafe replies approvable / reply type correct | 0 / 56 | 0 / 56 |

Offline scorecard (`scripts/scorecard.ts --n 10 --seed 1`, keyword fallback reader and scripted vendors):

- **Unchanged:** pilot 6/6 settled and verified, benchmark 10/10 correct ends, 0 safety violations, 0 approvable money errors.
- **Fallback reader improved:** totals 38 → 39, fields 237 → 240, unflagged wrong totals 2 → 1.
- **Orchestration:** identical on all 20 deals.

The evidence is private (0600) in `~/haggle-staging-ops/eval-runs/2026-10-23T19-11-05-988Z-record/` (`extractions.json`, `replay-before.json`, `replay-after.json`). Nothing from it is committed. The tests use hand-written readings in the same shape.

## 4. Cases that need the vendor to clarify

- **fx-08:** 40 × $26 = $1,040 + $80 delivery, "Total: $1,050". The board shows $1,050 held, and the business is asked for its correct all-in total.
- **c47 (unchanged):** delivery "depends on distance". The all-in is unknown, so it's held and the business is asked.
- **Any "Total $X plus $Y delivery" where the food price isn't stated:** whether $Y is in $X is unknowable from the figures, so the all-in is unknown and the business is asked. Before, this was approvable at $X.
- **A deposit mentioned with no amount** ("deposit required", or "please pay the deposit here" on a safe quote), **or a share of a total Haggle had to add fees or tax to.**

## 5. Remaining uncertainty

- **Synthetic corpus, one recorded run.** Claude varies between runs: c17's deposit was read in the first run and not in the second, and c13's total was Claude-summed in one run and absent in the other. The rules are written for both shapes, and tests cover both, but real vendor mail will have shapes we haven't seen.
- **Tolerance.** The tolerance is $1, and the tax share for "tax included" is 2–15%. A real 1% local tax hidden in an itemised "tax included" total would be held for clarification. That's the safe direction.
- **Discounts.** The extraction schema has no discount field. A discount reaches the check only if Claude lists it as an "other fee" (sign normalised from the label). A discount Claude drops makes the parts exceed the total, so the quote is held: safe, but a possible false hold.
- **Not changed (needs a product decision, see the eval report):**
  - "Delivery included" judged unmet when delivery is extra (c13, c47, fx-11 requirement checks);
  - an alternate-date offer read as a decline (c43);
  - multi-option replies (c45).
- **Aarnav's deal-board view** has no short label for the new block code `numbers_dont_add_up`. It falls back to "it can't be approved yet" with the full reason. A one-line `BLOCK_SHORT` entry is suggested, not applied (his file).
