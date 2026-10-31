/**
 * Haggle contracts: the typed seam between the engine (Yash) and the brain (Aarnav).
 * Shared file — both must agree before changing it (CLAUDE.md §4–5).
 *
 * Every type is a zod schema plus its inferred type, so either side can validate data
 * crossing the seam. Money is decimal USD. Dates are ISO 8601 strings.
 */
import { z } from "zod";

/** Bump on every change to this file or views.ts (CONTRACTS.md: "Changing a frozen surface"). */
export const CONTRACT_VERSION = "haggle.contracts/6" as const;
// v6 (additive, agreed for the haggle-testing parity branch): JobState "confirmed"; Quote.fields /
// missing_fields / total_known for custom asks; views.ts: DealBoard.job.ask / compare_by,
// Approval.action, ApprovalStatus "confirmed", Conversation and Identity view schemas.

// ---------------------------------------------------------------------------
// Basics

export const Channel = z.enum(["email", "phone", "a2a", "imessage"]);
export type Channel = z.infer<typeof Channel>;

export const JobState = z.enum([
  "created",
  "contacting",
  "collecting",
  "negotiating",
  "awaiting_approval",
  "paying",
  "paid",
  /** A confirm-only approval: the business was told to go ahead, nothing was paid. */
  "confirmed",
  "cancelled",
  "failed",
]);
export type JobState = z.infer<typeof JobState>;

const usd = z.number().nonnegative();
const confidence = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// Businesses and requests

export const Business = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  /** E.164, e.g. "+14155550123". */
  phone: z.string().optional(),
  a2a_card_url: z.string().optional(),
  best_channel: Channel,
  /** Where Haggle learned about this business, e.g. "haggle-directory", "user". */
  source: z.string(),
  /** True for the simulated demo fleet; anything simulated is labeled DEMO wherever it is shown. */
  simulated: z.boolean().optional(),
  /** URL or note where discovery found the business. */
  found_at: z.string().optional(),
});
export type Business = z.infer<typeof Business>;

/** A structured requirement. The engine checks hard ones against every quote. */
export const RequirementKind = z.enum(["dietary", "quantity", "delivery", "date", "location", "service", "other"]);
export type RequirementKind = z.infer<typeof RequirementKind>;

export const Requirement = z.object({
  /** Stable within a job, e.g. "veg12". */
  id: z.string(),
  kind: RequirementKind,
  /** e.g. "At least 12 vegetarian meals". */
  text: z.string(),
  /** Hard = the quote is non-compliant if unmet. */
  hard: z.boolean(),
  /** e.g. 12 for "at least 12 vegetarian". */
  min_count: z.number().int().positive().optional(),
});
export type Requirement = z.infer<typeof Requirement>;

/** The display text of a requirement given either as a plain string or as a Requirement. */
export function requirementText(r: string | Requirement): string {
  return typeof r === "string" ? r : r.text;
}

/** What a buyer agent wants. `ask` uses what/quantity/date/area; `deal` adds the rest. */
export const Request = z.object({
  what: z.string(),
  /** Normalized category for learning, e.g. "catering". Derived from `what` when absent. */
  category: z.string().optional(),
  quantity: z.number().int().positive().optional(),
  /** Unit for quantity; "people" when absent. */
  unit: z.string().optional(),
  /** ISO date (YYYY-MM-DD). */
  date: z.string().optional(),
  area: z.string().optional(),
  /** Plain strings ("12 vegetarian") or structured Requirements; use requirementText() to display. */
  requirements: z.array(z.union([z.string(), Requirement])).default([]),
  budget_usd: usd.optional(),
});
export type Request = z.input<typeof Request>;

// ---------------------------------------------------------------------------
// Quotes

/**
 * Known quote flags. `Quote.flags` stays `string[]` so new flags don't break the seam;
 * views render unknown flags as plain text.
 */
export const QUOTE_FLAGS = [
  "requirement_unmet", // e.g. 6 of 12 vegetarian meals
  "requirement_unknown", // business didn't say whether a hard requirement is met
  "hidden_deposit", // deposit only mentioned in the fine print / page 2
  "hidden_fee",
  "tax_excluded",
  "delivery_unclear",
  "vague_price",
  "conflicting_numbers",
  "unsourced_figure",
  "external_payment_link", // business asked to pay at a link: never followed
  "prompt_injection", // business text tried to instruct the agent
  "unverified_sender",
  "over_budget",
  "low_confidence",
  "question_pending",
  "expired",
  "price_implausible", // far below the usual range for what was asked: not approvable until the business confirms
  "price_confirmed_unusual", // the business confirmed a price far below the usual range: approvable, with a caveat
  "price_unusually_high", // far above the usual range: a caveat only
] as const;
export type QuoteFlag = (typeof QUOTE_FLAGS)[number];

