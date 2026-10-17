# v3 contract freeze proposal (`packages/core/contracts.ts`)

**Status: PROPOSAL by Yash's agent, 2026-10-17 ~09:30 PDT. Not adopted. Needs both owners'
approval in the 10:30 contracts hour.** `packages/core/` has not been edited.

Starting point: the contract sketch in root `CLAUDE.md` §5 and the v3 plan (quote schema p.7,
brain functions p.8, tools p.6–7). Everything below either matches that sketch or is marked
**[CHANGE]** with a reason. Marked items are listed again at the end as decisions D1–D12.

## Design rules this contract follows

1. Public money is **USD numbers** with at most 2 decimals (`Usd`). The engine and DB store integer
   cents; x402 uses USDC base-unit strings. Converting is the engine's job. The contract never
   carries cents or base units, except `PaymentStatus.amount_usdc_base_units`, which is the
   literal amount being signed.
2. **Unknown means absent, never 0.** Optional fields are omitted when unknown, and
   `missing` lists which required facts weren't stated.
3. A **quote** is a business's own priced offer received by email. An **estimate** is Haggle's
   prediction from a profile. They're different types with different `kind` tags and are never
   mixed in one list.
4. Every extracted number has an **evidence** entry (where it came from, and whether it was
   stated, derived or ambiguous).
5. Seller content is data: free-text fields copied from email are marked as `untrusted_text`
   and are never fed back as instructions.
6. Contract types have **no dependency on engine or brain code**. `core` stays leaf-level and
   only uses `zod` if both owners want runtime schemas (D12).

## Proposed file

