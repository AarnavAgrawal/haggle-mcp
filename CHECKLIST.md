# Haggle: Progress Checklist

Haggle is an MCP server and MCP App that lets any AI agent buy from businesses by email, phone calls and texts: it reaches each business on its channel through Inkbox, reads replies and call transcripts, negotiates, gets a human's yes and pays with Stripe, with a live deal board inside ChatGPT and Claude. Every conversation teaches it about that business, so the next agent gets an instant answer.

**Claude Code keeps this file updated** (rules in `CLAUDE.md` section 8). Before work: set "Now working on". After work: tick the item only if its "Done when" is fully met, update its status line, and add one log line. Edit only your own items. Specs: `CONTRACTS.md`. Plan: `PLAN.md`.

**Now working on:** Yash: live Inkbox round trip (hosted server live; waiting on the test seller identity), then Stripe test mode · Aarnav: —

**Gates:** 3 PM email deal end to end + deal board renders · 9 PM multi-channel deal + warm ask + approval + payment live on Manufact · 3 AM feature freeze · 9:45 AM submit

---

## Together (first hour)

- [ ] **Foundation:** monorepo, `contracts.ts` + `views.ts` schemas, view fixtures, database, Inkbox identities, both skills installed, MCP App scaffolded and running in the Inspector
  - Done when: `packages/core` types match `CONTRACTS.md` sections 1–3; one fixture per view in `fixtures/views/`; `haggle` + 6 seller identities exist on Inkbox; `npm run dev` serves `/mcp` and the Inspector lists the tools
  - Status: not started

## Yash: tools and deal engine

- [ ] **Inkbox migration:** replace the v3/v4 Primitive email and x402 payment code with the Inkbox adapter and Stripe; remove `PRIMITIVE_*` / x402 env vars from `.env.example`
  - Done when: no engine path imports `primitive*` or `x402*`; existing parsing and safety tests still pass against `fixtures/`
  - Status: in progress. The live MCP server no longer needs Primitive/x402 (payments disabled and refused, never faked; no x402 accept email). Legacy x402 code is still in the engine for mock mode until Stripe lands.
- [ ] **MCP server on Manufact:** all tools exposed (returning fixtures at first), deployed, callable from Claude Code
  - Done when: every tool in `CLAUDE.md` section 6 is listed and callable via `npx mcp-use client`; the Manufact URL is copied from the dashboard into the log
  - Status: deployed on Manufact (mock mode): https://calm-spark-ck3qm.run.mcp-use.com/mcp. All 11 tools verified through `mcp-use client`, locally and hosted (29/29 checks: deal → wait_for_update → get_quotes → answer_business, errors, retry idempotency, structuredContent). Now LIVE mode (Inkbox `haggle`, Supabase, Claude; calls/payments off; recipients = demo fleet only) and added to Claude Code (`claude mcp add --transport http haggle <url>`, Connected).
- [ ] **Email deal loop:** outreach, inbound webhook, parsing (text, PDF, JSON), replies feed the brain
  - Done when: `deal` emails the sellers from `haggle`; a signed `message.received` webhook becomes a `Quote`; `brain.learnFromReply` is called
  - Status: Inkbox adapter + `/webhooks/inkbox` built; route tests with fakes (401 bad signature, signed reply → quote, dedupe, 503 retry, call.ended). Live infra ready: Supabase migrations 100+101 applied (safety assertions pass on the live DB), Inkbox webhook subscription → hosted `/webhooks/inkbox` (unsigned → 401), sender trust `pinned-org-identity` for the agent-scoped key. Live round trip not yet demonstrated (needs a same-org seller identity).
- [ ] **Results:** `wait_for_update` and `get_quotes` return real deal board data
  - Done when: output validates against `DealBoard` and stays around 1,500 tokens for six quotes, with a `next` hint
  - Status: deal board read model returned by get_quotes/open_haggle (channels, statuses, eligibility, negotiation, questions); renders in the existing deal-board view (screenshot). Real engine data in mock mode; live data pending Inkbox.
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
  - Status: open_haggle({}), native settings and mentions registered; launcher entrypoints bind when `views/haggle-home` exists. Not tested in ChatGPT.
- [ ] **Agent polish:** helpful errors, Skill, `llms.txt`, publishing checks, works across clients
  - Status: not started

## Aarnav: views, brain, sellers, proof

- [ ] **Brain stub:** fake data for every brain function (first)
  - Done when: every `Brain` method in `contracts.ts` returns typed fixed data
  - Status: not started