/** "too_low": far below the usual range (under 40% of its low end per unit): suspicious, not a bargain. */
export const PriceCheck = z.enum(["good", "typical", "high", "too_low"]);
export type PriceCheck = z.infer<typeof PriceCheck>;

export const Quote = z.object({
  quote_id: z.string(),
  job_id: z.string(),
  business_id: z.string(),
  business: z.string(),
  channel: Channel,
  total_usd: usd,
  per_unit_usd: usd.optional(),
  deposit_usd: usd.optional(),
  items: z.array(z.string()),
  meets_requirements: z.boolean(),
  flags: z.array(z.string()),
  price_check: PriceCheck.optional(),
  /** Total before negotiation, when this quote is a negotiated revision. */
  negotiated_from: usd.optional(),
  round: z.number().int().min(1),
  confidence,
  /** Where the numbers came from, e.g. "email:pdf p2", "call transcript", "a2a:quote.json". */
  source: z.string(),
  // Engine additions (all optional): ranking, revisions and audit trail.
  /** Can be approved: compliant, current, from a trusted sender, within budget. */
  eligible: z.boolean().optional(),
  verdict: z.enum(["compliant", "rejected", "incomplete"]).optional(),
  /** Why the quote is not eligible, e.g. "requirement_unmet". */
  excluded_reason: z.string().optional(),
  delivery_usd: usd.optional(),
  tax_usd: usd.optional(),
  valid_until: z.string().optional(),
  status: z.enum(["current", "superseded", "expired", "withdrawn"]).optional(),
  /** Inbox message, call or A2A task this quote came from. */
  message_id: z.string().optional(),
  // v6, custom asks (requests that aren't the catering default; all optional):
  /** Answers by ask key; money in USD, dates YYYY-MM-DD; null = not stated. */
  fields: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).optional(),
  /** Labels of required answers still missing (a follow-up asks for them). */
  missing_fields: z.array(z.string()).optional(),
  /** False when the business stated no total (total_usd is then 0 and means "unknown"). */
  total_known: z.boolean().optional(),
});
export type Quote = z.infer<typeof Quote>;

// ---------------------------------------------------------------------------
// Replies: what the engine's parser hands the brain after every business reply

export const ReplyKind = z.enum(["quote", "question", "decline", "no_answer", "other"]);
export type ReplyKind = z.infer<typeof ReplyKind>;

export const ParsedReply = z.object({
  kind: ReplyKind,
  total_usd: usd.optional(),
  per_unit_usd: usd.optional(),
  /** Quantity the quote is priced for (people, units). */
  quantity: z.number().int().positive().optional(),
  deposit_usd: usd.optional(),
  delivery_usd: usd.optional(),
  minimum_order_usd: usd.optional(),
  minimum_quantity: z.number().int().positive().optional(),
  /** Menu / line items as short strings, e.g. "Veggie lasagna (vegetarian)". */
  items: z.array(z.string()).default([]),
  /** The business's question, when kind = "question". */
  question: z.string().optional(),
  /** Engine id for that question (answer_business uses it). */
  question_id: z.string().optional(),
  /** The parser found instructions aimed at the agent and ignored them. */
  injection_detected: z.boolean().optional(),
  flags: z.array(z.string()).default([]),
  confidence: confidence.default(0.8),
});
export type ParsedReply = z.input<typeof ParsedReply>;

export const ReplyMeta = z.object({
  job_id: z.string(),
  business_name: z.string(),
  channel: Channel,
  /** When the business replied. */
  received_at: z.string(),
  /** When Haggle contacted the business in this round (for reply speed). */
  contacted_at: z.string().optional(),
  round: z.number().int().min(1).default(1),
  request: Request,
  /** For round ≥ 2: the total before this round's counteroffer. */
  negotiated_from: usd.optional(),
  /** For round ≥ 2: whether Haggle's counter cited a real competing quote. */
  cited_competing_quote: z.boolean().optional(),
  // CONTRACTS.md section 1 fields (optional so brain fixtures stay valid).
  business_id: z.string().optional(),
  /** Inkbox message id, call id, iMessage id or A2A task id. */
  message_id: z.string().optional(),
  /** Format the reply arrived in; the channel is `channel`. */
  format: z.enum(["quote.json", "pdf", "html", "text", "transcript", "a2a"]).optional(),
  /** Inkbox webhook signature + sender matched the business record. The engine only teaches the brain trusted replies. */
  sender_trusted: z.boolean().optional(),
  simulated: z.boolean().optional(),
});
export type ReplyMeta = z.input<typeof ReplyMeta>;

// ---------------------------------------------------------------------------
// Brain outputs

export const PriceModel = z.enum(["per_unit", "flat", "unknown"]);
export type PriceModel = z.infer<typeof PriceModel>;

