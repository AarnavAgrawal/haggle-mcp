# Haggle: Progress Checklist

Haggle is an MCP server and MCP App that lets any AI agent buy from businesses by email, phone calls and texts: it reaches each business on its channel through Inkbox, reads replies and call transcripts, negotiates, gets a human's yes and pays with Stripe, with a live deal board inside ChatGPT and Claude. Every conversation teaches it about that business, so the next agent gets an instant answer.

**Claude Code keeps this file updated** (rules in `CLAUDE.md` section 8). Before work: set "Now working on". After work: tick the item only if its "Done when" is fully met, update its status line, and add one log line. Edit only your own items. Specs: `CONTRACTS.md`. Plan: `PLAN.md`.

**Now working on:** Yash: ChatGPT render of the live board (needs a human to add the app), then Stripe test mode · Aarnav: going live on Inkbox (seller setup) and checking views in ChatGPT/Claude

**Gates:** 3 PM email deal end to end + deal board renders · 9 PM multi-channel deal + warm ask + approval + payment live on Manufact · 3 AM feature freeze · 9:45 AM submit

---

## Together (first hour)

- [ ] **Foundation:** monorepo, `contracts.ts` + `views.ts` schemas, view fixtures, database, Inkbox identities, both skills installed, MCP App scaffolded and running in the Inspector
  - Done when: `packages/core` types match `CONTRACTS.md` sections 1–3; one fixture per view in `fixtures/views/`; `haggle` + 6 seller identities exist on Inkbox; `npm run dev` serves `/mcp` and the Inspector lists the tools
  - Status: integrated on `integrate/v5`: one npm-workspaces monorepo; `packages/core` v5 (Aarnav's contracts + view schemas plus the engine's agreed optional fields, CONTRACT_VERSION haggle.contracts/5); view fixtures; engine migrations applied on live Supabase. Left: brain migration 200 not applied live; sellers are in Aarnav's Inkbox org, buyer `haggle` in Yash's (see Blockers)

## Yash: tools and deal engine

- [ ] **Inkbox migration:** replace the v3/v4 Primitive email and x402 payment code with the Inkbox adapter and Stripe; remove `PRIMITIVE_*` / x402 env vars from `.env.example`
  - Done when: no engine path imports `primitive*` or `x402*`; existing parsing and safety tests still pass against `fixtures/`
  - Status: in progress. The live MCP server no longer needs Primitive/x402 (payments disabled and refused, never faked; no x402 accept email). Legacy x402 code is still in the engine for mock mode until Stripe lands.
- [x] **MCP server on Manufact:** all tools exposed (returning fixtures at first), deployed, callable from Claude Code
  - Done when: every tool in `CLAUDE.md` section 6 is listed and callable via `npx mcp-use client`; the Manufact URL is copied from the dashboard into the log
  - Status: deployed on Manufact (mock mode): https://calm-spark-ck3qm.run.mcp-use.com/mcp. All 11 tools verified through `mcp-use client`, locally and hosted (29/29 checks: deal → wait_for_update → get_quotes → answer_business, errors, retry idempotency, structuredContent). Now LIVE mode (Inkbox `haggle`, Supabase, Claude; calls/payments off; recipients = demo fleet only) and added to Claude Code (`claude mcp add --transport http haggle <url>`, Connected).
- [ ] **Email deal loop:** outreach, inbound webhook, parsing (text, PDF, JSON), replies feed the brain
  - Done when: `deal` emails the sellers from `haggle`; a signed `message.received` webhook becomes a `Quote`; `brain.learnFromReply` is called
  - Status: Inkbox adapter + `/webhooks/inkbox` built; route tests with fakes (401 bad signature, signed reply → quote, dedupe, 503 retry, call.ended). Live infra ready: Supabase migrations 100+101 applied (safety assertions pass on the live DB), Inkbox webhook subscription → hosted `/webhooks/inkbox` (unsigned → 401), sender trust `pinned-org-identity` for the agent-scoped key. LIVE ROUND TRIP DONE (job_512a5d0265b144ed9337): hosted `deal` → RFQ from haggle@inkboxmail.com → simulated seller `haggle-test-seller` replied in thread → signed webhook (stored) → quote $1,080 persisted (quote.json, trust inkbox-org-identity) → wait_for_update/get_quotes via MCP client and Claude Code. Not yet live: text/PDF parsing through Claude. On `integrate/v5` the engine calls the real brain (`learnFromReply` via BrainAdapter); not yet deployed.
