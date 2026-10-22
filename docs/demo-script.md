# Demo script (verified functionality only)

Sprint 4, workstream E. Every step below is **MOCK MODE** (`HAGGLE_MODE=mock`): six simulated vendors,
simulated email / Voice AI call / A2A replies, a simulated human approval and a simulated Stripe charge.
Every response carries `mode: "mock"` and the text starts with `[DEMO]`; say so out loud. Each step is
covered by an automated test (named in the right column) that ran in this sprint; nothing here relies on
a live provider. A live-mode demo (real Inkbox, real vendors, manual payment) is **not** part of this
script: no live run is recorded as evidence yet (see `docs/eval-report.md`, "Live evidence").

## Setup (2 minutes)

```
npm run build -w @haggle/mcp
cd apps/mcp && HAGGLE_MODE=mock HAGGLE_SIM_DELAY_SCALE=0.2 PORT=3000 ./node_modules/.bin/mcp-use start
```
Connect a client to `http://localhost:3000/mcp` (Claude Code: `claude mcp add --transport http haggle http://localhost:3000/mcp`), or open the Inspector at `/mcp/inspector`.

## Script

| # | Say / do | What appears | Verified by |
| --- | --- | --- | --- |
| 1 | "Use Haggle to cater lunch for 40 people next Thursday in San Francisco, at least 12 vegetarian, delivery included, under $1,200." | The agent calls `deal` first; one deal board appears with six businesses on their channels (email, a phone call, A2A). | `apps/mcp/tests/journey.e2e.test.ts` (P0 journey) |
| 2 | Let it run. | Statuses move to quoted as replies land. Mission Eats is reached by a (simulated) Voice AI call; its quote comes from the call transcript and the board shows the snippet. | `apps/mcp/tests/mcp.e2e.test.ts` |
| 3 | Point at Sunset Kitchen. | It asked "Do you need plates and cutlery?"; the agent answers with `answer_business` (or the human does on the board). | `mcp.e2e.test.ts` (question answered once; a second answer is refused) |
| 4 | Point at QuickQuote Deli. | Its reply asked for payment by link and carried instructions to the AI: rejected, its words never shown, never approvable, the link never opened. | `mcp.e2e.test.ts`, `packages/engine/tests/evalCorpus.test.ts` (no fetches) |
| 5 | Point at Harbor Table and Golden Grill. | Harbor Table's deposit was on page 2 of its PDF (flag `hidden_deposit`); Golden Grill offers only 6 vegetarian meals (flagged, ranked lower, still choosable with a caveat). | `mcp.e2e.test.ts` |
| 6 | "Quotes are final." | Haggle ran one counteroffer round citing only a real competing quote: Bay Catering revised $1,150 → $995 and is recommended, with the reasons. | `mcp.e2e.test.ts`, `packages/engine/tests/evalCorpus.test.ts` (fleet: Bay Catering wins) |
| 7 | "Approve Bay Catering." | `approve` → approval card (Claude/ChatGPT), a form (Claude Code), or, in a client with neither, the simulated DEMO human. The model cannot approve by itself. | `mcp.e2e.test.ts` (simulated human in a headless client); `apps/mcp/tests/approvalText.test.ts` (live policy: only the approver's YES <code>) |
| 8 | "Pay the deposit." | `pay` charges the $5 deposit through the **simulated** Stripe rail (no money moves); the board shows paid (DEMO). | `mcp.e2e.test.ts` |
| 9 | Optional: new chat, "How's my catering order?" | `list_deals` then `get_quotes(job_id)` for that deal; an earlier deal is never shown as the answer to a new request. | `journey.e2e.test.ts` |

## Say this, not that

- Say "simulated vendors and a simulated payment" for every mock step. Don't say "it called a real caterer" or "it paid".
- Say "negotiates using only real competing quotes"; don't promise savings. In the demo the saving is $155 because a simulated vendor revised; real vendors may hold firm.
- Say "a human approves every purchase"; don't say "fully autonomous".
- For the pilot: "you pay the vendor directly; Haggle records the vendor's own confirmation of receipt". Haggle does not hold or move money in the pilot.
- Don't show `ask` estimates as quotes: they are estimates with a confidence and a quote count.

## Known demo caveats

- The simulated fleet's quotes carry a fixed `valid_until` of 2026-10-21 (`packages/engine/src/sim/fleet.ts`), so on any later date every demo quote shows as **stale** and approving it first re-confirms with the (simulated) vendor. The flow still completes (measured on 2026-10-22: approve → approved, pay → paid); expect the stale note on the board.
- In a client with no form and no app UI, step 7 uses the simulated human (labelled DEMO); on a live server only the approver's texted `YES <code>` approves.
