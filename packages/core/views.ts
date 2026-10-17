/**
 * View schemas: each is a tool's `outputSchema` and the matching view's props.
 * Shared file — both must agree before changing it (CLAUDE.md §4–5).
 *
 * Tools return exactly these shapes as `structuredContent`; views render only what is here.
 * Every shape carries a `next` hint for the agent. Samples live in fixtures/views/*.json.
 */
import { z } from "zod";
import { Channel, Estimate, JobState, Quote } from "./contracts.ts";

const usd = z.number().nonnegative();
const confidence = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// Deal board (get_quotes, open_haggle)

export const BusinessStatus = z.enum([
  "contacted",
  "ringing",
  "on_call",
  "quoted",
  "negotiating",
  "won",
  "declined",
  "no_reply",
]);
export type BusinessStatus = z.infer<typeof BusinessStatus>;

export const DealBoardBusiness = z.object({
  id: z.string(),
  name: z.string(),
  channel: Channel,
  status: BusinessStatus,
  /** One line, e.g. "Sent PDF quote (2 pages)" or "Call ended · completed". */
  last_event: z.string(),
  last_event_at: z.string().optional(),
  /** For phone businesses: a short excerpt of the call transcript. */
  transcript_snippet: z.string().optional(),
});
export type DealBoardBusiness = z.infer<typeof DealBoardBusiness>;

export const OpenQuestion = z.object({
  question_id: z.string(),
  business_id: z.string(),
  business: z.string(),
  text: z.string(),
  asked_at: z.string().optional(),
});
export type OpenQuestion = z.infer<typeof OpenQuestion>;

export const DealBoard = z.object({
  job: z.object({
    id: z.string(),
    /** Human summary of the request, e.g. "Lunch for 40 · Thu Oct 22 · SF". */
    request: z.string(),
    state: JobState,
    budget_usd: usd.optional(),
    requirements: z.array(z.string()),
  }),
  businesses: z.array(DealBoardBusiness),
  /** Ranked best first: compliant quotes by total, then the rest. */
  quotes: z.array(Quote),
  recommended_quote_id: z.string().optional(),
  open_questions: z.array(OpenQuestion),
  next: z.string(),
});
export type DealBoard = z.infer<typeof DealBoard>;

// ---------------------------------------------------------------------------
// Approval card (approve, pay)

export const ApprovalStatus = z.enum(["pending_human", "approved", "paid", "refused"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const Approval = z.object({
  job_id: z.string(),
  quote_id: z.string(),
  business: z.string(),
  /** The business's channel for this quote. */
  quote_channel: Channel,
  /** One line, e.g. "Lunch for 40, 14 vegetarian, delivered Thu 11:30". */
  summary: z.string(),
  items: z.array(z.string()),
  amount_usd: usd,
  deposit_usd: usd.optional(),
  cap_usd: usd,
  status: ApprovalStatus,
  /** How the human approves or approved: iMessage YES or the Approve button in this view. */
  channel: z.enum(["imessage", "view"]),
  /** Masked approver, e.g. "+1 ••• ••• 0142". */
  approver: z.string().optional(),
  approved_at: z.string().optional(),
  paid_at: z.string().optional(),
  receipt_url: z.string().optional(),
  /** Why pay refused, or why approval is still pending. */
  reason: z.string().optional(),
  next: z.string(),
});
export type Approval = z.infer<typeof Approval>;

// ---------------------------------------------------------------------------
// Estimates (ask)

export const Estimates = z.object({
  request: z.object({
    what: z.string(),
    quantity: z.number().int().positive().optional(),
    date: z.string().optional(),
    area: z.string().optional(),
  }),
  /** Cheapest first. Empty when Haggle hasn't learned any matching business yet. */
  estimates: z.array(Estimate),
  /** Always states these are estimates, not quotes. */
  note: z.string(),
  next: z.string(),
});
export type Estimates = z.infer<typeof Estimates>;

// ---------------------------------------------------------------------------
// Business profile (business_profile)

export const BusinessProfileHistory = z.object({
  date: z.string(),
  channel: Channel,
  total_usd: usd.optional(),
  /** e.g. "Quote for 40 people", "Dropped 10% after competing quote". */
  note: z.string(),
});
export type BusinessProfileHistory = z.infer<typeof BusinessProfileHistory>;

export const BusinessProfile = z.object({
  business_id: z.string(),
  name: z.string(),
  category: z.string(),
  area: z.string().optional(),
  best_channel: Channel,
  channels: z.array(Channel),
  menu: z.array(z.string()),
  /** Display strings, e.g. "$24–28 per person". */
  price_model: z.string(),
  minimum: z.string().optional(),
  deposit_rule: z.string().optional(),
  discount_behavior: z.string(),
  reply_speed: z.string(),
  history: z.array(BusinessProfileHistory),
  n_quotes: z.number().int().nonnegative(),
  confidence,
  next: z.string(),
});
export type BusinessProfile = z.infer<typeof BusinessProfile>;