- [ ] **Results:** `wait_for_update` and `get_quotes` return real deal board data
  - Done when: output validates against `DealBoard` and stays around 1,500 tokens for six quotes, with a `next` hint
  - Status: deal board read model returned by get_quotes/open_haggle (channels, statuses, eligibility, negotiation, questions); renders in the existing deal-board view (screenshot). Live board validated against DealBoard on the hosted server (1 quote, mode live, bound to deal-board). Six-quote size not yet measured live.
- [ ] **Phone calls:** Voice AI calls businesses; call transcripts become quotes
  - Done when: `placeCall` with a `reason` that says it's an AI assistant; `call.ended` transcript becomes a `Quote` with `channel: "phone"`; `503` is retried
  - Status: routing, ingestCall and transcript parsing done; simulated call in mock mode. Live Inkbox port built but off (HAGGLE_ENABLE_CALLS) pending approval.
- [ ] **A2A:** agent-ready businesses get a task and return a structured quote
  - Done when: Bay Catering's Agent Card gets a task and its result becomes a `Quote` with `channel: "a2a"`
  - Status: not started
- [ ] **Conversation handling:** follow-ups (email, then call), answering business questions, one negotiation round
  - Done when: unanswered email triggers a call; `answer_business` replies in-thread; a counter cites a real competing quote
  - Status: email follow-up, answer_business and one honest negotiation round work (mock). Email→call escalation not built.
