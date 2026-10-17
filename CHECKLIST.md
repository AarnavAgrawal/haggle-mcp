# Haggle: Progress Checklist

Haggle is an MCP server and MCP App that lets any AI agent buy from businesses by email, phone calls and texts: it reaches each business on its channel, reads replies and call transcripts, negotiates, gets a human's yes and pays, with a live deal board inside ChatGPT and Claude. Every conversation teaches it about that business, so the next agent gets an instant answer.

**Claude Code keeps this file updated.** After finishing any piece of work: tick what's done, update the status line, update "Now working on", and add one line to the log. Keep it short.

**Now working on:** Yash: live Inkbox round trip + Manufact deploy (needs credentials) · Aarnav: —

**Gates:** 3 PM email deal end to end + deal board renders · 9 PM multi-channel deal + warm ask + approval + payment live on Manufact · 3 AM feature freeze · 9:45 AM submit

---

## Together (first hour)

- [ ] **Foundation:** monorepo, `contracts.ts` + `views.ts` schemas, view fixtures, database, Inkbox identities, both skills installed, MCP App scaffolded and running in the Inspector
  - Status: not started

## Yash: tools and deal engine

- [ ] **MCP server on Manufact:** all tools exposed (returning fixtures at first), deployed, callable from Claude Code
  - Status: all 11 tools + settings + mentions registered on the real engine (mock mode); production build and HTTP transport tested. Not deployed yet (needs `mcp-use login`); not yet tried from Claude Code.
- [ ] **Email deal loop:** outreach, inbound webhook, parsing (text, PDF, JSON), replies feed the brain
  - Status: Inkbox adapter + `/webhooks/inkbox` built and tested with fakes (signature, threading, sender trust, PDF via signed URL, dedupe); brain.learnFromReply called after every parse. No live Inkbox round trip yet (no credentials).
- [ ] **Results:** `wait_for_update` and `get_quotes` return real deal board data
  - Status: deal board read model returned by get_quotes/open_haggle (channels, statuses, eligibility, negotiation, questions); renders in the existing deal-board view (screenshot). Real engine data in mock mode; live data pending Inkbox.
- [ ] **Phone calls:** Voice AI calls businesses; call transcripts become quotes
  - Status: routing, ingestCall and transcript parsing done; simulated call in mock mode. Live Inkbox port built but off (HAGGLE_ENABLE_CALLS) pending approval.
- [ ] **A2A:** agent-ready businesses get a task and return a structured quote
  - Status: not started
- [ ] **Conversation handling:** follow-ups (email, then call), answering business questions, one negotiation round
  - Status: email follow-up, answer_business and one honest negotiation round work (mock). Email→call escalation not built.
- [ ] **Approval and payment:** iMessage or in-view approval, then capped Stripe payment
  - Status: in-view approval (app-only tool + view-only code), form and email approval done; payment is still the v3 x402 path (simulated in mock). iMessage and Stripe not built.
- [ ] **ChatGPT app features:** launcher entrypoint, settings (cap, approver, area), mentions
  - Status: open_haggle({}), native settings and mentions registered; launcher entrypoints bind when `views/haggle-home` exists. Not tested in ChatGPT.
- [ ] **Agent polish:** helpful errors, Skill, `llms.txt`, publishing checks, works across clients
  - Status: not started

## Aarnav: views, brain, sellers, proof

- [ ] **Brain stub:** fake data for every brain function (first)
  - Status: not started
- [ ] **Deal board view:** business cards with channel and live status, ranked quotes, flags, verdicts, actions, fullscreen
  - Status: not started
- [ ] **Email sellers:** webhook server with email personas replying in character
  - Status: not started
- [ ] **Business learning:** every reply (any channel) updates a business profile
  - Status: not started
- [ ] **Phone and A2A sellers:** Voice AI persona answering calls; A2A agent-ready business
  - Status: not started
- [ ] **Brain features:** instant estimates, price check, negotiation hints, discovery with channels
  - Status: not started
- [ ] **Other views:** approval card, estimates, business profile
  - Status: not started
- [ ] **Benchmark:** baseline vs Haggle on Manufact test suites, plus a UI-judged run
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

- Yash: Inkbox API key + `haggle` identity signing key, Supabase DB URL, Anthropic key → live email loop (from Yash/team).
- Yash: `npx mcp-use login` → Manufact deploy (from Yash).
- Shared: `packages/core/views.ts` + contracts.ts v5 fields; proposal in `apps/mcp/src/schemas/views.ts` and `apps/mcp/README.md` (needs Aarnav's OK).
- Aarnav: seller Inkbox identities (email addresses for HAGGLE_DEMO_FLEET); views/approval, estimates, business-profile, haggle-home; deal-board → answer_business.

## Log

_One line per finished task, newest first: `time · who · what changed`._

- 12:20 PM · Yash · v5 MCP tools on the real engine, Inkbox adapter + webhook, deal board data, channel routing (mock phone), settings/launcher/mentions; 186 unit + 6 transport tests, migrations verified (branch yashnil)
