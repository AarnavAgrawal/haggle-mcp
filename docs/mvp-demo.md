# Haggle MVP demo: three vendors, one approval, one deposit

Owner: Yash (buyer side). Server: https://calm-spark-ck3qm.run.mcp-use.com/mcp (Manufact, `main`).
Status on 2026-10-17: everything below is built, tested and deployed with the live channels **off**.
The live three-vendor run has **not** been witnessed yet; until it is, the MVP isn't complete.

## The demo

One cold deal, three businesses, three channels, then a warm ask:

| Vendor | Channel | Played by | What happens |
|---|---|---|---|
| Email vendor (e.g. Harbor Table) | Email | Aarnav's seller persona (`apps/sellers`, same Inkbox org as the buyer) | Gets the RFQ from the buyer mailbox, replies in-thread with a quote (PDF or quote.json); signed webhook → quote |
| Text vendor | iMessage | A teammate's iPhone (owner: Aarnav, or a third teammate) | Gets a ≤159-char RFQ by iMessage, texts back a price; pinned number → quote |
| Voice vendor | Phone (Inkbox Voice AI) | Yash, answering his own phone | Haggle's Voice AI calls after `HAGGLE_CALL_DELAY_S`, says it's an AI assistant, asks for a quote and cites only real competing totals; transcript → quote |

Then Aarnav approves the best eligible quote **in Claude** (approval card), Haggle charges the deposit in
**Stripe test mode**, and a new `ask` for the same job returns an instant estimate from what the brain just learned.

## Manual setup (owners)

Do these once, in order. Secrets go into env files or the Manufact dashboard, never chat.

| # | Action | Owner | Why |
|---|---|---|---|
| 1 | Pick the buyer identity. **Recommended: `haggle-buyer`** (Aarnav's org: has the phone number and the same-org sellers). | Yash + Aarnav | `haggle` (Yash's org) can't call (no number), gets A2A 403, and can only trust same-org replies |
| 2 | Create an agent-scoped API key and a webhook signing secret for `haggle-buyer`; put them in `apps/mcp/.env` on Yash's machine (shared file/password manager, not chat). Confirm `haggle-buyer` has iMessage enabled. | Aarnav | Haggle acts as that identity |
| 3 | Subscribe `haggle-buyer`'s webhook to `https://calm-spark-ck3qm.run.mcp-use.com/webhooks/inkbox` for `message.received`, `call.ended`, `imessage.received`, `a2a.sent_task.updated` (`packages/engine/scripts/inkbox-channel-events.ts --confirm`). | Yash | Replies, transcripts, texts reach the server |
| 4 | Text vendor texts `connect @haggle-buyer` from their iPhone. Yash does the same from his phone (needed if the call goes out over the shared iMessage line). | Text vendor, Yash | Inkbox iMessage reaches humans only after they connect |
| 5 | Allowlist exactly: the email vendor address, the text vendor's number, Yash's number (`HAGGLE_ALLOWED_RECIPIENTS`, plus `HAGGLE_DEMO_FLEET` for the seller personas). Nothing else. | Yash (after authorization) | Haggle refuses any other recipient |
| 6 | Set on Manufact: `INKBOX_API_KEY` (secret), `INKBOX_IDENTITY=haggle-buyer`, `INKBOX_WEBHOOK_SECRET` (secret), `HAGGLE_ENABLE_CALLS=true`, `HAGGLE_ENABLE_IMESSAGE=true`, `HAGGLE_CALL_DELAY_S=60`, `HAGGLE_ENABLE_PAYMENTS=true`, `STRIPE_SECRET_KEY` (sk_test_, secret), `STRIPE_CUSTOMER_ID`, `STRIPE_PAYMENT_METHOD_ID`, `HAGGLE_GLOBAL_PAYMENT_CAP_CENTS` ≥ the expected deposit. Redeploy. Keep `HAGGLE_ALLOW_ANY_RECIPIENT` unset. | Yash (after authorization) | Turns the channels and test payments on |
| 7 | Run `apps/sellers` (`npm run dev -w @haggle/sellers`) so the email persona answers. | Aarnav | Email vendor |
| 8 | Add the server in Claude (claude.ai → connectors) for Aarnav, and in Claude Code for the driver. | Aarnav, Yash | Approval card renders in Claude |
| 9 | Optional (4th channel): A2A to Bay Catering works as-is from `haggle-buyer` (same org). From `haggle` it needs an admin allow rule. | Aarnav | Not needed for the three-vendor demo |

