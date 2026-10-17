# Integration handoff: engine (Yash) ⇄ brain, fleet, bench (Partner)

Contract: `packages/core/contracts.ts` **v1, frozen** (`5fd58c7`). The engine talks to the brain only
through `Brain`, and to sellers only by email. Nothing in Partner's folders was modified.
quote-broker code was reused with Partner's permission; every adapted file names its source
(`AarnavAgrawal/quote-broker@8a68559`).

## 1. Brain (`packages/brain`, Partner)

Publish a workspace package `@haggle/brain` exporting a class or factory that implements
`Brain` from `@haggle/core/contracts`. Until then the engine uses `StubBrain`
(`packages/engine/src/brain/stubBrain.ts`), which returns honest empty answers and learns nothing.

What the engine sends you:
- `learnFromReply(businessId, parsed, meta)` after **every** parsed, authenticated reply. `parsed.items`
  holds a `quote` (contract `Quote` without id/status) and/or `question`, `decline`, `payment_request`.
  `meta` has `rfq_sent_at`, `received_at`, `channel`, `sender_trusted`, `request`, `simulated`.
  Brain failures are logged and never block a deal.
- `checkPrice(...)` for each priced quote in `get_quotes` (an `unknown` verdict is omitted).
- `estimate(request)` for `ask`; `discover(category, area, count)` for `discover` and `deal(discover: true)`.
- `negotiationHints` is not called yet (the counteroffer cites the best real quote).

Swap-in point (one line each): `apps/mcp/src/live.ts` and `packages/engine/src/mock.ts`
(`brain: new StubBrain(...)` → your brain). `business_id` = `businessIdFor(email)` (D5).

## 2. Seller fleet (`apps/sellers`, Partner)

Your Function must, per persona:
- reply **from the address we emailed** (the engine trusts only that pinned address, checked with
  `isTrustedSender` on DKIM/DMARC) and **in the RFQ thread**, to the job inbox `job-<code>@brave-dog.primitive.email`;
- Bay Catering: attach `quote.json` (`haggle: "quote/1"`, `job_id` from our `rfq.json`, `total_usd`,
  `deposit_usd: 5`, `requirements_met` using our requirement ids, `valid_until`); on our `counter.json`,
  reply with a revised `quote.json` (`revision_of`); on our `accept.json`, call `createEmailChallenge`
  (5 USDC, base-sepolia, `to` = the job inbox) in the same thread;
- Harbor Table: a PDF with the deposit on page 2;
- Mission Eats: a vague first reply, an exact total after our follow-up;
- Golden Grill: 6 of 12 vegetarian; Sunset Kitchen: ask "need plates?" first; QuickQuote Deli: a payment link.

The engine-side simulated fleet (`packages/engine/src/sim/fleet.ts`, mock mode only) shows the exact
behaviour and the PROPOSED numbers; replace them with yours.

## 3. Bench (`apps/bench`, Partner)

Point the Manufact suites at the deployed MCP URL (after the preview deploy). Nine tools:
`ask, discover, check_price, deal, wait_for_update, get_quotes, answer_seller, approve, pay`.
The server ships `skill://haggle/SKILL.md`. Mock mode (`HAGGLE_MODE=mock`) is deterministic for local runs.

## 4. Open shared items

- Root `CLAUDE.md` still says `sender_verified` and lists 8 tools; the agreed wording (D1, D6) is in
  `docs/v3-prekickoff-readiness.md` §6. Your uncommitted edit of `CLAUDE.md` is untouched.
- `CONTRACTS.md` is v2 and superseded by `packages/core/contracts.ts`.
- `fixtures/buyer/` (Pass 1, v2 persona names) lives in your folder; adopt, rename or remove.