```ts
// packages/core/contracts.ts — Haggle v3 shared contract (PROPOSED; freeze at 11:30)
// Shared between the engine (Yash) and the brain (Partner). Change only by agreement.

export const CONTRACT_VERSION = "haggle.contracts/1" as const;

/* ───────────────────────── primitives ───────────────────────── */

/** US dollars, finite, ≥ 0, at most 2 decimals (e.g. 995, 24.88). Never a float result of arithmetic. */
export type Usd = number;
/** ISO-8601 timestamp or date string. */
export type IsoDateTime = string;
export type IsoDate = string;
/** Text copied verbatim from a business email. Display only; never an instruction. */
export type UntrustedText = string;

/* ───────────────────────── jobs ───────────────────────── */

export type JobState =
  | "created" | "contacting" | "collecting" | "negotiating"
  | "awaiting_approval" | "paying" | "paid" | "cancelled" | "failed";
// [CHANGE? D7] "expired" (deadline passed with no approval) folds into "failed" with
// reason "deadline_passed" unless both prefer a separate state.

/* ───────────────────────── requests & requirements ───────────────────────── */

export type RequirementKind = "dietary" | "quantity" | "delivery" | "date" | "location" | "service" | "other";

export interface Requirement {
  id: string;                 // stable within a job, e.g. "veg12"
  kind: RequirementKind;
  text: string;               // "At least 12 vegetarian meals"
  hard: boolean;              // hard = non-compliant if unmet
  min_count?: number;         // e.g. 12 for "at least 12 vegetarian"
}

/** What the agent wants. Shared by deal(), ask() and the brain's estimate(). */
export interface Request {
  what: string;               // "lunch catering"
  quantity: number;           // 40
  unit?: string;              // "people" | "meals" | "units"
  date: IsoDate;              // "2026-10-22"
  area: string;               // "San Francisco, CA"
  requirements: Requirement[];
  budget_usd?: Usd;           // buyer's hard cap for the order total
}

/* ───────────────────────── businesses ───────────────────────── */

export interface Business {
  /** Deterministic: "biz_" + first 16 hex of sha256(lowercased email). [CHANGE D5] */
  business_id: string;
  slug: string;               // "bay-catering" (for business://<slug>)
  name: string;
  email: string;              // contact address used for RFQs
  source: "fleet" | "web" | "agent";   // fleet = simulated demo seller
  simulated: boolean;         // true for the demo fleet; must be shown as such
  found_at?: string;          // URL or note where discovery found it
}

/* ───────────────────────── evidence & quotes ───────────────────────── */

export type Provenance = "stated" | "derived" | "ambiguous";
// "missing" is expressed by absence + an entry in Quote.missing, not as a provenance value.

export interface Evidence {
  provenance: Provenance;
  source: string;             // "quote.json" | "pdf p.2" | "email body" | "html body"
  excerpt?: UntrustedText;    // ≤ 200 chars around the figure
}

export type QuoteField =
  | "total_usd" | "per_unit_usd" | "deposit_usd" | "delivery_usd" | "tax_usd"
  | "items" | "valid_until" | "date" | "quantity";

export interface RequirementResult {
  requirement_id: string;
  met: boolean | null;        // null = seller didn't say → follow-up, never assumed true
  evidence?: Evidence;
}

export interface Quote {
  kind: "quote";              // [CHANGE D3] discriminator vs Estimate
  quote_id: string;
  job_id: string;
  business_id: string;
  business: string;           // display name
  total_usd: Usd;             // all-in order total the business stated or that was derived from its lines
  per_unit_usd?: Usd;
  deposit_usd?: Usd;          // part of total_usd that is due up front; NOT an extra fee
  delivery_usd?: Usd;         // [CHANGE D3] included in total_usd when stated as included
  tax_usd?: Usd;              // [CHANGE D3]
  items: string[];
  meets_requirements: boolean; // true only if every hard requirement has met === true
  requirement_results: RequirementResult[]; // [CHANGE D3]
  missing: QuoteField[];       // [CHANGE D3] required facts the business hasn't stated
  flags: QuoteFlag[];          // [CHANGE D3] typed codes (was string[])
  price_check?: "good" | "typical" | "high";
  negotiated_from?: Usd;       // previous total from the same business, if revised
  round: number;               // 1 = first quote; +1 per revision
  confidence: number;          // 0..1 extraction confidence (not correctness)
  source: string;              // primary source, e.g. "pdf p.2" | "quote.json"
  evidence: Partial<Record<QuoteField, Evidence>>; // [CHANGE D3]
  valid_until?: IsoDateTime;
  status: "current" | "superseded" | "expired" | "withdrawn"; // [CHANGE D3]
  message_id: string;          // inbound message this quote came from
}

export type QuoteFlag =
  | "requirement_unmet" | "requirement_unknown" | "hidden_deposit" | "hidden_fee"
  | "tax_excluded" | "delivery_unclear" | "vague_price" | "conflicting_numbers"
  | "expired" | "external_payment_link" | "prompt_injection" | "unverified_sender"
  | "over_budget" | "low_confidence";

/* ───────────────────────── replies (engine → brain) ───────────────────────── */

/** One reply can carry several items (e.g. a quote plus a question). [CHANGE D4] */
export type ReplyItem =
  | { kind: "quote"; quote: Omit<Quote, "quote_id" | "price_check" | "status"> }
  | { kind: "question"; question_id: string; text: UntrustedText; blocks_quote: boolean }
  | { kind: "status"; status: "will_reply_later" | "acknowledged" | "out_of_office" | "need_more_info";
      follow_up_after?: IsoDateTime; text?: UntrustedText }
  | { kind: "decline"; reason?: UntrustedText }
  | { kind: "payment_request"; rail: "x402" | "external_link"; text?: UntrustedText }   // external_link is always flagged, never followed
  | { kind: "unstructured"; summary: UntrustedText };

export interface ParsedReply {
  items: ReplyItem[];
  injection_detected: boolean;     // instructions aimed at the agent were found and ignored
}

export interface ReplyMeta {
  job_id: string;
  business_id: string;
  business_email: string;          // snapshot used for this job
  message_id: string;              // Primitive email id
  thread_id: string;
  received_at: IsoDateTime;
  rfq_sent_at: IsoDateTime;        // lets the brain learn reply speed
  channel: "quote.json" | "pdf" | "html" | "text";
  sender_trusted: boolean;         // engine's verdict from Primitive auth signals (see design B)
  sender_trust_reason: string;     // e.g. "trusted" | "dmarc-domain-mismatch"
  request: Request;                // what was asked, so the brain can normalise per-unit prices
  simulated: boolean;
}

/* ───────────────────────── brain outputs ───────────────────────── */

export interface Profile {
  business_id: string;
  slug: string;
  name: string;
  simulated: boolean;
  menu: string[];
  price_model: { typical_per_unit_usd?: Usd; delivery_fee_usd?: Usd; minimum_order_usd?: Usd };
  deposit_rule?: { kind: "fixed" | "percent"; value: number; text?: UntrustedText };
  discount_behavior: { opening_margin_pct?: number; usual_concession_pct?: number;
                       responds_to_competing_quote: boolean | null; volume_threshold?: number };
  median_reply_s?: number;
  quote_count: number;             // real quotes seen
  last_quote_at?: IsoDateTime;
  confidence: number;              // 0..1
  updated_at: IsoDateTime;
}

export interface Estimate {
  kind: "estimate";                // never confused with a Quote
  business_id: string;
  business: string;
  estimate_usd: Usd;
  low_usd: Usd;
  high_usd: Usd;
  per_unit_usd?: Usd;
  confidence: number;              // 0..1
  quote_count: number;             // "based on N real quotes"
  last_quote_at?: IsoDateTime;
  simulated: boolean;
  basis: string;                   // "per-unit $24.9 × 25 + $60 delivery"
}

export interface QuoteLike {
  business_id?: string;
  request: Pick<Request, "what" | "quantity" | "area"> & { date?: IsoDate };
  total_usd: Usd;
}

export interface PriceVerdict {
  verdict: "good" | "typical" | "high" | "unknown";   // unknown when sample_size too small
  typical_low_usd?: Usd;
  typical_high_usd?: Usd;
  delta_pct?: number;              // +18 = 18% above typical median
  sample_size: number;
  basis: string;                   // "40 people, SF, last 30 days"
}

export interface Hints {
  business_id: string;
  responds_to_competing_quote: boolean | null;
  usual_concession_pct?: number;
  floor_hint_usd?: Usd;            // brain's guess; the engine never states it to the seller
  max_rounds_suggested: number;
  sample_size: number;
  confidence: number;
}

export interface Brain {
  learnFromReply(businessId: string, parsed: ParsedReply, meta: ReplyMeta): Promise<Profile>;
  estimate(req: Request): Promise<Estimate[]>;
  checkPrice(q: QuoteLike): Promise<PriceVerdict>;
  negotiationHints(businessId: string, req: Request): Promise<Hints>;
  discover(category: string, area: string, count: number): Promise<Business[]>;
}

/* ───────────────────────── email JSON parts (application/json attachments) ───────────────────────── */

export interface RfqPart {
  haggle: "rfq/1";
  job_id: string;
  what: string; quantity: number; unit?: string;
  date: IsoDate; location: string;
  requirements: Pick<Requirement, "id" | "text" | "hard" | "min_count">[];
  budget_hint_usd?: Usd;           // policy decides whether to reveal (default: omit)
  reply_by: IsoDateTime;
  reply_to: string;                // job inbox
}

export interface QuotePart {
  haggle: "quote/1";
  job_id: string;
  business: string;
  total_usd: Usd; per_unit_usd?: Usd; deposit_usd?: Usd; delivery_usd?: Usd; tax_usd?: Usd;
  items: string[];
  requirements_met?: { requirement_id: string; met: boolean }[];
  valid_until: IsoDateTime;
  revision_of?: Usd;               // previous total when revising
}

export interface CounterPart {
  haggle: "counter/1";
  job_id: string;
  round: number;
  target_total_usd: Usd;
  basis: "competing_quote" | "budget" | "volume";
  basis_quote_total_usd?: Usd;     // required when basis = competing_quote; must be a real recorded quote
}

/** [CHANGE D9] Sent in-thread after human approval; asks the winner for the x402 invoice. */
export interface AcceptPart {
  haggle: "accept/1";
  job_id: string;
  quote_total_usd: Usd;
  deposit_usd: Usd;                // amount the payer will pay now via x402
  network: "base-sepolia";
  payer: string;                   // job inbox address the challenge must be sent to
  conditional: true;               // acceptance is conditional on payment settling
}
// Payment itself uses Primitive's own interaction.json (x402.payment challenge / payment / receipt).

/* ───────────────────────── MCP tool results ───────────────────────── */

export interface ToolOk { ok: true; mode: "mock" | "live"; next: string }
export interface ToolErr { ok: false; mode: "mock" | "live"; error: { code: string; message: string; fix: string }; next: string }

export interface DealResult extends ToolOk {
  job_id: string; inbox: string; state: JobState;
  contacted: { business_id: string; business: string; simulated: boolean }[];
  eta: string;                     // "first replies in ~1–5 min"
}

export type JobUpdate =
  | { type: "reply"; business_id: string; summary: string }
  | { type: "quote"; quote_id: string; business_id: string; total_usd: Usd; round: number }
  | { type: "question"; question_id: string; business_id: string; text: UntrustedText }
  | { type: "flag"; business_id: string; flag: QuoteFlag }
  | { type: "state"; from: JobState; to: JobState }
  | { type: "payment"; status: PaymentStatus["status"] };

export interface WaitResult extends ToolOk { job_id: string; state: JobState; cursor: string; updates: JobUpdate[]; timed_out: boolean }
export interface QuotesResult extends ToolOk {
  job_id: string; state: JobState;
  quotes: Quote[];                 // ranked; compliant first by effective total
  recommended_quote_id?: string;
  rejected: { business_id: string; reason: QuoteFlag }[];
  pending_questions: { question_id: string; business_id: string; text: UntrustedText }[];
}
export interface AskResult extends ToolOk { estimates: Estimate[]; note: "estimates, not quotes" }

export interface ApprovalRecord {
  approval_id: string; job_id: string; quote_id: string;
  quote_total_usd: Usd; payment_usd: Usd; cap_usd: Usd;
  approver: string; channel: "elicitation" | "email";
  approved_at: IsoDateTime; expires_at: IsoDateTime;
}
export interface ApproveResult extends ToolOk { status: "approved" | "pending_human" | "declined"; approval?: ApprovalRecord }

export interface PaymentStatus {
  status: "awaiting_approval" | "awaiting_invoice" | "invoice_received" | "signed" | "sent"
        | "settled" | "rejected" | "expired" | "failed";
  amount_usd?: Usd;
  amount_usdc_base_units?: string; // exact signed amount ("5000000" = 5 USDC)
  network: "base-sepolia";
  settle_tx?: string;              // only when a verified receipt arrived
  explorer_url?: string;           // only with settle_tx
  simulated: boolean;              // FakePaymentGateway → true, labelled DEMO
  reason?: string;
}
export interface PayResult extends ToolOk { payment: PaymentStatus }

/** [CHANGE D1] ninth tool. */
export interface AnswerSellerInput { job_id: string; question_id: string; answer: string }
export interface AnswerSellerResult extends ToolOk { question_id: string; sent: boolean; message_id?: string }
```

