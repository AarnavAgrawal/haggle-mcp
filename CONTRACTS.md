# Haggle contracts (v5: Inkbox + mcp-use)

This file is the written spec for every surface **shared** between Yash's half (tools, engine)
and Aarnav's half (views, brain, sellers, bench). Code that crosses the line must match it.
`CLAUDE.md` section 5 has the short version; this file has the detail.

| # | Surface | Lives in | Owner | Status |
|---|---|---|---|---|
| 1 | Core types (`Channel`, `JobState`, `Business`, `Quote`, `Brain`) | `packages/core/contracts.ts` | Shared | Agree in the first hour, then frozen |
| 2 | View schemas (zod) | `packages/core/views.ts` + `fixtures/views/*.json` | Shared | Agree in the first hour, then frozen |
| 3 | State machines (job, business) | `packages/core/contracts.ts` | Shared | Frozen with section 1 |
| 4 | Channels on Inkbox (email, phone, iMessage, A2A) | Inkbox identities + webhooks | Yash (buyer), Aarnav (sellers) | Authoritative |
| 5 | Quote protocol (`rfq.json` and `counter.json` over A2A only; `quote.json` from sellers) | `packages/core/` | Shared | Authoritative |
| 6 | Approval and payment (Stripe test mode) | `packages/engine/` | Yash | Authoritative |
| 7 | Database (Supabase) | `supabase/migrations/` | Split by number range | Authoritative |
| 8 | Environment variables | `.env.example` | Each side for its own vars | Authoritative |

**Changing a frozen surface:** both people agree in chat first, then one person edits
`packages/core/*` and bumps `CONTRACT_VERSION`. Changes must be backward compatible unless both
agree otherwise. Claude Code never edits `packages/core/*` without explicit confirmation.

> **Earlier designs are gone.** v3/v4 used Primitive for email and x402 (USDC on Base Sepolia)
> for payment. Neither is part of v5. All channels go through **Inkbox**; payment is **Stripe test
> mode**. Any remaining `primitive*` or `x402*` code or env vars (for example
> `inbound/primitive.ts`, `outbound/primitiveSender.ts`, `payments/x402Challenge.ts`,
> `PRIMITIVE_*`, `HAGGLE_PAYER_PRIVATE_KEY`) is legacy, to be replaced by the Inkbox adapter
> and Stripe and then deleted. Don't build anything new on it.

---

## 1. Core types: `packages/core/contracts.ts`

```ts
type Channel = 'email' | 'phone' | 'a2a' | 'imessage';

type JobState = 'created' | 'contacting' | 'collecting' | 'negotiating'
  | 'awaiting_approval' | 'paying' | 'paid' | 'cancelled' | 'failed';

interface Business {
  id: string; name: string; email?: string; phone?: string;   // phone is E.164
  a2a_card_url?: string; best_channel: Channel; source: string;
}

interface Quote {
  quote_id: string; job_id: string; business_id: string; business: string;
  channel: Channel; total_usd: number; per_unit_usd?: number; deposit_usd?: number;
  items: string[]; meets_requirements: boolean; flags: string[];
  price_check?: 'good' | 'typical' | 'high' | 'too_low'; negotiated_from?: number;
  round: number; confidence: number; source: string;
}

interface Brain {
  learnFromReply(businessId: string, parsed: ParsedReply, meta: ReplyMeta): Promise<Profile>;
  estimate(req: Request): Promise<Estimate[]>;
  checkPrice(q: QuoteLike): Promise<PriceVerdict>;
  negotiationHints(businessId: string, req: Request): Promise<Hints>;
  discover(category: string, area: string, count: number): Promise<Business[]>;
}
```