Costs: Inkbox Voice AI minutes for one ~2-minute call per run (per the Inkbox plan) and a few iMessages; Claude API
calls for quote extraction (cents per run); Stripe test mode is free and moves no money; Manufact unchanged.

Rollback: `HAGGLE_ENABLE_*=false` and redeploy, or redeploy deployment `ac0287bd` (f5d6699) from the Manufact dashboard.

## Rehearsal procedure (repeatable)

Before each run:

1. `scripts/acceptance/run.sh` (local gates: typecheck, 284 tests, build) passes.
2. `node scripts/acceptance/live-readonly.mjs https://calm-spark-ck3qm.run.mcp-use.com <known job> apps/mcp/.env` shows 21/21. It sends nothing.
3. Text vendor and Yash have phones on, unmuted, and are reachable; the seller persona is running.
4. Start a screen recording with audio (participants consent; the Voice AI says it's an AI assistant. Inkbox has no call-recording API, so the recording is ours).

The run (driver in Claude Code or Claude; Aarnav in Claude):

1. **Cold deal.** Prompt: "Get quotes for lunch catering for 40 on Oct 22 in San Francisco, at least 12 vegetarian, delivered, budget $1,200, from Harbor Table (`<email vendor address>`), `<text vendor name>` by iMessage at `<their number>`, and Mission Eats by phone at `<Yash's number>`." The agent calls `deal` with `businesses: [{name, email}, {name, phone, channel:"imessage"}, {name, phone}]`. Expect `contacted` = 3, `not_contacted` = 0.
2. **Deal board.** `open_haggle` / `get_quotes`: three cards (email, iMessage, phone) moving from contacted to quoted.
3. **Email quote** arrives within ~1 minute (signed webhook).
4. **Text vendor** replies, e.g. "$1,150 total, 14 veg, delivered, $100 deposit". Quote appears with source iMessage.
5. **Call** rings Yash about 60 s after the deal. Yash quotes, e.g. "$1,090, 12 vegetarian, delivery included, $100 deposit". On hang-up, `call.ended` → full transcript → quote with channel phone.
6. **Negotiation** (optional, if a round is due): the counter names only a real competing total.
7. **Approval.** The agent calls `approve` on the best eligible quote; Aarnav approves in the approval card in Claude. A headless client can't approve for him.
8. **Deposit.** `pay` with that approval → Stripe test-mode PaymentIntent → `receipt_url` on the board.
9. **Warm ask.** `ask` for the same job and area → instant estimates that include the vendors just learned (marked as estimates, not quotes).

Evidence to capture each run: the job id; screenshots of the board at 0/3, 3/3 and paid; the email thread; the iMessage
thread (phone numbers redacted); the call transcript from the board; the Stripe test-mode PaymentIntent id (dashboard,
test mode); the `ask` output; the recording. Redact phone numbers and never capture keys.

Pass criteria: three quotes from three channels on one board, each with provenance; approval recorded for that exact
quote by a human in Claude; one Stripe test-mode charge equal to the deposit with a receipt; the warm ask reflects the run.

## 3-minute runbook

| Time | Beat | On screen |
|---|---|---|
| 0:00–0:20 | Problem: small businesses sell by email, phone and text, not APIs. Haggle is an MCP server + app that turns those conversations into an API any agent can use. | Claude, `LIVE` badge on the board |
| 0:20–0:45 | One prompt → one `deal` call → three vendors on three channels | Progress line "0 of 3 businesses quoted · contacted by email, iMessage, phone" |
| 0:45–1:30 | Quotes land while you talk: email reply, iMessage text, then the Voice AI calls Yash on speaker (it says it's an AI) | Each card shows what the vendor said: "WROTE", "TEXTED", "ON THE CALL" |
| 1:30–2:00 | Why the winner wins: the green line ("Meets all 2 requirements · lowest total of 3 eligible quotes · $X under budget"); counteroffers cite only real quotes | Recommended row, counteroffer lines, can't-win reasons |
| 2:00–2:30 | Aarnav taps Approve; Claude shows the approval form only a human can answer; Pay; receipt | "Approved" → "$X deposit paid · Stripe test mode" → View receipt |
| 2:30–3:00 | The next agent asks again and gets an instant estimate learned from these conversations | Estimates view (`ask`) |

The vendors are teammates playing businesses; say so. The winner is whoever quotes the lowest total that meets every
requirement: ranking is computed, not scripted. If Yash wants the phone vendor to win, he quotes a lower eligible total
on the call than the others did; if he doesn't, the board will (correctly) pick someone else.

Pre-run the deal 10 minutes before going on stage, as a backup job, and keep its job id open in a tab.

## Fallbacks

1. **A channel fails live** (no call, text not delivered): carry on with the quotes that did arrive; open the
   backup job's board. Say which channel was replayed.
2. **Live server down:** run the mock server locally (`HAGGLE_MODE=mock`, six simulated sellers, `discover:true`).
   Every response is labelled `[DEMO]` and businesses are marked simulated; say so on stage. Mock never counts as live proof.
3. **Everything down:** play the recorded rehearsal video and walk through the screenshots.

## What is and isn't live today

| Capability | Live proof | Mock/tests |
|---|---|---|
| MCP server on Manufact, 15 tools, Claude Code | PASS (21/21 live read-only, 0.5.0+54b2d47) | PASS |
| Email RFQ → signed reply → quote | PASS (job_512a5d0265b144ed9337, $1,080) | PASS |
| Text/PDF extraction through Claude | not yet | PASS (fixtures) |
| iMessage vendor RFQ + reply | BLOCKED (setup 1–6) | PASS |
| Voice AI call → transcript → quote | BLOCKED (setup 1–6) | PASS |
| A2A task → quote | BLOCKED (403 on `haggle`; fine from `haggle-buyer`) | PASS |
| Negotiation citing real quotes | not yet | PASS |
| Approval in Claude (card) | not yet (needs Claude.ai) | PASS |
| iMessage approval `YES <code>` | BLOCKED (approver connect) | PASS |
| Payment refusals (no approval, self-approval, allowlist) | PASS | PASS |
| Stripe test-mode deposit + receipt | BLOCKED (authorization) | PASS |
| Brain persistence across restarts | PASS (Supabase, 6 profiles identical across redeploy) | PASS |
| Warm ask from live-learned data | not yet (needs a live deal) | PASS |
| Deal board in ChatGPT / Claude.ai | not yet (needs a human to add the connector) | PASS in the mcp-use Inspector (clicks driven by Playwright) |
| Deal board on the live server | PASS (renders job_512a5d0265b144ed9337, LIVE badge) | PASS |

## UI verification (mcp-use Inspector, mock server, real engine)

Driven with Playwright against `mcp-use start --with-inspector` (scripts in the session scratchpad; screenshots in
`docs/screenshots/mvp-*`; mock screenshots carry the DEMO badge):

| Check | Result |
|---|---|
| Launcher (`open_haggle`) with no deals | PASS: welcome + "Start a catering deal" / "Instant estimate" (was a crash: `Cannot read properties of null`) |
| Board with 1, 5 (one question open) and 6 quotes; light, dark, 380 px, fullscreen | PASS |
| Answer a business question in the board | PASS: sent in thread; the board updated by itself to the new quote and the next counteroffer round |
| Approve → human approval form (elicitation) → Pay → paid | PASS: server shows approval `used`, payment `settled`; label "Won", state "Paid" |
| Decline in the approval form | PASS: approval `declined`, quote stays approvable, "declined by the human" shown |
| Headless client approval | Live: NO_HUMAN_CHANNEL. Mock: labelled "Simulated (demo client, no human channel)" |
| Flagged business text (prompt injection) | Not echoed to the board or the model (e2e test) |
| Seed brain data | Says "sample quotes (seed data, not live)" (live screenshot) |

## Remaining defects, prioritized

1. **Not yet seen in Claude.ai or ChatGPT** (P1, human step): add the connector and run `open_haggle`; MCP Apps hosts can differ from the Inspector (fullscreen, follow-up messages, `openExternal` for receipts).
2. **Receipt link only in Stripe test mode with a real PaymentIntent** (P2): mock payments say "simulated, no money moved" and show no receipt, by design.
3. **Business profile history repeats near-identical rows** after many runs of the same deal (P3, Aarnav's brain): collapse to 5 rows hides most of it.
4. **Brain wording** (P3, Aarnav): `packages/brain` still writes "real quotes" for seed data and suggests `deal(businesses=['biz_…'])`; the MCP layer corrects both today.
5. **Benchmark not run** (P2, needs dashboard suites + $1/run + live sellers): `apps/bench/results/runs.csv` has no rows; no performance claims until it does.