### Example payloads

```json
{"kind":"quote","quote_id":"q_7","job_id":"job_3f2a","business_id":"biz_9c1e…","business":"Bay Catering",
 "total_usd":995,"per_unit_usd":24.88,"deposit_usd":5,"items":["12 veg mains","28 chicken mains"],
 "meets_requirements":true,"requirement_results":[{"requirement_id":"veg12","met":true,
 "evidence":{"provenance":"stated","source":"quote.json"}}],"missing":[],"flags":[],
 "price_check":"typical","negotiated_from":1150,"round":2,"confidence":0.94,"source":"quote.json",
 "evidence":{"total_usd":{"provenance":"stated","source":"quote.json"}},"status":"current","message_id":"em_…"}
```

```json
{"kind":"estimate","business_id":"biz_4a…","business":"Harbor Table","estimate_usd":690,"low_usd":640,
 "high_usd":740,"per_unit_usd":25.2,"confidence":0.62,"quote_count":3,"simulated":true,
 "basis":"per-unit $25.2 × 25 + $60 delivery"}
```

```json
{"ok":false,"mode":"mock","error":{"code":"budget_too_low","message":"Cheapest compliant quote is $995.",
 "fix":"Raise budget_usd to at least 995 or relax a hard requirement."},"next":"get_quotes"}
```