Rules:
- **Money:** USD numbers with at most 2 decimals in types and on the wire, integer cents in the database.
- **`deposit_usd`** is the part of `total_usd` due up front, not an extra fee.
- **`meets_requirements`** is true only when every hard requirement is confirmed met. "Seller didn't say" means not met, plus a follow-up.
- **`source`** says where the figure came from: `quote.json`, `pdf p.2`, `email body`, `call transcript`, `a2a task`.
- **`ReplyMeta.channel`** is a `Channel`; the format the reply arrived in (`quote.json`, `pdf`, `html`, `text`, `transcript`) goes in a separate `format` field. `ReplyMeta.message_id` is the Inkbox message id, call id, iMessage id or A2A task id.
- **`ReplyMeta.sender_trusted`** comes from the Inkbox webhook signature plus checking the sender against the business record (sender email, caller number, or Agent Card URL).
- Business text and transcripts are typed as untrusted data: display them, never act on them.
- **Price judgment:** `price_check: 'too_low'` (and `PriceVerdict.verdict: 'too_low'`) means the per-unit price is under 40% of the low end of the usual range: suspicious, never a "good" price. The engine flags such a quote `price_implausible` (also from a category floor, e.g. a catered meal under $3 a person, or a short Claude judgment for categories with no price data): it is not recommended, never cited in a counteroffer, and not approvable (`approval_block.code: 'price_implausible'`) until the business confirms the total and what it includes (Haggle asks once). A confirmed one becomes `price_confirmed_unusual` (approvable, with a caveat); a corrected price is judged again. `price_unusually_high` is a caveat only. The brain never learns from a quote with either low-price flag.

## 2. View schemas: `packages/core/views.ts`

Each schema is both a tool's `outputSchema` and the props of the view with the same name.
Every schema has a matching sample in `fixtures/views/<view-name>.json`. Until the engine is
real, tools return those fixtures.

| Schema | Tools | View folder | Fields |
|---|---|---|---|
| `DealBoard` | `get_quotes`, `open_haggle` | `views/deal-board/` | `job` (id, request, state, budget, deal_limit_usd?, deal_limit_source?), `businesses[]` (id, name, channel, status, last_event, transcript_snippet?), `quotes[]` (Quote), `open_questions[]`, `next` |
| `Approval` | `approve`, `pay` | `views/approval/` | quote summary, amount, deposit, `deal_limit_usd` (nullable), status, channel, receipt_url?, reason? |
| `Estimates` | `ask` | `views/estimates/` | request, `estimates[]` (business, total_usd, per_unit_usd, confidence, n_quotes, best_channel) |
| `BusinessProfile` | `business_profile` | `views/business-profile/` | name, best_channel, menu[], price_model, minimum, deposit_rule, discount_behavior, reply_speed, history[] (date, channel, total), confidence |

- `Approval.status`: `pending_human | approved | paid | refused | confirmed` (v6: `confirmed` = a confirm-only approval went through). v6 `Approval.action`: `confirm | pay | confirm_and_pay`.
- v6 schemas: `Conversation` (`get_conversation`, `views/conversation/`) and `Identity` (`get_identity`, `views/identity-card/`); `DealBoard.job.ask` / `compare_by` and `Quote.fields` / `missing_fields` / `total_known` for custom asks (section 9).
- Views render only what is in the schema. If a view needs a new field, add it to `views.ts` and the fixture first (shared change).

## 3. State machines

**Job:**
```
created → contacting → collecting ⇄ negotiating → awaiting_approval → paying → paid
                                                                    ↘ confirmed   (v6: confirm-only approval)
side exits from any non-terminal state: cancelled, failed
```
- v6: `negotiate` (manual round, once quotes are final) moves `collecting|negotiating (ready)` → `negotiating` with one round past `max_rounds` at most (round ≤ 3).
- `paying` is reachable only from `awaiting_approval` with a stored approval (section 6).
- A job past its deadline with no approval becomes `failed` with reason `deadline_passed`.
- A revised quote during `awaiting_approval` voids that approval and returns the job to `negotiating`.

**Business, per job** (`DealBoard.businesses[].status`):
```
contacted → ringing → on_call → quoted → negotiating → won
side exits: declined, no_reply
```
`ringing` and `on_call` apply only to phone. Email and A2A go straight from `contacted` to `quoted`.

## 4. Channels on Inkbox

One buyer identity, **`haggle`** (Yash), with a mailbox, a phone number and iMessage. Six seller
identities (Aarnav). Every inbound event is an Inkbox webhook posted to the MCP server's webhook
route, verified by signature and deduplicated by event id before anything else happens.

