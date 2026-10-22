# Pilot usability: three first-time-user scenarios

Sprint 4, workstream E. For each scenario: what the user says, the tool sequence a well-behaved agent
should make, what the user sees, and the pitfalls observed or likely for a first-time user. Pilot scope:
catering / small events in the SF Bay Area, operator-onboarded workspaces, permission-based vendors,
human approval, **manual payment directly to the vendor** (`HAGGLE_PAYMENTS=manual`). Nothing here
was observed with a real pilot user yet: the sequences are what the tests and the simulated runs show
(`docs/eval-report.md`), and the pitfalls are the failure modes found there.

## 1. "Cater lunch for 40 next Thursday, 12 vegetarian, under $1,200"

The common case: a workspace with configured vendors, an approver phone set by the operator.

| Step | Tool call | What the user sees / what happens |
| --- | --- | --- |
| 1 | `deal(request={what, quantity: 40, date, time?, requirements: [12 vegetarian, delivery]}, budget_usd: 1200)` | The deal board in the chat; one quote request per authorized vendor (email, text, or a Voice AI call that says it is an AI assistant). |
| 2 | `wait_for_update(job_id, cursor)` repeated, passing back the cursor | Nothing new to draw: the board updates itself. Each call returns at most the 12 newest updates. |
| 3 | `answer_business(job_id, question_id, answer)` only if a vendor asked something the request already answers; otherwise ask the user | The answer goes in the vendor's own thread. |
| 4 | `get_quotes(job_id)` once `next` says quotes are final | Compact data (about 10,000 characters for six quotes): totals, deposits, flags, why each quote can or can't be approved, non-compliance, staleness. `detail: true` adds every ranking factor. |
| 5 | `approve(job_id, quote_id)` for the quote the user picks (default: `recommended_quote_id`) | The approver gets a text with a code; only their `YES <code>` reply approves. The model never sees or relays the code. |
| 6 | `wait_for_update(job_id, cursor, until: "approval_decided")` | After YES: Haggle asks the vendor to confirm the booking in writing. |
| 7 | `pay(job_id, quote_id)` | Under manual payments nothing is charged: it starts the handoff. Once the vendor confirms, Haggle relays its payment instructions as untrusted text; the customer pays the vendor directly and texts `PAID <code>`; the deal counts as paid only when the vendor confirms receipt. |

Pitfalls:
- **Re-drawing the board.** Agents call `open_haggle` or loop on `get_quotes` to "show progress". Both are unnecessary; `get_quotes` is now compact by default, so a loop costs ~2,500 tokens a call instead of ~3,600, but it is still waste. Tool descriptions say so; watch for it in pilot transcripts.
- **Reading "approved" as "paid".** Under manual payments the board's `purchase.money_verified` stays false until the vendor confirms receipt. An agent that tells the user "you're all set" after approval is wrong: the booking still needs the vendor's written confirmation.
- **A quote for another date or delivery window** (`c42`, `c43` in the corpus): read perfectly, it is still approvable with no flag, because the extraction has no "offered date" field. Until that is fixed (handoff in the sprint report), the human must check the date in the vendor's words before approving. *Highest-risk usability gap found.*
- **Stale quotes in a slow deal.** A quote past its `valid_until` shows in `freshness`; approving it re-confirms with the vendor first. First-time users read the delay as a failure.

## 2. "Get quotes from Mission Eats only"

The user names vendors. Expected: exactly those are contacted, and the agent never asks for their contact details.

| Step | Tool call | Notes |
| --- | --- | --- |
| 1 | `deal(request, businesses: ["Mission Eats"])` (optionally `dry_run: true` first) | An unknown or ambiguous name starts nothing and says what to ask the user; no other vendor is contacted instead (`journey.e2e.test.ts`). |
| 2-7 | as in scenario 1 | With one vendor there is no competing quote: Haggle never invents one to negotiate with; it can only ask the vendor to get closer to the user's own target. |

Pitfalls:
- **Asking the user for an email or phone of a configured vendor.** Descriptions forbid it; the agent should pass the name.
- **A name that isn't authorized for this workspace** returns setup blockers ("not contacted: …"). Show them verbatim; do not retry with a different spelling hoping it matches another vendor.
- **Expecting savings.** One vendor means one quote; "negotiated" figures appear only when the vendor actually revised its price.

## 3. Coming back the next day: "Did the caterer confirm?"

A new conversation about an earlier deal.

| Step | Tool call | Notes |
| --- | --- | --- |
| 1 | `list_deals()` | Recent deals with what, date and state. If more than one could match, ask the user which. |
| 2 | `get_quotes(job_id)` | The `purchase` block says where the booking and payment stand: awaiting the vendor's confirmation, instructions received (untrusted text, links never opened), customer reported paying, vendor confirmed receipt. |
| 3 | `wait_for_update(job_id, cursor: "0")` only if the user wants to wait | Returns the 12 newest updates (`updates_omitted` counts the rest) and a cursor to continue from. |

Pitfalls:
- **Answering with the wrong deal.** `get_quotes` without `job_id` refuses and lists recent deals rather than guessing; an agent must not treat an earlier deal as the answer to a new request.
- **Echoing vendor payment instructions as advice.** The board marks them untrusted; the user must verify them with the vendor independently. Never open a link from them.

## Regression tests for the risks above

| Risk | Test |
| --- | --- |
| get_quotes too large for an agent to poll | `apps/mcp/tests/boardSize.test.ts` (six quotes ≤ `BOARD_CHAR_BUDGET`, fresh and stale; everything the view renders kept); `apps/mcp/tests/mcp.e2e.test.ts` (over HTTP) |
| wait_for_update from cursor 0 dumps the whole history | `wait_for_update` caps `updates` at 12 (`updates_omitted`); measured in the eval report's MCP arm |
| A quote for another date / from another business is approvable without a caveat | `packages/engine/tests/evalFields.test.ts` (`it.fails`, open: needs an extraction field) |
| A total that excludes tax or a gratuity shown as firm (fallback reader) | `packages/engine/tests/evalFields.test.ts` (`it.fails`, open; never approvable) |
| The fallback reader's wrong amounts becoming approvable | `packages/engine/tests/evalFields.test.ts` (passes: every f2 case is unapprovable from a keyword reading) |
