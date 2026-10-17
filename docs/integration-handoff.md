# Integration handoff: buyer side → seller side

From Yash (buyer) to Partner (seller). Status: **pre-event draft**. Nothing in §2–§4 is frozen
until you confirm it in the protocol section of `CONTRACTS.md`.

## 1. Files you must not change

`apps/mcp/`, `packages/core/`, `supabase/`, `fixtures/buyer/`, `scripts/verify-migrations.sh`,
`scripts/fixtures/`, buyer sections of `CONTRACTS.md`. Ask for changes; I'll make them.
I will not touch `apps/sellers/`, `apps/sell-cli/`, `apps/wall/`, `apps/raw-email-mcp/`.

## 2. What your seller replies must look like (PROPOSED)

- **Reply in-thread** to the RFQ (use Primitive reply so `In-Reply-To`/`References` point at
  our RFQ). The buyer only attaches an inbound message to a job when **all** hold:
  1. it was delivered to that job's inbox (`job-<id>@<buyer domain>`),
  2. its `In-Reply-To`/`References` contain a Message-ID we sent on that seller's thread,
  3. the From address is the seller address we sent the RFQ to.
  Anything else is quarantined (stored, not acted on).
- **Send from the exact address we emailed.** Payment binding uses that address and its
  domain. Primitive must report it authenticated (`analysis.sender.authenticated = true`,
  DMARC-aligned) for anything financial. Unauthenticated quotes are kept but flagged and
  cannot be paid.
- **Agent sellers** attach `quote.json` (`application/json`) — schema in
  `packages/core/src/protocol/quote-protocol.ts`. Amounts are decimal USD, ≤ 2 decimals.
  Use requirement ids from `rfq.json` in `meets`. Set `revision` (1, 2, …) and `round` when
  answering a `counter.json`. Include `valid_until`.
- **Human-style sellers** send plain text or a PDF; no JSON needed.
- **Questions**: just ask in the body (no JSON). We answer in-thread from job context or route
  to the buyer agent.
- **Declines**: say so in plain text; optional `quote.json` is not needed.

## 3. Payment challenge assumptions (PROPOSED)

- After we email "you won" for a specific quote, the winning seller issues
  `x402.createEmailChallenge({ from: <same seller address>, to: <job inbox>, amountUsdc: "<deposit>", network: "base-sepolia" })`
  **in the same thread**.
- Amount must equal the quoted `deposit_usd` (or total if no deposit). We refuse anything
  larger than the human-approved amount or the 5 USDC demo cap.
- We pay with `payEmailChallenge` and reply in-thread with `interaction.json`; Primitive
  replies with the `receipt` step (`settle_tx`).
- **Unconfirmed, test on day one:** both orgs use managed `*.primitive.email` subdomains — does
  Primitive's DKIM alignment rule for x402 accept that, or does each side need its own custom
  domain?

## 4. Questions needing agreement

1. Protocol amounts: decimal USD (current proposal) vs integer cents on the wire?
2. Do agent sellers ever send unsolicited revisions, or only in response to `counter.json`?
3. Does a seller challenge arrive only after our "won" email, or may it arrive with the quote?
   (We hold early challenges until approval either way.)
4. Market wall data: should we expose a read-only view (e.g. `public.wall_jobs`) of job
   progress, or will the wall read seller-side data only?
5. `rfq.json` `budget_hint_usd`: send it or not? (Default: not sent.)

## 5. Shared DB tables

Buyer tables are listed in `CONTRACTS.md` §1. They are service-role only (RLS, no policies);
the seller Function must not read or write them. Seller-side tables (personas, menus) are
yours to define in your own migration file with a distinct prefix (e.g. `seller_*`), reviewed
by me before merge so migrations don't collide.

## 6. Integration test steps (once both sides exist)

1. Buyer creates a job addressed to one seller-domain address.
2. Seller Function replies with `quote.json` in-thread.
3. Buyer `/inbound` receives it; `get_quotes` shows it with `source: quote_json`.
4. Repeat with the six benchmark personas; compare to `fixtures/buyer/scenarios/offsite-lunch.json`
   `expected_outcome`.
5. Payment: approve → seller issues 5 USDC challenge → buyer pays → receipt with `settle_tx`.

Buyer fixtures in `fixtures/buyer/emails/` show the exact message shapes the buyer expects;
they are test data, not seller implementations.

## 7. Blockers

- Neither org's Primitive credentials or x402 entitlements exist yet.
- Pre-event coding permission is unconfirmed; buyer product logic starts at kickoff.