**A mailbox per workspace** (`HAGGLE_MAILBOX_PER_WORKSPACE=true`, off by default; migration 126): on a
workspace's first live deal the server creates an Inkbox identity for it (a mailbox, no phone; needs
`INKBOX_ADMIN_API_KEY`), subscribes `<HAGGLE_WEBHOOK_BASE_URL>/webhooks/inkbox/<handle>` to
`message.received` / `message.bounced` / `message.failed` and stores its signing key. That deal's
vendor email goes from and returns to that mailbox (`jobs.inbox`); the per-handle webhook verifies
with that identity's key and matches only that mailbox's deals; the reconciler sweeps every
workspace mailbox. Phone, iMessage, voice and mail to the approver stay on the shared identity. Any
provisioning failure falls back to the shared mailbox (retried after 10 minutes).

**Routing (engine):** A2A if the business has `a2a_card_url`; else email if it has `email`; else a
Voice AI call to `phone`. If an email gets no reply by the follow-up deadline and a phone number
exists, call.

| Channel | Outbound (buyer) | Inbound event | Becomes |
|---|---|---|---|
| Email | Send from `haggle` mailbox; replies in-thread with `inReplyToMessageId`; plain text, no attachment (no `rfq.json` or `counter.json`) | `message.received` (fetch the full message by id; attachments are base64) | `ParsedReply` from text, PDF, HTML or `quote.json` |
| Phone | `identity.placeCall({ toNumber, mode: CallMode.HOSTED_AGENT, reason })` | `call.ended` with transcript, `outcome` (`completed` / `no_answer` / `declined` / `failed`), `post_call_action_items` | `ParsedReply` from the transcript; `no_answer` / `declined` update status |
| A2A | Send a task to the business's Agent Card | A2A task result | `ParsedReply` from the structured result |
| iMessage | `identity.sendIMessage({ to, text })`, approval requests only | `imessage.received` | Approval YES/NO (section 6) |

Channel rules:
- **Call `reason`** (≤ 2,000 chars) must say it is an AI assistant requesting a quote, and include the request and requirements. Retry on `503 hosted_agent_at_capacity`.
- **Who the business hears from (2026-10-31).** Email: no AI self-label, signed with the customer's name (`Thanks,\nAcme Labs`, from the request's `Customer` detail or `HAGGLE_CUSTOMER_NAME`; `Thanks!` alone when unknown), never an invented person and never "Haggle". If a business asks whether it is talking to a person, the answer is truthful: an AI assistant for the customer (`answerQuestion.identityAnswer`). The message guard refuses agent text that claims to be human (`CLAIMS_HUMAN`). Calls and texts keep the disclosure ("I'm an AI assistant for <customer>").
- **The first email (RFQ).** Subject `Quote for <what> for <n> – <Thu Nov 12>` (people are the default unit; a request that starts with a verb reads `Quote request: <what>`). Body: one paragraph with what, when (the request's local date and time), where, headcount, must-haves and details; then one line asking only for the all-in price and any deposit, plus at most two short asks (which days work, for a flexible range; when they could do it, for an undated job; one category ask such as a repair's earliest arrival: `intake.firstEmailAsks`), and "A photo or PDF of your quote is fine." The reply-by is a day in the workspace's time zone ("by Tuesday, Nov 10", or "by 3:00 PM today"), never UTC.
- **Follow-up emails** are two or three lines. The menu, what's included, the per-person price and the cancellation policy are asked only in the one follow-up, only when the reply leaves them out (`intake.criticalGaps`), and only with a follow-up that goes out anyway. "How long the quote is good for" and "how you meet each must-have" are not asked (must-haves are confirmed at booking). The no-reply reminder, the firm-total chase and the missing-terms follow-up end with "Reply STOP and we won't email again."; a STOP reply suppresses the address (`vendor_suppressions`, when the sender is verified) or stops that deal.
- **Booking and payment emails** name the customer ("Acme Labs will pay you directly"), never Haggle.
- **iMessage:** the approver must first text `connect @haggle` to the router number (`inkbox.imessages.getTriageNumber()`). Until they reply: ≤ 159 chars, no links or phone numbers, at most 3 messages.
- **SMS:** not used (10DLC). Use iMessage.
- **Seller phone persona:** `setIncomingCallAction({ incomingCallAction: IncomingCallAction.HOSTED_AGENT })` + `setHostedAgentConfig({ voice, instructions })` (the config is replaced in full on each call).
- **Dev webhooks:** `connect(inkbox, { name, forwardTo })` from `@inkbox/sdk/tunnels/connect`, or `npx mcp-use dev --tunnel`.
- **No codes to businesses (2026-10-30).** Nothing Haggle sends a business carries a reference code: email subjects are `Quote for <what> for <n> – <date>` (every later email on the deal reuses it; threaded sends get `Re:`), no reply token (`HGR-…`) in subject or body, no `Ref HG-…` in texts, no reference in call reasons or the inbound voice instructions (open requests are listed in words: "lunch catering, 40 people, on 2026-11-03"), and no JSON part on email at all (`rfq.json` and `counter.json` go only to A2A businesses). Codes to the **approver** stay (`YES/NO/APPROVE/PAY/CALL/CANCEL <code>`, `(HG-…)`): they are a security feature.
- **Matching a business's email (in order):** (1) the Inkbox thread id; (2) In-Reply-To/References naming one of Haggle's own outbound Message-IDs to that business (any of them: RFQ, reminder, counter); (3) a legacy `[HG-<code>]` subject tag (older threads) plus From = the pinned address; (4) job-inbox recipient (mock); (5) a **new email** (no thread signal) from a pinned address: the deal only when that sender has exactly one open deal on the receiving mailbox (`matched_via: sender_only`), several → held as `ambiguous_sender` for operator review. Rules 1–2 from any other address are quarantined `sender_mismatch`.
- **Trust for mail from outside Inkbox** (`HAGGLE_EXTERNAL_SENDERS=reply_token`; the name is kept, no token is sent): from the pinned address and no DMARC/SPF failure, then aligned DMARC pass → `external-dmarc-aligned` (identity); a reply naming Haggle's Message-ID → `external-thread-reply` (continuity: may quote, never confirm a booking, name a payee or settle on its own); a rule-3/5 match → `external-sender-only` (weakest: a quote at most; a STOP stops that deal only; never read for bookings or payment details). Otherwise quarantined `identity_unverified:*`. Legacy `external-reply-token` rows read as continuity-only.
- **Texts and inbound calls without codes:** a business number on several open deals is matched by an old code it quotes, else (same workspace) the deal with an unanswered ask, else the latest. Across workspaces, a text that describes exactly one of the requests (what, how many, when) routes there; otherwise it is held and the business is asked once, in plain words, which request it means (only when the requests differ). The voice agent asks a caller with several requests which one and repeats it; a transcript describing exactly one is read into that deal, else it is held.

