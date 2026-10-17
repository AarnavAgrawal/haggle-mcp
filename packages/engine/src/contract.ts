// packages/engine/src/contract.ts: the ENGINE-INTERNAL types (formerly the v3 packages/core contract).
// Not shared. The engine/brain seam is @haggle/core (v5); src/brain/adapter.ts translates between the two.


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
// D7: deadline expiry with no approval is "failed" with reason "deadline_passed". Payment
// sub-states live in PaymentStatus.

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
  /** Deterministic: "biz_" + first 16 hex of sha256(lowercased email). (D5) */
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
  kind: "quote";
  quote_id: string;
  job_id: string;
  business_id: string;
  business: string;           // display name
  total_usd: Usd;             // all-in order total the business stated or that was derived from its lines
  per_unit_usd?: Usd;
  deposit_usd?: Usd;          // part of total_usd that is due up front; NOT an extra fee
  delivery_usd?: Usd;
  tax_usd?: Usd;
  items: string[];
  meets_requirements: boolean; // true only if every hard requirement has met === true
  requirement_results: RequirementResult[];
  missing: QuoteField[];
  flags: QuoteFlag[];
  price_check?: "good" | "typical" | "high";
  negotiated_from?: Usd;       // previous total from the same business, if revised
  round: number;               // 1 = first quote; +1 per revision
  confidence: number;          // 0..1 extraction confidence (not correctness)
  source: string;              // primary source, e.g. "pdf p.2" | "quote.json"
  evidence: Partial<Record<QuoteField, Evidence>>;
  valid_until?: IsoDateTime;
  status: "current" | "superseded" | "expired" | "withdrawn";
  message_id: string;          // inbound message this quote came from
}

export type QuoteFlag =
  | "requirement_unmet" | "requirement_unknown" | "hidden_deposit" | "hidden_fee"
  | "tax_excluded" | "delivery_unclear" | "vague_price" | "conflicting_numbers"
  | "expired" | "external_payment_link" | "prompt_injection" | "unverified_sender"
  | "over_budget" | "low_confidence" | "question_pending" | "unsourced_figure";

/* ───────────────────────── replies (engine → brain) ───────────────────────── */

/** One reply can carry several items (e.g. a quote plus a question). (D4) */
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

/** (D9) Sent in-thread after human approval; asks the winner for the x402 invoice. */
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

/** (D1) ninth tool: answers a business's pending question in its thread. */
export interface AnswerSellerInput { job_id: string; question_id: string; answer: string }
export interface AnswerSellerResult extends ToolOk { question_id: string; sent: boolean; message_id?: string }
