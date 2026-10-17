# Haggle: Progress Checklist

Haggle is an MCP server and MCP App that lets any AI agent buy from businesses by email, phone calls and texts: it reaches each business on its channel through Inkbox, reads replies and call transcripts, negotiates, gets a human's yes and pays with Stripe, with a live deal board inside ChatGPT and Claude. Every conversation teaches it about that business, so the next agent gets an instant answer.

**Claude Code keeps this file updated** (rules in `CLAUDE.md` section 8). Before work: set "Now working on". After work: tick the item only if its "Done when" is fully met, update its status line, and add one log line. Edit only your own items. Specs: `CONTRACTS.md`. Plan: `PLAN.md`.

**Now working on:** Yash: — · Aarnav: —

**Gates:** 3 PM email deal end to end + deal board renders · 9 PM multi-channel deal + warm ask + approval + payment live on Manufact · 3 AM feature freeze · 9:45 AM submit

---

## Together (first hour)

- [ ] **Foundation:** monorepo, `contracts.ts` + `views.ts` schemas, view fixtures, database, Inkbox identities, both skills installed, MCP App scaffolded and running in the Inspector
  - Done when: `packages/core` types match `CONTRACTS.md` sections 1–3; one fixture per view in `fixtures/views/`; `haggle` + 6 seller identities exist on Inkbox; `npm run dev` serves `/mcp` and the Inspector lists the tools
  - Status: not started

## Yash: tools and deal engine

- [ ] **Inkbox migration:** replace the v3/v4 Primitive email and x402 payment code with the Inkbox adapter and Stripe; remove `PRIMITIVE_*` / x402 env vars from `.env.example`
  - Done when: no engine path imports `primitive*` or `x402*`; existing parsing and safety tests still pass against `fixtures/`
  - Status: in progress (Inkbox buyer adapter on `yashnil`: send, webhook verify, sender trust, attachments, `call.ended`)
- [ ] **MCP server on Manufact:** all tools exposed (returning fixtures at first), deployed, callable from Claude Code
  - Done when: every tool in `CLAUDE.md` section 6 is listed and callable via `npx mcp-use client`; the Manufact URL is copied from the dashboard into the log
  - Status: not started
- [ ] **Email deal loop:** outreach, inbound webhook, parsing (text, PDF, JSON), replies feed the brain
  - Done when: `deal` emails the sellers from `haggle`; a signed `message.received` webhook becomes a `Quote`; `brain.learnFromReply` is called
  - Status: not started
- [ ] **Results:** `wait_for_update` and `get_quotes` return real deal board data
  - Done when: output validates against `DealBoard` and stays around 1,500 tokens for six quotes, with a `next` hint
  - Status: not started
- [ ] **Phone calls:** Voice AI calls businesses; call transcripts become quotes
  - Done when: `placeCall` with a `reason` that says it's an AI assistant; `call.ended` transcript becomes a `Quote` with `channel: "phone"`; `503` is retried
  - Status: not started
- [ ] **A2A:** agent-ready businesses get a task and return a structured quote
  - Done when: Bay Catering's Agent Card gets a task and its result becomes a `Quote` with `channel: "a2a"`
  - Status: not started
- [ ] **Conversation handling:** follow-ups (email, then call), answering business questions, one negotiation round
  - Done when: unanswered email triggers a call; `answer_business` replies in-thread; a counter cites a real competing quote
  - Status: not started
- [ ] **Approval and payment:** iMessage or in-view approval, then capped Stripe payment
  - Done when: `pay` refuses without a stored approval for that exact quote, over the cap, or to a non-quoting payee; a test-mode charge returns a `receipt_url`
  - Status: not started
- [ ] **ChatGPT app features:** launcher entrypoint, settings (cap, approver, area), mentions
  - Status: not started
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

_(none yet)_

## Log

_One line per finished task, newest first: `time · who · what changed`._

- 2026-10-17 · Yash · Docs aligned to v5: `CONTRACTS.md` rewritten for Inkbox + Stripe (Primitive/x402 removed), `PLAN.md` added, `CLAUDE.md` start-here guide, "Done when" criteria in this checklist