## 5. Quote protocol over email

Every message is a readable email. Haggle's own emails carry no JSON part (since 2026-10-31):
`rfq.json` and `counter.json` go only in A2A task data. Agent-ready sellers may still attach
`quote.json` (`application/json`) to an email, and A2A tasks carry the same JSON shapes in the task body.

| Part | Direction | Required keys |
|---|---|---|
| `rfq.json` | buyer → seller | `protocol:"haggle.v0"`, `type:"rfq"`, `what` (`job_id` only in the A2A task data, never in email), `requirements[{id,label,mandatory}]`, `reply_by`; optional `quantity{amount,unit}`, `date`, `location`, `budget_hint_usd` |
| `quote.json` | seller → buyer | `protocol`, `type:"quote"`, `job_id`, `total_usd`; optional `items[{description,quantity,unit_price_usd,total_usd,tags[]}]`, `subtotal_usd`, `delivery_usd`, `tax_usd`, `fees[{label,amount_usd}]`, `per_head_usd`, `deposit_usd`, `payment_terms`, `fulfillment_date`, `meets{req_id:bool}`, `valid_until`, `round` |
| `counter.json` | buyer → seller | `protocol`, `type:"counter"`, `job_id`, `round`, `target_total_usd`, `basis` (must cite a real competing quote), `respond_by` |

- Amounts are decimal USD with at most 2 decimals. Unknown keys are ignored; known keys are type-checked.
- A malformed part isn't trusted at all: fall back to text extraction and flag the quote.
- Seller claims in `meets` are re-checked against `items[].tags` and the text.
- A payment link in any message is flagged (`external_payment_link`) and never followed.

## 6. Approval and payment