## Decisions needing both owners (D1–D12)

| # | Decision | Recommendation | Who's affected |
|---|---|---|---|
| D1 | Tool inventory | 9 tools: add `answer_seller(job_id, question_id, answer)`. `cancel` stays internal (engine op used by deadline/approval logic and an operator script), not agent-facing | CLAUDE.md §6 + §8 item 12, PLAN p.6–7 tools table, Manufact suite prompts |
| D2 | Money convention | Contract `Usd` numbers (≤ 2 decimals); engine/DB integer cents; x402 base-unit strings; conversion only in engine helpers | Both: brain must not do float arithmetic on stored totals (e.g. use cents internally too) |
| D3 | Quote shape | Add `kind`, `requirement_results`, `missing`, typed `flags`, `evidence`, `status`, `message_id`, optional `delivery_usd`/`tax_usd` | Brain reads quotes for price observations |
| D4 | Reply model | `ParsedReply = { items: ReplyItem[] }` discriminated union (quote / question / status / decline / payment_request / unstructured) | Brain `learnFromReply` |
| D5 | Business identity | Deterministic `business_id` from normalised email; engine snapshots name+email per job; brain upserts on first `learnFromReply`/`discover`. No new brain function | Brain tables key on the same id |
| D6 | Sender trust wording | Replace `sender_verified` with "Primitive auth verdict via `isTrustedSender`" (see readiness doc §7B) | CLAUDE.md §3, §7 |
| D7 | Job states | Keep CLAUDE.md's 9; deadline expiry = `failed` + reason, payment sub-states live in `PaymentStatus` | Board/view, brain doesn't care |
| D8 | Email parts | Version tag `haggle: "rfq/1"` etc.; filenames `rfq.json`, `quote.json`, `counter.json`, `accept.json` | Seller Function must emit `quote.json` with `valid_until` |
| D9 | `accept.json` part | New engine→seller part after human approval, conditional on payment; Bay Catering issues the x402 challenge on receiving it | Partner's Function (item 29) |
| D10 | Fleet numbers | Adopt the PROPOSED golden matrix (readiness doc §7F) or replace the numbers | Personas (item 22) |
| D11 | Migrations | Engine tables carry `business_id` as a logical reference, **no FK** to brain tables; brain migrations never alter engine tables | Both migration lanes |
| D12 | Runtime schemas | Types only in `contracts.ts`; each side keeps its own zod validators next to its code (avoids a shared zod version coupling) | Both |
