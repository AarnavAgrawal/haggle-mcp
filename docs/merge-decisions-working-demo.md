# merged-working-demo: decisions for merging main and feat/live-demo

Branch `merged-working-demo` is `main` (0672d36, Yash's rc1) merged with `feat/live-demo` (925462b, Aarnav's live demo). Every logic conflict was decided by Aarnav on 2026-10-18; the decisions are below. Mechanical conflicts (each side added unrelated things) are combined as a union.

## Product decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Requirement policy | **Soft (live-demo).** Only unsafe (scam, injection, unverified, superseded) or unpriced quotes are excluded. Unmet requirements and over-budget quotes rank lower with caveats; they can be recommended and countered. |
| 2 | Approval and payment | **Approve, then pay (main).** Approval records the human's OK (card, client form, text YES code, email APPROVE code); a separate `pay` charges. `pay` stays a real step, not a retry. |
| 3 | Confirm-only approvals | **Keep (live-demo).** `approve(action: "confirm" \| "pay")`. "pay" approves for payment (then `pay` charges); "confirm" only confirms the order (nothing charged) and ends in the `confirmed` state. |
| 4 | Deal board view | **Main's board as the base**, ported from live-demo: inline conversation panel, live negotiation line (`NegotiationNow`), "total not stated", custom-ask fields (`AskFields`, `compare_by`), the `confirmed` state, labelled chat buttons, and New deal. |
| 5 | Who can be picked | **Any safe option (live-demo).** Every safe quote has "Choose this" with a confirm step showing caveats (`choose_in_view`). Choosing approves for payment (decision 2); it doesn't pay. |
| 6 | Board in chat | **One live board (live-demo).** `deal` binds `deal-live`; `get_quotes` and `wait_for_update` are data-only; `open_haggle` renders on request. |
| 7 | Workspaces and auth | **Adopt workspaces, auth open by default.** Every handler is workspace-scoped `run(ctx, …)`; main-only tools (`list_deals`, `call_back`, `call_back_in_view`, profile, discover) are ported in. `HAGGLE_AUTH` is off by default. |
| 8 | `deal` input | **Combine both.** `date` and `quantity` are optional but required unless `ask[]` is given; live-demo's `ask`, `compare_by`, `payable_field`, `details`, `auto_follow_up`; main's `date_until`, `time`, `venue`, `budget_kind`, `preferences`, `dry_run` and name-string vendor choice. |
| 9 | Roster and discover | **Main** (Google Places discovery, contact states, `HAGGLE_DEMO_VENDORS`, named-vendor resolution, dry_run, setup blockers), with live-demo's `TEXT_VENDOR` expressed as a roster entry on the text/SMS channel. |
| 10 | Extraction schema | **Two-part (main)**: Core must succeed, Details may fail. Live-demo's new fields (`tax_status`, `tax_rate_percent`, `tax_evidence`, `answers`, `requirement_checks`) go in Details, never Core. Images are passed. |
| 11 | Requirement checks | **Live-demo + main fallback.** Claude's `requirement_checks` by id with evidence; arithmetic may veto; request facts count as accepted. Keyword rules, main's `requirement_answers` and main's "all-in computed from parts" exception are the fallback. |
| 12 | Follow-ups after a vague reply | **Live-demo's structure + main's asks.** One batched follow-up on the first-contact channel, with "quoted" shown right away. It also carries main's asks for unstated hard requirements, firm total and all-in total, plus main's `requirement_unknown` flag. Nothing is duplicated. |
| 13 | Phone negotiation | **Mixed.** The first call is quote-only and never mentions other businesses or prices (main). Counter rounds may place automatic counter calls (live-demo). `call_back` / `call_back_in_view` stay available. |
| 14 | Round cap | **2.** `negotiate` refuses beyond `MAX_ROUNDS = 2`. |
| 15 | Counter text | **Strategist + guards.** Main's strategist/planner text (buyer target asks, "about $X" for approximate quotes, firm-total request), plus live-demo's `textSent` guard and its "drop 'and requirements' when the cited quote isn't compliant" rule. The "best-price business isn't countered" note shows only when true. |
| 16 | Counter answers and rounds | **Live-demo's detection.** A quote's round is the countered round. Any reply after the counter counts as an answer, including scheduled or dropped calls and a grace period for a counter call in progress. Main's `basis_approximate` is kept on the steps. |
| 17 | Persona | **"AI assistant for <customer>" (live-demo)**, never "Haggle", across email, text, call and counters. Kept from main: venue, flexible dates, units. Kept from live-demo: the call read-back step. |
| 18 | RFQ builder | **`rfqEmail` (live-demo)** with retries and email→call escalation, plus main's `date_until`, `time` and `venue` folded in. |
| 19 | Approvability | Blocked: approximate totals (main) and unknown all-in totals (main). A non-money `compare_by` needs its answer (live-demo). Confirm-only approvals get **no** exemption: the same checks apply. |
| 20 | No deposit stated | **Pay the full total (`pay_now_basis`, main).** A $0 deposit is never shown; confirm-only is the way to pay nothing. |
| 21 | No `budget_usd` | **None (main).** The engine never invents a budget. |
| 22 | Unknown totals | **Unknown, never $0 (main).** Shown as "total not stated". |
| 23 | "All quotes are in" text | Recommends **the board's** value-ranked, approvable `recommended_quote_id`; no text if nothing is approvable. |
| 24 | Call-safety helpers | **Merged into one module** with the union of both behaviors; the others re-export it. |
| 25 | Migration 103 | **Kept as is.** |
| 26 | `inkbox-webhook-move.ts` | **Kept.** |
| 27 | Email approval | **Enabled (live-demo).** A coded APPROVE reply records approval; then `pay` (decision 2). |
| 28 | Negotiation window | **5 minutes.** |
| 29 | Silence about a requirement | **Both.** Live-demo's history-aware reading. Main's filter turns "no" into "unknown" only when no message in the conversation states the refusal. |
| 30 | `ANTHROPIC_API_KEY` | **Required in live mode (main).** |
| 31 | Server instructions and tool text | Both sides' texts are combined and rewritten to match these decisions. |
| 33 | Over a `budget_kind: "limit"` budget | **Soft everywhere.** The quote ranks lower with an "over your limit" caveat and can still be recommended, countered and approved. Nothing is excluded or blocked for being over the limit. |
| 34 | Approving without a total | **Always needs a total**, including requests compared on a non-money answer and confirm-only approvals. |
| 35 | Recommendation order | Meets the requirements, then unconfirmed requirement / missing answer / over budget, then refused requirement. Value order applies within each tier. |
| 36 | "Approved" text to the human | Sent on **every** approval (card, form, text, email): "approved, nothing charged until your assistant pays". |
| 37 | Human-authorized callback | Only allowed while the deal has a negotiation round left (`max_rounds`). |
| 38 | Recommendation over the payment ceiling | No "all quotes are in" text; the board shows why it can't be approved. |
| 39 | Board verdict | A ranked quote without caveats shows "compliant" even when it can't be approved yet; `approvable` / `approval_block` carry the reason. |
| 40 | Default `approve` action | "pay" (every approvable quote has a total, so there's always an amount to pay now); "confirm" only when the agent passes it. |
| 41 | Choosing before quotes are final | **Allowed (live-demo)**, with a warning in the confirm step ("quotes aren't final yet" / "a negotiation is still running"). |
| 42 | Confirm-only on the board | **No button on the board.** Confirm-only is available only to the agent through `approve(action: "confirm")`. |
| 43 | "Back to the deal board" link on the approval card | **Removed** (strictly one board per deal). |
| 44 | `views/deal-started` | **Deleted** (no tool binds it; `deal` uses `deal-live`). |
| 45 | Missed-webhook seller emails (backup sweep) | **Trust listed sellers.** Under `pinned-org-identity`, an email in the buyer's mailbox from a pinned roster/allowlist address counts as a same-org identity (same address check as the webhook path), even though an agent-scoped buyer key lists only the buyer. Other senders stay untrusted. |
| 46 | Text reply with no deal code, vendor in two live deals | Route it to the deal that has an unanswered question, counter or follow-up out to that vendor (newest ask first). If no deal is waiting, use the most recently texted deal. |
| 47 | Total computed by Haggle from stated parts | **No confirmation ask.** A total computed from stated parts (per-person × headcount + stated delivery/fees + stated tax rate) is trusted as firm. It doesn't hold collection, and nothing is sent to confirm it. Wording like "about $X" stays approximate. |
| 48 | Paying from the phone | **YES, then PAY.** A texted `YES <code>` approves. Haggle then texts "Approved. Reply PAY <code> to charge $X", and a texted `PAY <code>` from the approver's phone charges it. Board and card stay approve-then-pay. |
| 49 | Demo speed | A demo-speed switch (env, off by default) shortens Haggle's waits for a short video. Normal timings are unchanged when it's off. |
| 32 | Tests on the losing side | **Updated to the chosen behavior**, keeping each scenario's coverage. |

## Non-negotiable technical fixes (both owners already agree)
- A quote with no total is never stored as compliant (Postgres `quotes_check1`, fix 1218d0e).
