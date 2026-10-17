# Haggle: Progress Checklist

Haggle is an MCP server and MCP App that lets any AI agent buy from businesses by email, phone calls and texts: it reaches each business on its channel, reads replies and call transcripts, negotiates, gets a human's yes and pays, with a live deal board inside ChatGPT and Claude. Every conversation teaches it about that business, so the next agent gets an instant answer.

**Claude Code keeps this file updated.** After finishing any piece of work: tick what's done, update the status line, update "Now working on", and add one line to the log. Keep it short.

**Now working on:** Yash: — · Aarnav: —

**Gates:** 3 PM email deal end to end + deal board renders · 9 PM multi-channel deal + warm ask + approval + payment live on Manufact · 3 AM feature freeze · 9:45 AM submit

---

## Together (first hour)

- [ ] **Foundation:** monorepo, `contracts.ts` + `views.ts` schemas, view fixtures, database, Inkbox identities, both skills installed, MCP App scaffolded and running in the Inspector
  - Status: not started

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

_(none yet)_

## Log

_One line per finished task, newest first: `time · who · what changed`._
