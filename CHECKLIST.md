# Haggle: Progress Checklist

Haggle is an MCP server and MCP App that lets any AI agent buy from businesses by email, phone calls and texts: it reaches each business on its channel through Inkbox, reads replies and call transcripts, negotiates, gets a human's yes and pays with Stripe, with a live deal board inside ChatGPT and Claude. Every conversation teaches it about that business, so the next agent gets an instant answer.

**Claude Code keeps this file updated** (rules in `CLAUDE.md` section 8). Before work: set "Now working on". After work: tick the item only if its "Done when" is fully met, update its status line, and add one log line. Edit only your own items. Specs: `CONTRACTS.md`. Plan: `PLAN.md`.

**Now working on:** Yash: MVP rehearsal, waiting on the setup actions and authorization in `docs/mvp-demo.md` · Aarnav: branch `feat/live-demo` (main + aarnav-live-e2e + the haggle-testing parity port; needs Yash's review before it merges), then the live demo rehearsal

**Gates:** 3 PM email deal end to end + deal board renders · 9 PM multi-channel deal + warm ask + approval + payment live on Manufact · 3 AM feature freeze · 9:45 AM submit

---

## Together (first hour)

- [ ] **Foundation:** monorepo, `contracts.ts` + `views.ts` schemas, view fixtures, database, Inkbox identities, both skills installed, MCP App scaffolded and running in the Inspector
  - Done when: `packages/core` types match `CONTRACTS.md` sections 1–3; one fixture per view in `fixtures/views/`; `haggle` + 6 seller identities exist on Inkbox; `npm run dev` serves `/mcp` and the Inspector lists the tools
  - Status: integrated on `main`: one npm-workspaces monorepo; `packages/core` v5 (Aarnav's contracts + view schemas plus the engine's agreed optional fields, CONTRACT_VERSION haggle.contracts/5); view fixtures; engine migrations applied on live Supabase. Brain migrations 200 + 201 applied live (brain persists in Supabase). Left: sellers are in Aarnav's Inkbox org, buyer `haggle` in Yash's (see Blockers)

## Yash: tools and deal engine

_MVP audit (2026-10-17, main 54b2d47, deployed as calm-spark 0.5.0+54b2d47). PASS = "Done when" fully met with evidence; FAIL = not met; BLOCKED = built and tested, waiting on a setup action or authorization (see `docs/mvp-demo.md`). Mock results never count as live proof._

- [ ] **Inkbox migration:** replace the v3/v4 Primitive email and x402 payment code with the Inkbox adapter and Stripe; remove `PRIMITIVE_*` / x402 env vars from `.env.example`
  - Done when: no engine path imports `primitive*` or `x402*`; existing parsing and safety tests still pass against `fixtures/`
  - Status: **FAIL (as worded).** The live server never loads them: email is Inkbox, payments are Stripe test mode or refused, `.env.example` has no `PRIMITIVE_*`/x402 vars, and parsing/safety tests pass (284). But `packages/engine` still has and exports `live/adapters.ts` (Primitive SDK + x402 client), `payments/x402Challenge.ts` (mock's simulated rail), and generic types/helpers in `inbound/primitive.ts` / `outbound/primitiveSender.ts` that the Inkbox path imports. Left (post-demo, low risk): move those helpers to neutral modules, delete the Primitive adapters, and retire the mock x402 rail in favour of the Stripe mock.
- [x] **MCP server on Manufact:** all tools exposed (returning fixtures at first), deployed, callable from Claude Code
  - Done when: every tool in `CLAUDE.md` section 6 is listed and callable via `npx mcp-use client`; the Manufact URL is copied from the dashboard into the log
  - Status: **PASS.** https://calm-spark-ck3qm.run.mcp-use.com/mcp, LIVE mode, version 0.5.0+9bb217b. 15 tools listed; `scripts/acceptance/live-readonly.mjs` 21/21 against the deployed server (contract, read-only tools, refusals, signed webhooks, Inkbox events, Stripe card, Supabase brain). Claude Code (headless) calls `ask` on it. Rollback point: deployment ac0287bd (f5d6699).
- [ ] **Email deal loop:** outreach, inbound webhook, parsing (text, PDF, JSON), replies feed the brain
  - Done when: `deal` emails the sellers from `haggle`; a signed `message.received` webhook becomes a `Quote`; `brain.learnFromReply` is called
  - Status: **PASS for the live round trip, FAIL for live text/PDF.** Live: job_512a5d0265b144ed9337, hosted `deal` → RFQ from haggle@inkboxmail.com → in-thread reply from a same-org test seller → signed webhook (stored) → quote $1,080 from quote.json (trust inkbox-org-identity) → get_quotes/wait_for_update via MCP client and Claude Code. `learnFromReply` runs on trusted replies (BrainAdapter; tested); the live round trip predates the Supabase brain, so live-learned persistence still needs one live deal. Text and PDF extraction through Claude are tested on fixtures, not yet live.
- [ ] **Results:** `wait_for_update` and `get_quotes` return real deal board data
  - Done when: output validates against `DealBoard` and stays around 1,500 tokens for six quotes, with a `next` hint
  - Status: **PASS on mock for six quotes, PASS live for one.** Six-seller deal (mock server, real engine): model text 574 chars (~144 tokens), view data 5,292 chars (~1,323 tokens), `next` present. Live board validates against DealBoard (acceptance check). A live six-quote board needs six reachable live sellers (blocked by the org split). Deal board UI driven in the mcp-use Inspector (Playwright): renders, live-updates after an answered question, Approve → human approval form → Pay → "deposit paid", decline → stays approvable, fullscreen, light/dark, 380 px. Screenshots `docs/screenshots/mvp-*`.
- [ ] **Phone calls:** Voice AI calls businesses; call transcripts become quotes
  - Done when: `placeCall` with a `reason` that says it's an AI assistant; `call.ended` transcript becomes a `Quote` with `channel: "phone"`; `503` is retried
  - Status: **BLOCKED (built + tested, no live call).** HOSTED_AGENT call whose brief says it's an AI assistant and cites only real competing totals; 503 retried; abridged `call.ended` replaced by the full transcript; scheduled calls (`HAGGLE_CALL_DELAY_S`) and email→call escalation; inbound callers untrusted unless `HAGGLE_TRUST_INBOUND_CALLER_ID`. Tests: `packages/engine/tests/channels.test.ts`, `apps/mcp/tests/channels.webhook.test.ts`. Waiting on: a buyer identity with a number (`haggle-buyer`) or the callee's shared-line iMessage assignment, the callee on the allowlist, `HAGGLE_ENABLE_CALLS=true`, and Yash's go-ahead.
- [ ] **A2A:** agent-ready businesses get a task and return a structured quote
  - Done when: Bay Catering's Agent Card gets a task and its result becomes a `Quote` with `channel: "a2a"`
  - Status: **BLOCKED (live 403).** Built + tested (task to the pinned card, result by webhook or polling, `haggle.quote.v1` → Quote, counter in the same context). Live attempt job_9a5f8491d69c498782fd: Inkbox A2A RPC 403, because `haggle`'s A2A filter is a whitelist with 0 rules (admin-only). Unblocked by moving to `haggle-buyer` (same org as Bay) or an admin allow rule.
- [ ] **Conversation handling:** follow-ups (email, then call), answering business questions, one negotiation round
  - Done when: unanswered email triggers a call; `answer_business` replies in-thread; a counter cites a real competing quote
  - Status: **PASS on mock/tests, not live.** Unanswered email → one Voice AI call to an allowlisted phone (`escalateEmailToCallAfterMs`, test "an unanswered email escalates…"); `answer_business` in-thread (email, iMessage, A2A); counters cite only eligible, trusted, current quotes (`counteroffer.test.ts`, `goldenChain.test.ts`). Live counter and escalation wait on the rehearsal.
- [ ] **Approval and payment:** iMessage or in-view approval, then capped Stripe payment
  - Done when: `pay` refuses without a stored approval for that exact quote, over the cap, or to a non-quoting payee; a test-mode charge returns a `receipt_url`
  - Status: **Refusals PASS live; charge BLOCKED.** Live: `pay` without approval refused, headless `approve` → NO_HUMAN_CHANNEL (acceptance checks). Guard rules (exact quote, cap, payee, expiry, idempotency) tested in `stripe.test.ts`. Stripe sandbox customer + test card attached, 0 PaymentIntents. iMessage approval (`YES <code>` from the settings approver only) and the approval card are built + tested. Waiting on: `HAGGLE_ENABLE_PAYMENTS=true` + `STRIPE_*` on Manufact, the approver texting `connect @<buyer>`, and Yash's go-ahead for one test-mode charge.
- [ ] **ChatGPT app features:** launcher entrypoint, settings (cap, approver, area), mentions
  - Status: **FAIL (not verified in ChatGPT).** Registered and verified over MCP (launcher global + thread entrypoints, settings.read, approve_in_view app-only). Needs a human to add the app in ChatGPT developer mode.
- [ ] **Agent polish:** helpful errors, Skill, `llms.txt`, publishing checks, works across clients
  - Status: **PARTIAL.** Errors carry `next` hints; Skill covers channels and iMessage approval; `/llms.txt` live; views fixed and verified in the mcp-use Inspector (launcher empty state, approve→pay→receipt, live sync, LIVE/DEMO labels, why-the-winner, counteroffers, what each business said); seed brain data labelled as samples; works in Claude Code and the mcp-use client. Not tested: ChatGPT, Claude.ai (need a human to add the connector); no Manufact benchmark runs yet (`apps/bench/results/runs.csv` is empty).

## Aarnav: views, brain, sellers, proof

- [x] **Brain stub:** fake data for every brain function (first)
  - Status: done: `createStubBrain()` in `@haggle/brain`, tested against the contracts
- [ ] **Deal board view:** business cards with channel and live status, ranked quotes, flags, verdicts, actions, fullscreen
  - Status: built on fixtures (ladder vs budget, channel badges, live polling, answer question, approve, fullscreen, light/dark); screenshots in `apps/bench/screenshots`. Left: check in ChatGPT/Claude, real engine data
- [x] **Email sellers:** webhook server with email personas replying in character
  - Status: done, verified live on Inkbox from `haggle-buyer`: Golden Grill (6 veg), Harbor Table (PDF, deposit on p2), Sunset Kitchen (plates question → quote in the same thread), QuickQuote Deli (pay-now bait), Bay Catering (email + quote.json). Every conversation now draws its own price, fees, deposit, negotiation room, first question, menu and mood (`SELLERS_VARY=0` for base numbers); quote emails always state vegetarian count + delivery. Run: `npm run start -w @haggle/sellers`
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

Full setup steps with owners: `docs/mvp-demo.md` § Manual setup.

- Team, org split (blocks A2A, calls, and trusted multi-seller replies): buyer `haggle` is in Yash's Inkbox org; sellers, `haggle-buyer` and the only phone number are in Aarnav's. Recommendation: run the demo from `haggle-buyer`. Aarnav creates its agent-scoped API key + webhook signing secret and gives them to Yash through the env file (not chat); Yash points the webhook at calm-spark and sets `INKBOX_API_KEY`/`INKBOX_IDENTITY`/`INKBOX_WEBHOOK_SECRET`/`HAGGLE_DEMO_FLEET` on Manufact. Alternative: an admin adds an outbound A2A allow for `@bay-catering-sf` on `haggle` (plus inbound `@haggle` on Bay).
- Yash: authorization for the live rehearsal (recipients on the allowlist, calls/iMessage/A2A/payments flags, one test-mode charge). Nothing is sent until then.
- Yash: ChatGPT check needs a human: add https://calm-spark-ck3qm.run.mcp-use.com/mcp as a developer-mode app, then `get_quotes job_id=job_512a5d0265b144ed9337`.
- Aarnav: review migration `201_brain_profiles_grants.sql` (in the 2xx brain space; grants service_role on `brain_profiles`, applied live with assertions). `packages/brain/src/views.ts` still suggests `deal(businesses=['biz_…'])`, which isn't valid input; the MCP layer overrides it with `deal(... discover:true)` for now.
- Shared: three quote.json shapes (v3 `quote/1`, CONTRACTS `haggle.v0`, sellers `haggle.quote.v1`); the engine accepts all three. Pick one in CONTRACTS.md.
- Inkbox plan allows 1 phone number (on `haggle-buyer`). The Voice AI vendor is a human answering a call (the demo's design); a 2nd number is only needed for unattended benchmark runs.
- iMessage reaches humans only, after they text `connect @<buyer handle>`; before their first reply, messages are ≤159 chars with no links or numbers (the RFQ text is built to fit).
- Yash (parsing): Harbor Table's live replies come back `requirement_unknown` although the email body says "12 … vegetarian meals" and "Delivery … included" (job_ab9cf02c488f4ce0b2be); likely the body+PDF extraction drops the dietary count. Harbor can't win until fixed.
- Aarnav's live server `haggle-aarnav` (https://keen-cloud-z3xyf.run.mcp-use.com/mcp) shares `haggle-buyer` (and its webhook signing key) with the errand server; both receive each other's events and ignore unknown threads/calls. Engine tables live in schema `haggle` of errand's Supabase (`HAGGLE_DB_SCHEMA=haggle`; `public` has errand-era tables with the same names), where migration 103 is not applied. Plan: a new dedicated Supabase project with all migrations in `public`.
- Shared, open decision D8: mock mode's `simulated` approval channel (headless client, DEMO only) isn't in `Approval.channel`; `apps/mcp/src/views.ts` extends the schema for it until both agree.
- Resolved today: brain persistence (migration 201 + corrected SUPABASE_URL, 6 profiles identical across a redeploy); brain start-up can't crash the server; Inkbox webhook subscribed to iMessage + A2A events.
- Yash (review): branch `feat/live-demo` (main + aarnav-live-e2e + testing parity) ports the haggle-testing gaps and edits Yash's lane (engine, `apps/mcp/index.ts` + `src/`, migration 103) and `packages/core` (additive, contracts v6). Before merge: Yash reviews; apply `103_engine_parity.sql` on the live DB; set `HAGGLE_AUTH=required` on hosted servers once workspaces are created (`npm run workspace:create -w @haggle/mcp`). New views (identity-card, conversation) not yet checked in the Inspector/ChatGPT.

## Log

_One line per finished task, newest first: `time · who · what changed`._

- 2026-10-17 20:15 · Aarnav · Brain store honours `HAGGLE_DB_SCHEMA` (was always `public`, so a shared DB with tables in `haggle` couldn't persist profiles); PDF fixtures marked binary (Windows autocrlf corrupted them); all 6 migrations verified on a fresh Postgres 17 for the new dedicated Supabase project; 369 tests pass

- 2026-10-17 · Aarnav · `feat/live-demo` (main + aarnav-live-e2e + testing parity): haggle-testing gaps ported: any-request asks (custom fields, compare_by, payable_field), missing-info follow-up + carry-over, confirm-only approvals + confirmations/receipts, approval lockout, message guard, email→call escalation with call hours/cooldown/screener handling, classified Inkbox retries, keyword fallback parser, image attachments, workspaces + token/connector auth, tools get_identity/send_message/negotiate/get_conversation/cancel_deal, /internal/tick, identity-card + conversation views, bench eval runner; migration 103; engine tests pass on memory + Postgres
- 19:30 · Yash · Product polish (54b2d47, deployed): launcher no longer crashes on an empty server; deal board does approve → human form → pay → receipt in place, re-syncs on open/reconnect, shows LIVE/DEMO, why the winner wins, counteroffers, can't-win reasons and each business's own words (flagged businesses' text never echoed); approval card shows order total + deposit; Voice AI brief rewritten as short steps; seed brain data no longer called "real quotes"; flaky Postgres launcher test fixed; all flows driven in the mcp-use Inspector; 295 tests + 193 on Postgres, 21/21 live
- 17:40 · Yash · MVP pass: channels consolidated into `main` (9bb217b) and deployed (calm-spark 0.5.0+9bb217b): A2A, Voice AI calls (scheduled + escalation), iMessage vendors + approval, Stripe guard; brain on Supabase (migration 201, survives redeploy); webhook gets iMessage/A2A events; `/llms.txt` + Skill; acceptance harness (`scripts/acceptance`), 21/21 live read-only, 284 tests; branches yashnil/aarnav audited vs main (nothing lost), aarnav-old/yashnil-channels/yashnil-stripe archived as tags and deleted; audit above, demo in `docs/mvp-demo.md`
- 16:50 · Aarnav · `aarnav-live-e2e`: live Haggle on Manufact (`haggle-aarnav`, Aarnav's Inkbox org: buyer `haggle-buyer` + its number + the six sellers); 4 live deals verified via mcp-use client (RFQs → varied seller replies → signed webhooks → quotes; scam/veg/hidden-deposit caught; question answered in thread; negotiation $1,100 → $1,023 citing a real quote); engine fixes: no 'replied' overwrite of a concurrent 'quoted', one advance per job (no duplicate questions/quotes), answer keys cover the text, Inkbox refusals → actionable errors; `HAGGLE_DB_SCHEMA`, `HAGGLE_DIRECTORY_JSON`, `npm run live -w @haggle/sellers`

- 16:30 · Yash · Channels on `yashnil-channels`: A2A buyer tasks (live attempt → 403 diagnosed), Voice AI call origin/retry/full transcripts/inbound callers, iMessage approval, quote.json v5 shapes, brain start-up no longer crashes the server; SUPABASE_URL typo fixed locally
- 3:31 PM · Yash · calm-spark redeployed from `main` (f5d6699), live: start command fixed for npm workspaces; real brain (container-file store; Supabase blocked, see Blockers); live deal job_512a5d0265b144ed9337 ($1,080) renders in the shared deal board (light/dark); ask/business_profile/check_price/discover OK; pay refuses without approval, headless approve → NO_HUMAN_CHANNEL; unsigned webhook → 401; payments and calls off; 263 tests + 168 on Postgres
- 3:04 PM · Yash · `main` fast-forwarded to `yashnil-stripe` (Stripe test-mode deposits); `scripts/test-postgres.sh` runs on npm; discovery says when fewer businesses than requested are available and live responses are tagged [LIVE]; 263 tests + 168 engine tests on Postgres; six-seller mock flow verified through deal(discover) to paid
- 2:45 PM · Yash · v5 integration: yashnil + aarnav merged on one v5 core (agreed reconciliation), npm workspaces; engine teaches the real brain through `BrainAdapter` (directory ids, trusted senders only); view tools return the shared schemas; approval card/deal board approve via `approve_in_view`; x402 test fixtures no longer expire; 250 tests pass; cold deal + warm ask verified through the mcp-use client, deal board and estimates screenshots
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