- [ ] **Approval and payment:** iMessage or in-view approval, then capped Stripe payment
  - Done when: `pay` refuses without a stored approval for that exact quote, over the cap, or to a non-quoting payee; a test-mode charge returns a `receipt_url`
  - Status: approval by client form or approval card (email approval removed: Inkbox can't verify outside senders). Live payments disabled until Stripe; mock still simulates x402. iMessage and Stripe not built; x402-sized caps in 100_engine_core.sql need a Stripe migration.
- [ ] **ChatGPT app features:** launcher entrypoint, settings (cap, approver, area), mentions
  - Status: open_haggle({}), native settings and mentions registered; launcher entrypoints bound to Aarnav's `views/launcher` on `integrate/v5`. Not tested in ChatGPT.
- [ ] **Agent polish:** helpful errors, Skill, `llms.txt`, publishing checks, works across clients
  - Status: not started

## Aarnav: views, brain, sellers, proof

- [x] **Brain stub:** fake data for every brain function (first)
  - Status: done: `createStubBrain()` in `@haggle/brain`, tested against the contracts
- [ ] **Deal board view:** business cards with channel and live status, ranked quotes, flags, verdicts, actions, fullscreen
  - Status: built on fixtures (ladder vs budget, channel badges, live polling, answer question, approve, fullscreen, light/dark); screenshots in `apps/bench/screenshots`. Left: check in ChatGPT/Claude, real engine data
- [x] **Email sellers:** webhook server with email personas replying in character
  - Status: done, verified live on Inkbox from `haggle-buyer`: Golden Grill (6 veg), Harbor Table (PDF, deposit on p2), Sunset Kitchen (plates question → quote in the same thread), QuickQuote Deli (pay-now bait), Bay Catering (email + quote.json). Run: `npm run dev -w @haggle/sellers`
- [ ] **Business learning:** every reply (any channel) updates a business profile
  - Status: `brain.learnFromReply` built and tested (email, phone, A2A, questions, negotiation; Supabase/file/memory stores). Left: engine calls it after each parsed reply
- [ ] **Phone and A2A sellers:** Voice AI persona answering calls; A2A agent-ready business
  - Done when: calling Mission Eats' number reaches the hosted-agent persona; Bay Catering serves an Agent Card and answers tasks
  - Status: A2A verified live (buyer task → Bay Catering completed in 7 s with quote.json). Mission Eats = Aarnav's cell for the demo; Voice AI persona configured but needs a 2nd Inkbox number. Left: 2nd number, first real call
- [ ] **Brain features:** instant estimates, price check, negotiation hints, discovery with channels
  - Status: built and tested; `ask`, `check_price`, `discover` (real seller addresses), `business_profile` verified through the mcp-use MCP client. Left: run on Yash's contract/engine, check from Claude Code
- [ ] **Other views:** approval card, estimates, business profile
  - Status: built on fixtures/brain data, screenshots saved. Left: check in ChatGPT/Claude
- [ ] **Benchmark:** baseline vs Haggle on Manufact test suites, plus a UI-judged run
  - Done when: 2–3 runs per arm in Claude Code and Codex, one UI run each in ChatGPT and Claude; measured numbers recorded
  - Status: baseline MCP server verified live (own identity `haggle-baseline`: send → wait → list → read a real seller reply), suite spec, results summary. Left: deploy baseline to Manufact, create suites in the dashboard, run once the Haggle flow works

## Gates

- [ ] **3 PM:** a cold deal by email works end to end in Claude Code, and the deal board renders it in ChatGPT
- [ ] **9 PM:** multi-channel deal (email + call + A2A), warm ask, approval and payment, live on Manufact in ChatGPT, Claude and Claude Code
- [ ] **3 AM:** feature freeze (bug fixes only after this)

## Both: finish

- [ ] **Harden:** demo path bug-free, backup job pre-run, approver connected on iMessage, view screenshots saved
- [ ] **Demo prep:** backup video, 3 rehearsals, slides, submitted by 9:45 AM

---

## Blockers

- Yash: ChatGPT check needs a human: add https://calm-spark-ck3qm.run.mcp-use.com/mcp as a developer-mode app, then `get_quotes job_id=job_512a5d0265b144ed9337`.
- Team: one Inkbox org. The buyer `haggle` (Yash's agent-scoped key) is in Yash's org; Aarnav's sellers and `haggle-buyer` (+ the one phone number) are in Aarnav's. Same-org sellers are required for pinned-org reply trust: run `apps/sellers` setup in Yash's org, or move the buyer.
- Inkbox plan allows 1 phone number (on `haggle-buyer`, Aarnav's org). Mission Eats is played by Aarnav on his cell (`MISSION_EATS_PHONE`). Ask Inkbox for a 2nd number so the Voice AI persona can answer unattended benchmark runs.
- Before redeploying Manufact from `integrate/v5`/`main`: apply `supabase/migrations/200_brain_profiles.sql` on the live DB (the brain uses Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set), or set `HAGGLE_BRAIN_STORE=memory`/`HAGGLE_BRAIN_FILE`.
- Payments: the engine's payment cap is still x402-sized ($5, `HAGGLE_GLOBAL_PAYMENT_CAP_CENTS` + 100_engine_core.sql), so real deposits (e.g. Harbor $300) are refused `over_cap` until the Stripe migration.
- Shared, open decision D8: mock mode's `simulated` approval channel (headless client, DEMO only) isn't in `Approval.channel`; `apps/mcp/src/views.ts` extends the schema for it until both agree.

## Log

_One line per finished task, newest first: `time · who · what changed`._

- 2:45 PM · Yash · `integrate/v5`: yashnil + aarnav merged on one v5 core (agreed reconciliation), npm workspaces; engine teaches the real brain through `BrainAdapter` (directory ids, trusted senders only); view tools return the shared schemas; approval card/deal board approve via `approve_in_view`; x402 test fixtures no longer expire; 250 tests pass; cold deal + warm ask verified through the mcp-use client, deal board and estimates screenshots
- 2:10 PM · Yash · Live Inkbox email round trip on Manufact: deal → RFQ → signed reply webhook → persisted quote → get_quotes/wait_for_update from MCP client + Claude Code (job_512a5d0265b144ed9337)
- 14:05 · Aarnav · live on Inkbox: all email sellers + Bay Catering A2A verified end to end; seller tunnel and A2A reply fixed; baseline verified live; brain tools via MCP client
- 1:50 PM · Yash · Live infra: Supabase migrations applied + verified, Manufact switched to live (secrets set, redeployed), Inkbox webhook subscribed, Claude Code connected; pinned-org-identity trust for the agent-scoped key; fleet parser accepts bare addresses
- 13:30 · Aarnav · buyer identity `haggle-buyer` holds the one phone number; Mission Eats = Aarnav's cell for the demo
- 13:00 · Aarnav · bench: baseline MCP server, Manufact suite spec, results summary, view screenshots
- 12:55 PM · Yash · Synced main; MCP on Manufact (mock) with 11 tools verified via mcp-use client locally + hosted; live payer disabled (no Primitive/x402); email approval removed; webhook route tests; demo fixed
- 12:55 · Aarnav · reply fixtures for every seller behavior (`fixtures/replies`, with expected ParsedReply)
- 12:50 · Aarnav · seller fleet: 6 personas, webhook server, Inkbox setup script, brain migration
- 12:40 · Aarnav · views: deal board, approval card, estimates, business profile (+ fixture-mode MCP server)
- 12:25 · Aarnav · brain stub + real brain (learning, estimates, price check, hints, discovery)
- 12:20 PM · Yash · v5 MCP tools on the real engine, Inkbox adapter + webhook, deal board data, channel routing (mock phone), settings/launcher/mentions; 186 unit + 6 transport tests, migrations verified (branch yashnil)
- 12:15 · Aarnav · foundation: monorepo, `packages/core` contracts + view schemas, view fixtures
- 2026-10-17 · Yash · Docs aligned to v5: `CONTRACTS.md` rewritten for Inkbox + Stripe (Primitive/x402 removed), `PLAN.md` added, `CLAUDE.md` start-here guide, "Done when" criteria in this checklist