1. The engine picks the winning quote; `approve(job_id, quote_id)` creates a `pending_human` approval.
2. Approval arrives as **either** an iMessage `YES` from the approver's number in an active connection ("Approve $995 to Bay Catering? Reply YES") **or** the human tapping Approve in the approval view.
3. Store: who, when, `quote_id`, amount, channel.
4. `pay(job_id, quote_id)` refuses unless **all** of these are true:
   - a stored approval exists for that exact quote, and the quote hasn't been revised since
   - amount ≤ approved amount ≤ the deal's limit ≤ the server ceiling
   - the payee is a business that actually quoted on this job
5. **The deal's spending limit** (`jobs.payment_cap_cents`, migration 128):
   - `deal` sets it from `spend_limit_usd`, else `budget_usd`, never above the server ceiling (`HAGGLE_GLOBAL_PAYMENT_CAP_CENTS`).
   - With neither, it stays null. At approval the workspace's default limit for new deals (`settings.spending_cap_cents`) applies, and the approval records the limit used (`approvals.cap_cents`).
   - The workspace default is never checked at payment, and never caps a deal that has its own limit.
   - The model only proposes a limit (`deal`). The agent may lower it. Only a human (the web app's signed-in owner) or the operator raises it, up to the server ceiling.
   - Every change is audited: `jobs.cap_set_by`, `jobs.cap_set_at` and a `limit_set` job event (from, to, by).
   - Over the limit, `approve` refuses with `over_deal_limit`. The web app offers "This is $X over the limit you set for this deal. Raise it to $Y and approve?" as one human action: `POST /internal/approvals/raise-limit` `{ job_id, limit_usd, quote_id?, action? }` (service token and actor required; no MCP tool reaches it). Without `quote_id` it only sets the limit.
6. **Stripe test mode** charges the deposit (or the total if no deposit). `receipt_url` goes on the approval view.
7. A refusal returns `status: "refused"` with a `reason` that says how to fix it.

## 7. Database (Supabase Postgres + Realtime)

- Yash: `supabase/migrations/1xx_engine_*.sql` (jobs, businesses per job, messages, calls, quotes, questions, approvals, payments, audit log).
- Aarnav: `supabase/migrations/2xx_brain_*.sql` (profiles, price observations, seller personas).
- Money is `bigint` cents. Inbound events dedupe on `(provider, provider_event_id)`.
- `workspace_identities` (126): a workspace's own Inkbox identity (handle, identity id, mailbox, webhook signing key, status). The signing key is never returned to a client.
- `settings_audit`, `approver_changes` and `workspaces.sender_name` (129): one append-only row per settings change, and new approvers waiting for verification (hashes only). See §11.
- RLS on every table; only `service_role` (server-side) reads or writes. Neither side writes the other's tables. To read the other side's data, add a narrow read-only view and agree on it.

## 8. Environment variables

`.env.example` must list every variable with a comment. Never commit `.env`. Target set:

```bash
HAGGLE_MODE=mock                # mock | live. mock sends nothing and moves no money.
# Inkbox (buyer identity "haggle")
INKBOX_API_KEY=
INKBOX_WEBHOOK_SECRET=          # verify every webhook signature
INKBOX_BUYER_HANDLE=haggle
HAGGLE_ENABLE_CALLS=false       # must be true to place real Voice AI calls
# Claude API (parsing, negotiation, personas)
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-5-5
# Supabase (server-side only)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_URL=
# Stripe (test mode only: sk_test_...)
STRIPE_SECRET_KEY=
HAGGLE_GLOBAL_PAYMENT_CAP_CENTS=150000
```

Aarnav's seller app adds its own Inkbox keys for the six seller identities under a separate block.

v6 adds `HAGGLE_AUTH`, `HAGGLE_TICK_SECRET`, `HAGGLE_CALL_HOURS`, `HAGGLE_ESCALATION_WAIT_MINUTES` and `HAGGLE_SYNC_VOICE_CONTEXT`; `ANTHROPIC_API_KEY` becomes recommended rather than required (see `.env.example`).

## 9. v6 additions (ported from haggle-testing)

Additive: every v5 surface still validates; `CONTRACT_VERSION` is `haggle.contracts/6`.

- **Any kind of request.** `deal`'s request may carry `ask[]` (`{key, label, type: money|number|date|time|text|boolean, required}`), `compare_by` (`{field, direction: min|max}`), `payable_field` (a money ask key paid on approval), `details[]` (`{label, value}` facts) and `auto_follow_up`; `quantity`/`date` are then optional. Answers are validated per type (money in cents, real dates, HH:MM), money answers need a source, and nothing is guessed. A money `compare_by` is the total that ranks and negotiates; a non-money one ranks without totals and is never negotiated. A quote missing a required answer can't be approved (`excluded_reason`: "a required answer is still missing"). `rfq.json` gains `details` and `ask`.
- **Follow-up and carry-over.** One automatic follow-up per business asks for exactly what its quote lacks (required answers, or hard requirements it didn't address); the collection window stays open until it answers or the deadline passes. A partial reply keeps the business's earlier facts (never across a decline).
- **Approval actions.** `confirm` (nothing paid; the job ends `confirmed`), `pay`, `confirm_and_pay` (default when there's something to pay now). After a confirm-only approval or a settled payment, the business gets a confirmation (with the payment reference) on its channel and the approver an email receipt. Five wrong approval codes (card or iMessage) lock the approval (`locked`); a fresh `approve` is needed.
- **Agent messages.** `send_message` and `answer_business` text passes a guard: dollar amounts must come from the request or a stored quote, other businesses on the deal are never named, commitment phrases are refused, channel length limits apply.
- **Channels.** Email that bounces or gets no reply within `HAGGLE_ESCALATION_WAIT_MINUTES` escalates to a Voice AI call when the business has a phone (calls on). Calls only within call hours in the workspace timezone, never two to one number within 2 minutes, and a screener/voicemail is "reached, no answer" (never a quote). An amount only Haggle's voice agent said is never the business's price. Retryable Inkbox errors (rate limits, capacity) retry with the same idempotency key; hard ones move on. Quoted reply text is stripped from email before parsing; images (PNG/JPEG/GIF/WebP) are read like PDFs. The Voice AI answering instructions list open requests so callbacks match.
- **Deal idempotency.** `client_request_id` guards a retry of one `deal` call, not a purchase: it returns its job for 10 minutes (`DEAL_REPLAY_WINDOW_MS`), marked `replayed`, with nothing sent. After that the same id starts a new deal and moves to it. The web chat sets it per turn and ignores the model's.
- **Workspaces.** `workspaces` table (migration 103): jobs, settings and `client_request_id` are per workspace; connections authenticate with a bearer token or `/c/<secret>/mcp` (hashes only). Another workspace's ids read as not found.
- **Tools.** `get_identity`, `send_message`, `negotiate`, `get_conversation`, `cancel_deal`; `wait_for_update(until)`; `approve(action)`; `POST /internal/tick`.

## 10. Public listings and opening hours (migration 125)

- **Listing provider.** `discover` searches Amazon Location Service (Places v2 "geo-places", API key: `AWS_LOCATION_API_KEY`, `AWS_LOCATION_REGION` default `us-east-1`) when set, else Google Places (`GOOGLE_PLACES_API_KEY`), else says discovery is off. Refs: `aws:<PlaceId>` / `place:<Google id>`. Failures are typed: `not_configured | key_rejected | rate_limited | unavailable | area_not_found`. Amazon listings have no ratings or Maps links: `rating`, `review_count` and `maps_url` are simply absent, and every result carries its provider's `attribution`. Browsing uses `IntendedUse=SingleUse`; the GetPlace call made when a business's data is stored (added as a vendor, put on a deal) uses `Storage`.
- **discover `found[]`** adds `published_emails` (the listing's emails first, then the business website's; deduplicated, ≤ 3; was `website_emails`), `hours_today` ("Open today 9am–5pm", the business's timezone) and `hours { display[], source, timezone? }` when known.
- **Every search** (`packages/engine/src/reputation/vendorSearch.ts`) also reaches related businesses not listed for the work: restaurants for catering, handymen for plumbing, copy shops for printing. Work with no vocabulary in `fit.ts` is searched in the request's own words and its results stand. `found[]` adds `fit` (`specialist` is listed for the work; `adjacent` may do it, never claimed to), `price_tier` (`budget | mid | upscale`: a rough guide read from the listing, absent when it gives no signal, never a quote), `chain` and, for food, `cuisine`. `discover` takes optional `price_range` and `cuisine`; `deal` reads the details labelled `Price range` and `Cuisine`, else the words of `what`. Preferences order results and never remove one; with none the list is spread across fit, variety and price tier. Intake asks for them as optional questions (`price_range`, and `food` for catering), and a preview of found businesses invites them once.
- **`WeeklyHours`** (`packages/engine/src/reputation/hours.ts`): `{ timezone: IANA | null, intervals: [{ day 0–6 (Sunday = 0), startMinute, endMinute (> 1440 past midnight) }], display[], source }`. From Amazon `OpeningHours` components (the entry for the place's primary category, else untagged) or, as the fallback, schema.org `openingHoursSpecification` / `openingHours` on the business's own website.
- **Stored.** `job_businesses.opening_hours` (jsonb) + `timezone`, and `workspace_vendors.opening_hours` + `timezone` + `business_ref` (migration `125_engine_business_hours.sql`, nullable). `DealBusiness` and `addWorkspaceVendor` accept `opening_hours` / `timezone`; `POST /internal/vendors` accepts `business_ref`.
- **Contact timing.** A Voice AI call, and a first text, to a business with known hours goes only while it is open and not in the first or last 30 minutes of an opening interval, in its timezone, intersected with `HAGGLE_CALL_HOURS` (calls) or the contact window (texts); otherwise it is scheduled (`next_attempt_at` / `call_scheduled`) for the next allowed time. Unknown hours: unchanged. Emails keep the contact window. A published phone or email is never consent: calls and texts still need a vendor marked `existing_relationship` or `business_agreed`.

## 11. Owner settings (migration 129)

The signed-in workspace owner changes settings in the web app. Three actors change settings, each with its own rules (`packages/engine/src/workflow/ownerSettings.ts`):

| Actor | Where | May change |
|---|---|---|
| `operator` | `scripts/workspace-admin.ts` | Everything, up to the server ceiling. |
| `owner` | Web app `/settings` → `POST /internal/workspaces/settings` | Everything, up to the server ceiling (`HAGGLE_SPENDING_CAP_CEILING_CENTS`). A new approver phone or email waits for verification. Clearing one is direct. |
| `agent` | MCP `settings.update`, the native settings panel | Lower the cap and set the area. Never the approver, never a higher cap. |

**Audit.** Every change writes one `settings_audit` row per field: workspace, `by`, actor, field, old and new value, time. Phones and emails are masked. An owner's change is audited before it is saved, so no audit means no change. Operator and agent changes are audited after, best effort.

**Approver verification.** A new phone gets a 6-digit code by iMessage (at most 159 characters, no link). A new email gets a confirm link (`<web>/settings?confirm=<token>`) and the same kind of code. The change is stored in `approver_changes` with hashes only and expires after 15 minutes (phone) or 24 hours (email). Five wrong codes end it. A newer request for the same kind supersedes the older one. Until it is confirmed the old approver stays, and the current approver email is told that a change was asked for. Mock mode sends nothing and returns the code as `demo_codes` with `simulated: true`.

**Service routes** (`apps/mcp/src/service/workspaces.ts`). All need `x-haggle-service-token` and `x-haggle-workspace`. The POST routes also need `x-haggle-actor`, and the actor must own the workspace: its account id (`<email> (<account id>)` or the bare id) must be the one the `ws_u_<hash>` id was derived from. Anyone else gets `403 NOT_OWNER`.

| Route | Body | Returns |
|---|---|---|
| `GET /internal/workspaces/settings` | none | `{ ok, mode, settings, next }` |
| `POST /internal/workspaces/settings` | `{ name?, default_area?, timezone?, sender_name?, approver_email?, approver_phone?, default_deal_limit_usd?, confirm_url? }`; `""` or `null` clears an optional field; unknown keys are refused | `{ ok, mode, settings, changed[], pending_verification: ("phone"\|"email")[], demo_codes?, simulated?, next }` |
| `POST /internal/workspaces/settings/confirm` | `{ kind: "phone"\|"email", code }` or `{ token }` | `{ ok, mode, confirmed, settings, next }` |
| `POST /internal/workspaces/settings/cancel` | `{ kind }` | `{ ok, mode, cancelled, settings, next }` |

`settings` is `{ name, timezone, sender_name, default_area, default_deal_limit_usd, ceiling_usd, approver: { phone, email } (masked), pending: [{ kind, to (masked), expires_at, attempts_left }] }`. `default_deal_limit_usd` is stored as `settings.spending_cap_cents`: the limit for a deal started with no budget (§6). It is not checked at payment. Errors are `{ ok: false, error: { code, message, fix } }`: `400 INVALID_INPUT`, `bad_timezone`, `bad_phone`, `cap_above_ceiling`; `409 no_pending_change`, `imessage_off`; `410 verification_expired`; `422 wrong_code`; `429 too_many_attempts`; `502 verification_not_sent`; `503 settings_store_outdated` (apply migration 129).

**Web routes** (`apps/web/app/api/settings/`): `GET /api/settings`, `POST /api/settings`, `POST /api/settings/confirm`, `POST /api/settings/cancel`. Writes need a same-origin request, a session confirmed by the Auth server (`verifiedSessionUser()`), the `owner` role, and a non-guest account. They allow 10 per user per minute.

## 12. Haggle finds the businesses itself

- **When.** `deal` with no `businesses` named, and fewer than 3 of the workspace's saved businesses (`workspace_vendors`) serve the request's category. The server's demo roster, where it serves the request, stays the demo and nothing is searched.
- **Search.** The `discover` path: `rt.listing.discover(category, area, 20, preferences)` plus each business's website, in `apps/mcp/src/dealDiscovery.ts`. Area: the request's `area`, else the workspace's `default_area`, else `deal` returns `needs_info` with `{ key: "where", field: "area" }`.
- **Kept.** Businesses Haggle can reach, on what they publish: email first (the listing's, then the website's), else a Voice AI call, else a text. Never a suppressed contact (`vendor_suppressions`), an existing saved business, the approver's own contact, or (live) a simulated contact. A first contact needs the buyer's own line or SMS: calls over the shared iMessage line and iMessage itself reach only numbers that connected first. Businesses no channel can reach are named in `discovery.not_reachable` (the first 6: name, ref, `phone_published`; never the number) and in `next`. A chain location's email counts only from its own listing, since its website speaks for the chain; its phone number is the store's. At most 6 found businesses per deal (6 minus the saved ones used).
- **Preview.** `deal(dry_run: true)`, and a real `deal` without `confirm_discovered`, send nothing and return them in `would_contact` with `contact_state: "will_authorize_on_start"`, `channel: "email"`, `found: true`, `found_via: { listing, ref, email_from: "listing" | "website" }` and `hours_today` when known. The real call also sets `needs_confirmation: true`. `discovery: { status: ok | off | no_area | email_off | nothing_found | listings_down, found, reason? }` says whether Haggle searched and why it found nobody.
- **The user's yes.** `deal(confirm_discovered: [business_ref, ...])`. The server re-runs the search and refuses any ref it doesn't find (`unconfirmed_business`; a ref already saved is fine, and so is one this workspace's search found for the same kind of work in the last 30 minutes, since the wider searches are best effort; every suppression check still applies), and refuses `confirm_discovered` with `businesses` (`confirm_without_discovery`). `[]` means none of them. Each kept business is saved through the one vendor-add path (`addVendorChecked` in `apps/mcp/src/service/vendors.ts`) with consent `public_listing_email` (reached by email) or `public_listing` (reached by call or text), `category` = the request's category, `business_ref` = the listing ref (also in the consent note), the listing's stored hours, and `added_by` = `web:<user>` (the web app sends `x-haggle-actor` on MCP calls) or `agent:<client> on the user's yes`. The daily add limit (25 per workspace, shared with the Saved businesses page) applies before anything is saved (`DAILY_LIMIT`). Then each is contacted: by email if it published one, else a call, else a text.
- **Naming one.** A business from `discover` named in `deal(businesses)` needs no `confirm_discovered`: naming it is the yes, and it is saved and contacted the same way, with the same checks. One that opted out, or that can't be saved, stops the deal; one already saved under another name is contacted as that vendor, its record untouched.
- **Safety.** A reminder to a business with known opening hours goes only while it is open (not in its first or last 30 minutes). The §2 rules still apply: related work only, and the information floor.
- **Dead ends.** "NOT STARTED" (no saved businesses for the work) remains only when discovery is off or finds nothing, and the result says why.
- **Web.** The chat's preview card lists found businesses apart, each with a remove control; "Start the deal" names the kept ones with their refs so the assistant passes them as `confirm_discovered`. The Vendors page is now "Saved businesses" (route `/vendors` unchanged).
