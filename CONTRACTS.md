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
| 5 | Quote protocol over email (`rfq.json`, `quote.json`, `counter.json`) | `packages/core/` | Shared | Authoritative |
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
  price_check?: 'good' | 'typical' | 'high'; negotiated_from?: number;
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

## 2. View schemas: `packages/core/views.ts`

Each schema is both a tool's `outputSchema` and the props of the view with the same name.
Every schema has a matching sample in `fixtures/views/<view-name>.json`. Until the engine is
real, tools return those fixtures.

| Schema | Tools | View folder | Fields |
|---|---|---|---|
| `DealBoard` | `get_quotes`, `open_haggle` | `views/deal-board/` | `job` (id, request, state, budget), `businesses[]` (id, name, channel, status, last_event, transcript_snippet?), `quotes[]` (Quote), `open_questions[]`, `next` |
| `Approval` | `approve`, `pay` | `views/approval/` | quote summary, amount, deposit, cap, status, channel, receipt_url?, reason? |
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

**Routing (engine):** A2A if the business has `a2a_card_url`; else email if it has `email`; else a
Voice AI call to `phone`. If an email gets no reply by the follow-up deadline and a phone number
exists, call.

| Channel | Outbound (buyer) | Inbound event | Becomes |
|---|---|---|---|
| Email | Send from `haggle` mailbox; replies in-thread with `inReplyToMessageId`; RFQ attached as `rfq.json` | `message.received` (fetch the full message by id; attachments are base64) | `ParsedReply` from text, PDF, HTML or `quote.json` |
| Phone | `identity.placeCall({ toNumber, mode: CallMode.HOSTED_AGENT, reason })` | `call.ended` with transcript, `outcome` (`completed` / `no_answer` / `declined` / `failed`), `post_call_action_items` | `ParsedReply` from the transcript; `no_answer` / `declined` update status |
| A2A | Send a task to the business's Agent Card | A2A task result | `ParsedReply` from the structured result |
| iMessage | `identity.sendIMessage({ to, text })`, approval requests only | `imessage.received` | Approval YES/NO (section 6) |

Channel rules:
- **Call `reason`** (≤ 2,000 chars) must say it is an AI assistant requesting a quote, and include the request and requirements. Retry on `503 hosted_agent_at_capacity`. Only call simulated businesses or people who agreed to it.
- **iMessage:** the approver must first text `connect @haggle` to the router number (`inkbox.imessages.getTriageNumber()`). Until they reply: ≤ 159 chars, no links or phone numbers, at most 3 messages.
- **SMS:** not used (10DLC). Use iMessage.
- **Seller phone persona:** `setIncomingCallAction({ incomingCallAction: IncomingCallAction.HOSTED_AGENT })` + `setHostedAgentConfig({ voice, instructions })` (the config is replaced in full on each call).
- **Dev webhooks:** `connect(inkbox, { name, forwardTo })` from `@inkbox/sdk/tunnels/connect`, or `npx mcp-use dev --tunnel`.

## 5. Quote protocol over email

Every message is a readable email. Agent-ready sellers also attach JSON (`application/json`).
A2A tasks carry the same JSON shapes in the task body.

| Part | Direction | Required keys |
|---|---|---|
| `rfq.json` | buyer → seller | `protocol:"haggle.v0"`, `type:"rfq"`, `job_id`, `what`, `requirements[{id,label,mandatory}]`, `reply_by`; optional `quantity{amount,unit}`, `date`, `location`, `budget_hint_usd` |
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
   - amount ≤ approved amount ≤ cap (the cap comes from settings and the job budget)
   - the payee is a business that actually quoted on this job
5. **Stripe test mode** charges the deposit (or the total if no deposit). `receipt_url` goes on the approval view.
6. A refusal returns `status: "refused"` with a `reason` that says how to fix it.

## 7. Database (Supabase Postgres + Realtime)

- Yash: `supabase/migrations/1xx_engine_*.sql` (jobs, businesses per job, messages, calls, quotes, questions, approvals, payments, audit log).
- Aarnav: `supabase/migrations/2xx_brain_*.sql` (profiles, price observations, seller personas).
- Money is `bigint` cents. Inbound events dedupe on `(provider, provider_event_id)`.
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
- **Workspaces.** `workspaces` table (migration 103): jobs, settings and `client_request_id` are per workspace; connections authenticate with a bearer token or `/c/<secret>/mcp` (hashes only). Another workspace's ids read as not found.
- **Tools.** `get_identity`, `send_message`, `negotiate`, `get_conversation`, `cancel_deal`; `wait_for_update(until)`; `approve(action)`; `POST /internal/tick`.

## 10. Public listings and opening hours (migration 125)

- **Listing provider.** `discover` searches Amazon Location Service (Places v2 "geo-places", API key: `AWS_LOCATION_API_KEY`, `AWS_LOCATION_REGION` default `us-east-1`) when set, else Google Places (`GOOGLE_PLACES_API_KEY`), else says discovery is off. Refs: `aws:<PlaceId>` / `place:<Google id>`. Failures are typed: `not_configured | key_rejected | rate_limited | unavailable | area_not_found`. Amazon listings have no ratings or Maps links: `rating`, `review_count` and `maps_url` are simply absent, and every result carries its provider's `attribution`. Browsing uses `IntendedUse=SingleUse`; the GetPlace call made when a business's data is stored (added as a vendor, put on a deal) uses `Storage`.
- **discover `found[]`** adds `published_emails` (the listing's emails first, then the business website's; deduplicated, ≤ 3; was `website_emails`), `hours_today` ("Open today 9am–5pm", the business's timezone) and `hours { display[], source, timezone? }` when known.
- **`WeeklyHours`** (`packages/engine/src/reputation/hours.ts`): `{ timezone: IANA | null, intervals: [{ day 0–6 (Sunday = 0), startMinute, endMinute (> 1440 past midnight) }], display[], source }`. From Amazon `OpeningHours` components (the entry for the place's primary category, else untagged) or, as the fallback, schema.org `openingHoursSpecification` / `openingHours` on the business's own website.
- **Stored.** `job_businesses.opening_hours` (jsonb) + `timezone`, and `workspace_vendors.opening_hours` + `timezone` + `business_ref` (migration `125_engine_business_hours.sql`, nullable). `DealBusiness` and `addWorkspaceVendor` accept `opening_hours` / `timezone`; `POST /internal/vendors` accepts `business_ref`.
- **Contact timing.** A Voice AI call, and a first text, to a business with known hours goes only while it is open and not in the first or last 30 minutes of an opening interval, in its timezone, intersected with `HAGGLE_CALL_HOURS` (calls) or the contact window (texts); otherwise it is scheduled (`next_attempt_at` / `call_scheduled`) for the next allowed time. Unknown hours: unchanged. Emails keep the contact window. A published phone or email is never consent: calls and texts still need a vendor marked `existing_relationship` or `business_agreed`.
