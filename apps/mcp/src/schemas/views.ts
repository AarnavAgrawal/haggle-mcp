// View data schemas: each is a tool `outputSchema` and the props of one view.
//
// PROPOSED for packages/core/views.ts (shared; needs Yash + Aarnav agreement, CLAUDE.md §4-5).
// packages/core/views.ts does not exist yet, so the buyer side keeps the proposal here and the
// tools validate against it. Moving it is a file move: no shape changes. Everything in CLAUDE.md
// §5 is present; additions are marked "addition" and are optional for a view to render.
//
// Objects are loose (unknown keys pass) so the engine can add fields without breaking a view, and
// the v3 deal-board view keeps working (it reads business_names, pending_questions, request, ...).
import { z } from "zod";

export const Channel = z.enum(["email", "phone", "a2a", "imessage"]);
export const Mode = z.enum(["mock", "live"]).describe("mock = simulated DEMO data, never real");
export const JobState = z.enum(["created", "contacting", "collecting", "negotiating", "awaiting_approval", "paying", "paid", "cancelled", "failed"]);

const envelope = { ok: z.boolean(), mode: Mode, next: z.string().describe("What the agent should do next") };

export const Requirement = z.looseObject({ id: z.string(), kind: z.string(), text: z.string(), hard: z.boolean(), min_count: z.number().int().optional() });
export const Request = z.looseObject({
  what: z.string(), quantity: z.number(), unit: z.string().optional(), date: z.string(), area: z.string(), requirements: z.array(Requirement),
});

export const Quote = z.looseObject({
  quote_id: z.string(), job_id: z.string(), business_id: z.string(), business: z.string(), channel: Channel,
  total_usd: z.number().nullable().describe("null when the business hasn't stated a total (never 0)"),
  per_unit_usd: z.number().optional(), deposit_usd: z.number().optional(), items: z.array(z.string()),
  meets_requirements: z.boolean(), flags: z.array(z.string()), price_check: z.enum(["good", "typical", "high"]).optional(),
  negotiated_from: z.number().optional(), round: z.number().int(), confidence: z.number(), source: z.string(),
  // additions
  eligible: z.boolean(), verdict: z.enum(["compliant", "rejected", "incomplete"]), excluded_reason: z.string().optional(),
});

export const BusinessStatus = z.enum(["contacted", "ringing", "on_call", "quoted", "negotiating", "won", "declined", "no_reply", "unavailable"]);

export const DealBoard = z.looseObject({
  ...envelope,
  job: z.looseObject({ id: z.string(), request: Request, state: JobState, budget_usd: z.number().nullable() }),
  businesses: z.array(z.looseObject({
    id: z.string(), name: z.string(), channel: Channel, status: BusinessStatus, last_event: z.string().nullable(), transcript_snippet: z.string().optional(),
    simulated: z.boolean(), unavailable_reason: z.string().optional(), // additions
  })),
  quotes: z.array(Quote).describe("Ranked: eligible quotes first, cheapest first"),
  open_questions: z.array(z.looseObject({ question_id: z.string(), business_id: z.string(), business: z.string(), text: z.string() })),
  // additions
  recommended_quote_id: z.string().optional(),
  rejected: z.array(z.looseObject({ business_id: z.string(), quote_id: z.string(), reason: z.string(), detail: z.string() })),
  negotiation: z.array(z.looseObject({ business_id: z.string(), business: z.string(), round: z.number(), target_total_usd: z.number(), basis_quote_id: z.string(), outcome_total_usd: z.number().nullable() })),
  approval: z.looseObject({ approval_id: z.string(), quote_id: z.string(), status: z.string(), channel: z.string() }).nullable(),
  payment: z.looseObject({ status: z.string(), simulated: z.boolean() }).nullable(),
  ready: z.boolean(),
});

/** open_haggle with no job yet: an empty board the launcher can render. */
export const DealBoardOrEmpty = z.looseObject({
  ...envelope,
  job: z.looseObject({ id: z.string(), request: Request, state: JobState, budget_usd: z.number().nullable() }).nullable(),
  businesses: DealBoard.shape.businesses,
  quotes: DealBoard.shape.quotes,
  open_questions: DealBoard.shape.open_questions,
  empty: z.boolean().optional().describe("true when there is no deal yet"),
});

export const Approval = z.looseObject({
  ...envelope,
  job_id: z.string(), quote_id: z.string(),
  quote: z.looseObject({ business: z.string(), total_usd: z.number(), items: z.array(z.string()) }),
  amount_usd: z.number().describe("What gets paid now (the deposit)"),
  deposit_usd: z.number(),
  cap_usd: z.number(),
  status: z.enum(["pending_human", "approved", "paid", "refused"]),
  channel: z.string().describe("How the human approves: view | elicitation | email | imessage | simulated"),
  receipt_url: z.string().optional(),
  reason: z.string().optional(),
  // additions
  approval_id: z.string().optional(), expires_at: z.string().optional(),
  payment: z.looseObject({ status: z.string(), simulated: z.boolean() }).optional(),
});

export const Estimates = z.looseObject({
  ...envelope,
  request: z.looseObject({ what: z.string(), quantity: z.number(), date: z.string(), area: z.string() }),
  estimates: z.array(z.looseObject({
    business: z.string(), total_usd: z.number(), per_unit_usd: z.number().optional(), confidence: z.number(), n_quotes: z.number().int(), best_channel: Channel,
    business_id: z.string(), low_usd: z.number(), high_usd: z.number(), simulated: z.boolean(), // additions
  })),
  note: z.literal("estimates, not quotes"),
  brain: z.string().describe("connected | stub (not learning yet)"),
});

export const BusinessProfile = z.looseObject({
  ...envelope,
  name: z.string(), best_channel: Channel, menu: z.array(z.string()),
  price_model: z.looseObject({ typical_per_unit_usd: z.number().optional(), delivery_fee_usd: z.number().optional(), minimum_order_usd: z.number().optional() }),
  minimum: z.number().nullable(), deposit_rule: z.string().nullable(), discount_behavior: z.string(), reply_speed: z.string().nullable(),
  history: z.array(z.looseObject({ date: z.string(), channel: Channel, total: z.number() })),
  confidence: z.number(),
  business_id: z.string(), simulated: z.boolean(), quote_count: z.number().int(), // additions
});

export type DealBoardT = z.infer<typeof DealBoard>;
