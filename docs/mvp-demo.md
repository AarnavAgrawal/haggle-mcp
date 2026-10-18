# Haggle: first complete live demo

Server: https://calm-spark-ck3qm.run.mcp-use.com/mcp (Manufact `calm-spark`, buyer identity `haggle` in Yash's
Inkbox org). Status 2026-10-18: build 39c4782+, calls and iMessage on, payments off, three allowed recipients.
Rollback: Manufact deployment `6182e76a` (0c22c28), or set `HAGGLE_ENABLE_*=false` and restart.

Mock results (`[DEMO]`, `HAGGLE_MODE=mock`) are rehearsal only and never count as live evidence.

## Scenario

Aarnav, in Claude.ai: "Use Haggle to help me plan a hackathon that I need to cater for that has 200 people next
Saturday at the YC HQ in San Francisco, 40 vegetarian. No preference for cuisine, budget under 5k."

Claude calls `deal` first (verified with real Claude against the hosted server). It sends 200 people, Saturday
2026-10-24 (time if given), the YC venue, the 40-vegetarian requirement and `budget_usd: 5000`. The deal board
opens immediately and updates itself.

## Demo vendors (controlled, clearly labelled)

The roster is `HAGGLE_DEMO_VENDORS` on Manufact. Setting a contact there authorizes it as a recipient, and from
then on any `deal` contacts it. `discover` shows each vendor's readiness and the exact fix for anything not ready.

| Vendor | Channel | Route on calm-spark | State |
|---|---|---|---|
| Mission Eats | Voice AI phone | Yash's iPhone (connected to @haggle) | Ready once configured (call PASS live) |
| Sunset Kitchen | iMessage | a second iPhone (Aarnav or a teammate) | Needs: number, `connect @haggle`, one text to the assigned line |
| Harbor Table | email | `haggle-test-seller@inkboxmail.com` (same org, trusted) | Ready once configured; someone replies from the Inkbox console |
| Bay Catering / Golden Grill / QuickQuote Deli | email or A2A | need same-org identities in Yash's Inkbox org | Shown as "setup needed" until created |

The same phone can't play two vendors in one deal (the second is shown as blocked).

## Setup checklist (owners)

1. **Yash (authorization):** approve the roster above. Claude Code then sets `HAGGLE_DEMO_VENDORS`
   (e.g. `{"mission_eats":{"phone":"+1408…"},"harbor_table":{"email":"haggle-test-seller@inkboxmail.com"},"sunset_kitchen":{"phone":"+1…","channel":"imessage"}}`)
   and adds any new number to `HAGGLE_ALLOWED_RECIPIENTS`, then restarts.
2. **Text vendor:** from that iPhone, text `connect @haggle` to the router (+1 557-234-1193). Then send one blue
   iMessage, from the phone number and not the Apple ID email, to the line Inkbox assigns (Yash's was +1 281-570-5692).
3. **Optional, Yash:** create `bay-catering-yc`, `golden-grill-yc` and `quickquote-deli-yc` identities in his Inkbox
   org (dashboard). Teammates reply from the console, or run `apps/sellers` with that org's admin key.
4. **Payments (authorization):** set `STRIPE_SECRET_KEY` (sk_test_ only), `STRIPE_CUSTOMER_ID`,
   `STRIPE_PAYMENT_METHOD_ID` and `HAGGLE_ENABLE_PAYMENTS=true` on Manufact, then restart. Run
   `packages/engine/scripts/stripe-setup.ts` for the test customer and card.
5. **Aarnav:** Claude.ai → Settings → Connectors → add custom connector
   `https://calm-spark-ck3qm.run.mcp-use.com/mcp`.

## Run (about 5 minutes)

1. Aarnav sends the prompt. The board shows the request (date, time, venue, budget, payment ceiling) and every
   vendor's channel.
2. Quotes land: Harbor Table by email, Sunset Kitchen by text, Mission Eats by the Voice AI call (Yash answers).
   Each card shows what the vendor said and where it came from.
3. If a cheaper eligible quote exists than Mission Eats', the board offers "Call Mission Eats back". Aarnav taps it
   (a human authorizes it). The AI calls again and cites only that real total, and the new price shows as
   negotiated in the history.
4. The recommended quote says why (best value: price, completeness, terms, reputation when available), and every
   other quote says why not. Quotes that are over budget or missing a confirmed requirement stay approvable with
   caveats. Scams never are.
5. Aarnav taps Approve, then Pay deposit (Stripe test mode, only after step 4 of the setup). The board shows
   "deposit paid · Stripe test mode" and a receipt link. Paying again returns the same payment, never a second charge.
6. A new chat asks `ask` for the same order and gets an instant estimate learned from these quotes, labelled
   as estimates.

Evidence to keep: job id, board screenshots (start, quotes, paid), the email thread, the iMessage thread (numbers
redacted), the call transcript on the board, the Stripe test PaymentIntent id, and the `ask` output.

## Status (calm-spark ac3095a, 2026-10-18)

Full requirement-by-requirement matrix: `docs/traceability.md`.

LIVE PASS = seen on the hosted server with real channels; AUTOMATED = hosted read-only acceptance script;
MOCK/TEST = local tests or the mock server; BLOCKED = waiting on a person or an authorization.

| Capability | Status | Evidence |
|---|---|---|
| Voice AI call → transcript → quote | LIVE PASS | job_8eebfe8012ff43a2bf0a, job_dec51a570667400eae64 |
| RCS (Android) two-way + one confirming question | LIVE PASS | job_dec51a570667400eae64 |
| Email RFQ → signed reply → quote | LIVE PASS | job_dec51a570667400eae64 (Harbor $6,883.57) |
| Matching/trust by call id, pinned number, thread; Supabase persistence; restarts | LIVE PASS | that job survived 8 deploys/restarts, no duplicate outreach |
| Claude.ai: deal started, board rendered + polled, approval card tapped | LIVE PASS | deployment logs (claude-ai client) |
| Stale approval never charged | LIVE PASS | ap_32e2d549… revoked (recorded total omitted disclosed $250 delivery) |
| Stripe test mode enabled; payment guards | LIVE PASS (config) | live_ready payments=stripe-test; pay w/o approval refused |
| All-in gate, fee/terms, revisions void approvals, stages | MOCK/TEST | 372 tests + 253 on Postgres; simulated purchase over MCP with restarts 1/1 |
| Target vs hard budget, Claude strategist, bounded counters | MOCK/TEST + real-Claude dry run | an accepted live counter not yet witnessed |
| Stripe test charge + hosted receipt | BLOCKED | one charge, after a fresh human approval |
| Fresh Claude.ai purchase end to end | BLOCKED | needs Yash + Aarnav |