- [ ] **Deal board view:** business cards with channel and live status, ranked quotes, flags, verdicts, actions, fullscreen
  - Done when: renders `fixtures/views/deal-board.json` in the Inspector, light and dark, inline (~400 px) and fullscreen; screenshot saved
  - Status: not started
- [ ] **Email sellers:** webhook server with email personas replying in character
  - Status: not started
- [ ] **Business learning:** every reply (any channel) updates a business profile
  - Status: not started
- [ ] **Phone and A2A sellers:** Voice AI persona answering calls; A2A agent-ready business
  - Done when: calling Mission Eats' number reaches the hosted-agent persona; Bay Catering serves an Agent Card and answers tasks
  - Status: not started
- [ ] **Brain features:** instant estimates, price check, negotiation hints, discovery with channels
  - Status: not started
- [ ] **Other views:** approval card, estimates, business profile
  - Status: not started
- [ ] **Benchmark:** baseline vs Haggle on Manufact test suites, plus a UI-judged run
  - Done when: 2–3 runs per arm in Claude Code and Codex, one UI run each in ChatGPT and Claude; measured numbers recorded
  - Status: not started

## Gates

- [ ] **3 PM:** a cold deal by email works end to end in Claude Code, and the deal board renders it in ChatGPT
- [ ] **9 PM:** multi-channel deal (email + call + A2A), warm ask, approval and payment, live on Manufact in ChatGPT, Claude and Claude Code
- [ ] **3 AM:** feature freeze (bug fixes only after this)

## Both: finish

- [ ] **Harden:** demo path bug-free, backup job pre-run, approver connected on iMessage, view screenshots saved
- [ ] **Demo prep:** backup video, 3 rehearsals, slides, submitted by 9:45 AM

---

## Blockers

- Yash: create the email-only test seller `haggle-test-seller` + its agent-scoped key (Inkbox dashboard) → live round trip.
- Team: Aarnav's seller identities are not visible in Yash's Inkbox org (his buyer is `haggle-buyer` in his org). Same-org sellers are required for reply trust: run apps/sellers setup in Yash's org, or agree on one org.
- Yash: ChatGPT test needs a human: add https://calm-spark-ck3qm.run.mcp-use.com/mcp as a developer-mode app in ChatGPT.
- Shared: `packages/core/views.ts` + contracts.ts v5 fields; proposal in `apps/mcp/src/schemas/views.ts` and `apps/mcp/README.md` (needs Aarnav's OK).
- Aarnav: seller Inkbox identities (email addresses for HAGGLE_DEMO_FLEET) → needed for the live email round trip.
- Aarnav, `views/deal-board/view.tsx`: (1) pipeline columns for v5 statuses (`contacted · ringing · on_call · quoted · negotiating · won · declined · no_reply · unavailable`); today the winner (`won`) and phone states don't appear; (2) channel badge per business (`businesses[].channel`); (3) call `answer_business` instead of `answer_seller`; (4) drop the "x402 · base-sepolia" strip and invoice steps (show `approval.status` + `payment.status`/`reason`); (5) poll `wait_for_update` with the cursor instead of `get_quotes` every 4 s.
- Aarnav: add `views/haggle-home/view.tsx` (`export { default } from "../deal-board/view";`). mcp-use 2.10 allows one tool per view, so `open_haggle` and the ChatGPT launcher bind only once this exists. Also `views/approval` (reads `_meta["haggle/approval"]`, calls `approve_in_view`), `views/estimates`, `views/business-profile`; each binds automatically.

## Log

_One line per finished task, newest first: `time · who · what changed`._

- 1:50 PM · Yash · Live infra: Supabase migrations applied + verified, Manufact switched to live (secrets set, redeployed), Inkbox webhook subscribed, Claude Code connected; pinned-org-identity trust for the agent-scoped key; fleet parser accepts bare addresses

- 12:55 PM · Yash · Synced main; MCP on Manufact (mock) with 11 tools verified via mcp-use client locally + hosted; live payer disabled (no Primitive/x402); email approval removed; webhook route tests; demo fixed
- 12:20 PM · Yash · v5 MCP tools on the real engine, Inkbox adapter + webhook, deal board data, channel routing (mock phone), settings/launcher/mentions; 186 unit + 6 transport tests, migrations verified (branch yashnil)
- 2026-10-17 · Yash · Docs aligned to v5: `CONTRACTS.md` rewritten for Inkbox + Stripe (Primitive/x402 removed), `PLAN.md` added, `CLAUDE.md` start-here guide, "Done when" criteria in this checklist
