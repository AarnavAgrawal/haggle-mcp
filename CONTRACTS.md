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

- `Approval.status`: `pending_human | approved | paid | refused`.
- Views render only what is in the schema. If a view needs a new field, add it to `views.ts` and the fixture first (shared change).

## 3. State machines

**Job:**
```
created → contacting → collecting ⇄ negotiating → awaiting_approval → paying → paid
side exits from any non-terminal state: cancelled, failed
```
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
