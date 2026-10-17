# Haggle: Progress Checklist

Haggle is an MCP server and MCP App that lets any AI agent buy from businesses by email, phone calls and texts: it reaches each business on its channel, reads replies and call transcripts, negotiates, gets a human's yes and pays, with a live deal board inside ChatGPT and Claude. Every conversation teaches it about that business, so the next agent gets an instant answer.

**Claude Code keeps this file updated.** After finishing any piece of work: tick what's done, update the status line, update "Now working on", and add one line to the log. Keep it short.

**Now working on:** Yash: — · Aarnav: going live on Inkbox (seller setup) and checking views in ChatGPT/Claude

**Gates:** 3 PM email deal end to end + deal board renders · 9 PM multi-channel deal + warm ask + approval + payment live on Manufact · 3 AM feature freeze · 9:45 AM submit

---

## Together (first hour)

- [ ] **Foundation:** monorepo, `contracts.ts` + `views.ts` schemas, view fixtures, database, Inkbox identities, both skills installed, MCP App scaffolded and running in the Inspector
  - Status: Aarnav (on `aarnav`): npm-workspaces monorepo, `packages/core` contracts + view schemas (needs Yash's sign-off), view fixtures, MCP App scaffolded and rendering in the Inspector, mcp-use skill. Left: database (brain migration written, not applied), Inkbox identities (need `INKBOX_API_KEY`), Inkbox skill

## Yash: tools and deal engine

- [ ] **MCP server on Manufact:** all tools exposed (returning fixtures at first), deployed, callable from Claude Code
  - Status: not started
- [ ] **Email deal loop:** outreach, inbound webhook, parsing (text, PDF, JSON), replies feed the brain
  - Status: not started
- [ ] **Results:** `wait_for_update` and `get_quotes` return real deal board data
  - Status: not started
- [ ] **Phone calls:** Voice AI calls businesses; call transcripts become quotes
  - Status: not started
- [ ] **A2A:** agent-ready businesses get a task and return a structured quote
  - Status: not started
- [ ] **Conversation handling:** follow-ups (email, then call), answering business questions, one negotiation round
  - Status: not started
- [ ] **Approval and payment:** iMessage or in-view approval, then capped Stripe payment
  - Status: not started
- [ ] **ChatGPT app features:** launcher entrypoint, settings (cap, approver, area), mentions
  - Status: not started
- [ ] **Agent polish:** helpful errors, Skill, `llms.txt`, publishing checks, works across clients
  - Status: not started

## Aarnav: views, brain, sellers, proof

- [x] **Brain stub:** fake data for every brain function (first)
  - Status: done: `createStubBrain()` in `@haggle/brain`, tested against the contracts
- [ ] **Deal board view:** business cards with channel and live status, ranked quotes, flags, verdicts, actions, fullscreen
  - Status: built on fixtures (ladder vs budget, channel badges, live polling, answer question, approve, fullscreen, light/dark); screenshots in `apps/bench/screenshots`. Left: check in ChatGPT/Claude, real engine data
- [ ] **Email sellers:** webhook server with email personas replying in character
  - Status: built and tested offline (`apps/sellers`, Claude prose + number guard + templates, Harbor PDF, signed webhooks, demo speed). Left: `npm run setup` with `INKBOX_API_KEY`, live run
- [ ] **Business learning:** every reply (any channel) updates a business profile
  - Status: `brain.learnFromReply` built and tested (email, phone, A2A, questions, negotiation; Supabase/file/memory stores). Left: engine calls it after each parsed reply
- [ ] **Phone and A2A sellers:** Voice AI persona answering calls; A2A agent-ready business
  - Status: built (Mission Eats Voice AI instructions + number in setup; Bay Catering A2A skill, tasks answered with quote.json). Left: live setup and a real call
- [ ] **Brain features:** instant estimates, price check, negotiation hints, discovery with channels
  - Status: built and tested on seeded history; `ask`, `check_price`, `discover`, `business_profile` call the real brain. Left: verify from Claude Code
- [ ] **Other views:** approval card, estimates, business profile
  - Status: built on fixtures/brain data, screenshots saved. Left: check in ChatGPT/Claude
- [ ] **Benchmark:** baseline vs Haggle on Manufact test suites, plus a UI-judged run
  - Status: baseline MCP server, suite spec (`apps/bench/suites`), results summary script. Left: deploy baseline, create suites in the dashboard, run

## Gates

- [ ] **3 PM:** a cold deal by email works end to end in Claude Code, and the deal board renders it in ChatGPT
- [ ] **9 PM:** multi-channel deal (email + call + A2A), warm ask, approval and payment, live on Manufact in ChatGPT, Claude and Claude Code
- [ ] **3 AM:** feature freeze (bug fixes only after this)

## Both: finish

- [ ] **Harden:** demo path bug-free, backup job pre-run, approver connected on iMessage, view screenshots saved
- [ ] **Demo prep:** backup video, 3 rehearsals, slides, submitted by 9:45 AM

---

## Blockers

- Aarnav needs `INKBOX_API_KEY` (and `ANTHROPIC_API_KEY`) in `.env` to create seller identities and go live.
- Yash: please review `packages/core` (contracts + view schemas, on `aarnav`) and replace the fixture handlers in `apps/mcp/index.ts` with the engine.

## Log

_One line per finished task, newest first: `time · who · what changed`._

- 13:00 · Aarnav · bench: baseline MCP server, Manufact suite spec, results summary, view screenshots
- 12:55 · Aarnav · reply fixtures for every seller behavior (`fixtures/replies`, with expected ParsedReply)
- 12:50 · Aarnav · seller fleet: 6 personas, webhook server, Inkbox setup script, brain migration
- 12:40 · Aarnav · views: deal board, approval card, estimates, business profile (+ fixture-mode MCP server)
- 12:25 · Aarnav · brain stub + real brain (learning, estimates, price check, hints, discovery)
- 12:15 · Aarnav · foundation: monorepo, `packages/core` contracts + view schemas, view fixtures