export const ProfileHistoryEntry = z.object({
  date: z.string(),
  job_id: z.string(),
  channel: Channel,
  kind: ReplyKind,
  total_usd: usd.optional(),
  per_unit_usd: usd.optional(),
  quantity: z.number().int().positive().optional(),
  round: z.number().int().min(1),
  negotiated_from: usd.optional(),
  reply_minutes: z.number().nonnegative().optional(),
});
export type ProfileHistoryEntry = z.infer<typeof ProfileHistoryEntry>;

/** Everything Haggle has learned about one business: its "API". */
export const Profile = z.object({
  business_id: z.string(),
  name: z.string(),
  category: z.string(),
  area: z.string().optional(),
  best_channel: Channel,
  channels_seen: z.array(Channel),
  menu: z.array(z.string()),
  price_model: PriceModel,
  /** Typical price per unit (e.g. per person) across learned quotes. */
  per_unit_usd: z.object({ low: usd, typical: usd, high: usd }).optional(),
  minimum_order_usd: usd.optional(),
  minimum_quantity: z.number().int().positive().optional(),
  /** Deposit as a fraction of the total (0.25 = 25%). */
  deposit_pct: z.number().min(0).max(1).optional(),
  /** Typical discount given in negotiation (0.1 = 10%); 0 = never moves. */
  discount_pct: z.number().min(0).max(1).optional(),
  /** Whether the discount only came after citing a competing quote. */
  discount_needs_competing_quote: z.boolean().optional(),
  median_reply_minutes: z.number().nonnegative().optional(),
  asks_questions: z.boolean(),
  flags_seen: z.array(z.string()),
  n_quotes: z.number().int().nonnegative(),
  history: z.array(ProfileHistoryEntry),
  confidence,
  updated_at: z.string(),
});
export type Profile = z.infer<typeof Profile>;

export const Estimate = z.object({
  business_id: z.string(),
  business: z.string(),
  total_usd: usd,
  per_unit_usd: usd.optional(),
  confidence,
  /** Number of real quotes this estimate is based on. */
  n_quotes: z.number().int().nonnegative(),
  best_channel: Channel,
  /** Human-readable basis, e.g. "based on 3 real quotes, $24–27 per person". */
  basis: z.string(),
  low_usd: usd.optional(),
  high_usd: usd.optional(),
  simulated: z.boolean().optional(),
});
export type Estimate = z.infer<typeof Estimate>;

/** Anything with a price that can be checked: a Quote, a ParsedReply or a hand-made object. */
export const QuoteLike = z.object({
  total_usd: usd,
  quantity: z.number().int().positive().optional(),
  per_unit_usd: usd.optional(),
  category: z.string().optional(),
  area: z.string().optional(),
  business_id: z.string().optional(),
});
export type QuoteLike = z.input<typeof QuoteLike>;

export const PriceVerdict = z.object({
  /** "unknown" when the sample is too small to judge; Quote.price_check is then omitted. */
  verdict: z.enum([...PriceCheck.options, "unknown"]),
  /** Typical price per unit for this category and area. */
  typical_per_unit_usd: usd.optional(),
  range_per_unit_usd: z.object({ low: usd, high: usd }).optional(),
  /** +0.18 = 18% above typical. */
  delta_pct: z.number().optional(),
  sample_size: z.number().int().nonnegative(),
  /** e.g. "18% above typical for 40 people in SF". */
  summary: z.string(),
});
export type PriceVerdict = z.infer<typeof PriceVerdict>;

export const Hints = z.object({
  business_id: z.string(),
  /** Typical discount this business accepts (0.1 = 10%). */
  expected_discount_pct: z.number().min(0).max(1),
  /** Whether citing a real competing quote is what moves this business. */
  cite_competing_quote: z.boolean(),
  /** Lowest per-unit price this business has accepted before. */
  floor_per_unit_usd: usd.optional(),
  /** Short tactics for the counteroffer, never inventing quotes. */
  tactics: z.array(z.string()),
  confidence,
});
export type Hints = z.infer<typeof Hints>;

// ---------------------------------------------------------------------------
// The brain interface (implemented in packages/brain, called by the engine and tools)

export interface Brain {
  learnFromReply(businessId: string, parsed: ParsedReply, meta: ReplyMeta): Promise<Profile>;
  estimate(req: Request): Promise<Estimate[]>;
  checkPrice(q: QuoteLike): Promise<PriceVerdict>;
  negotiationHints(businessId: string, req: Request): Promise<Hints>;
  discover(category: string, area: string, count: number): Promise<Business[]>;
  /** Read a learned profile by id or (case-insensitive) name; null when unknown. */
  getProfile(business: string): Promise<Profile | null>;
}
