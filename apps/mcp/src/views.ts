// Engine read models -> the shared view schemas (@haggle/core/views). Every tool that renders a view
// returns exactly one of these shapes, parsed (validated and stripped of engine-only fields).
import { Approval, DealBoard, DealBoardOrEmpty, requirementText, type Channel, type Mode } from "@haggle/core";
import { eventPlace, eventWhen, type DealBoardData } from "@haggle/engine";
import { z } from "zod";

export { BusinessProfile, DealBoard, DealBoardOrEmpty, Estimates } from "@haggle/core";

/**
 * approve/pay output: the shared Approval plus mock mode's "simulated" approval channel (a headless
 * client with neither a form nor a view, DEMO only) and the raw payment status. Contract decision D8
 * is open: until it is settled, "simulated" appears only in mock mode.
 */
export const ApprovalOut = Approval.extend({
  channel: z.enum([...Approval.shape.channel.options, "simulated"]),
  demo: z.string().optional(),
  /** The quote's order total; amount_usd is what is paid now (the deposit). */
  order_total_usd: z.number().nonnegative().optional(),
  /** What amount_usd is: the stated deposit, or the full total because the business stated no deposit. */
  pay_now_basis: z.enum(["deposit", "full_total"]).optional(),
  payment: z.looseObject({ status: z.string(), simulated: z.boolean() }).optional(),
});
export type ApprovalOut = z.infer<typeof ApprovalOut>;

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function requestSummary(r: DealBoardData["job"]["request"]): string {
  return [`${r.what} for ${r.quantity}${r.unit ? ` ${r.unit}` : ""}`, eventWhen(r.date, r.time, r.date_until), eventPlace(r.area, r.venue)].filter(Boolean).join(" · ");
}

/** Flags that mean the business's own words must not be echoed to the model or the view. */
const UNSAFE_TEXT = new Set(["prompt_injection", "external_payment_link"]);

export function toDealBoard(b: DealBoardData, mode: Mode): DealBoard {
  const priced = b.quotes.filter((q) => q.total_usd !== null); // D2: a reply with no total is an open question, not a quote
  const unsafe = new Set(b.quotes.filter((q) => q.flags.some((f) => UNSAFE_TEXT.has(f))).map((q) => q.business_id));
  return DealBoard.parse({
    job: {
      id: b.job.id, request: requestSummary(b.job.request), state: b.job.state,
      ...(b.job.budget_usd !== null ? { budget_usd: b.job.budget_usd } : {}),
      requirements: b.job.request.requirements.map(requirementText),
    },
    businesses: b.businesses.map((x) => ({
      id: x.business_id, name: x.name, channel: x.channel, status: x.status, last_event: x.last_event ?? "Contacted",
      simulated: x.simulated,
      ...(x.transcript_snippet && !unsafe.has(x.business_id) ? { transcript_snippet: x.transcript_snippet } : {}),
      ...(x.unavailable_reason ? { unavailable_reason: x.unavailable_reason } : {}),
    })),
    quotes: priced.map((q) => ({ ...q, round: Math.max(1, q.round) })),
    ...(b.recommended_quote_id ? { recommended_quote_id: b.recommended_quote_id } : {}),
    open_questions: b.open_questions,
    next: b.next,
    mode,
    rejected: b.rejected,
    negotiation: b.negotiation,
    approval: b.approval ? { approval_id: b.approval.approval_id, quote_id: b.approval.quote_id, status: b.approval.status, channel: b.approval.channel } : null,
    payment: b.payment ? { status: b.payment.status, simulated: b.payment.simulated, ...(b.payment.receipt_url ? { receipt_url: b.payment.receipt_url } : b.payment.explorer_url ? { receipt_url: b.payment.explorer_url } : {}) } : null,
    ready: b.ready,
  });
}

const Blocker = z.object({ vendor: z.string(), channel: z.string(), reason: z.string(), fix: z.string() });

/**
 * The deal board as Haggle's tools return it (deal, get_quotes, open_haggle): the shared DealBoard
 * plus engine/server additions the board shows when present. Extends (never edits) @haggle/core.
 */
export const DealBoardPlus = DealBoardOrEmpty.extend({
  ok: z.boolean().optional(),
  job_id: z.string().optional(),
  /** Exactly what the businesses were asked, so the human can check the parse. */
  request_details: z.object({
    what: z.string(), headcount: z.number().int(), when: z.string(), place: z.string(), date: z.string(), time: z.string().optional(),
    requirements: z.array(z.string()), budget_usd: z.number().nullable(), budget_source: z.enum(["request", "settings_default"]).optional(),
  }).optional(),
  /** Operator/settings ceiling for any single payment (the deposit), separate from the order budget. */
  payment_ceiling_usd: z.number().nonnegative().optional(),
  payments_enabled: z.boolean().optional(),
  /** Per quote: can the human approve it now, and if not, why (the server decides; the view only shows it). */
  quote_status: z.record(z.string(), z.object({ approvable: z.boolean(), approximate: z.boolean().optional(), block: z.object({ code: z.string(), reason: z.string() }).optional() })).optional(),
  /** The best-value quote when it isn't the recommendation because it can't be approved; and why. */
  best_value_quote_id: z.string().optional(),
  recommendation_note: z.string().optional(),
  /** Quote ids that counteroffers cited as estimates ("about $1,200"), not firm quotes. */
  negotiation_estimates: z.array(z.string()).optional(),
  /** deal(dry_run): who would be contacted; nothing was sent. */
  dry_run: z.boolean().optional(),
  would_contact: z.array(z.looseObject({ name: z.string(), channel: z.string().optional() })).optional(),
  blocked: z.array(z.looseObject({ name: z.string(), contact_state: z.string() })).optional(),
  /** Best-value ranking of eligible quotes: per-quote factors with evidence, weights and the why. */
  value: z.looseObject({
    method: z.literal("best_value"), weights: z.record(z.string(), z.number()), recommendedQuoteId: z.string().nullable(),
    ranked: z.array(z.looseObject({ quoteId: z.string(), business: z.string(), score: z.number(), confidence: z.number(), factors: z.array(z.looseObject({ name: z.string(), score: z.number(), weight: z.number(), neutral: z.boolean(), note: z.string() })) })),
    explanation: z.object({ winner: z.string(), others: z.array(z.object({ quote_id: z.string(), text: z.string() })) }).nullable(),
  }).optional(),
  /** Per business: where it is in the deal and the negotiation outcome (a counteroffer is never a price). */
  stages: z.record(z.string(), z.object({
    stage: z.string(), negotiation: z.enum(["none", "countered", "vendor_revised", "held_firm"]),
    first_total_usd: z.number().optional(), current_total_usd: z.number().optional(), quote_version: z.number().int().optional(), saved_usd: z.number().optional(),
  })).optional(),
  /** Per business: observed reply performance by channel across all jobs, and any stated contact preference. */
  contact_learning: z.record(z.string(), z.looseObject({
    channels: z.record(z.string(), z.looseObject({ contacted_jobs: z.number(), replied_jobs: z.number(), quotes: z.number(), response_rate: z.number(), confidence: z.number() })),
    stated_preference: z.looseObject({ channel: z.string(), excerpt: z.string() }).optional(),
  })).optional(),
  /** Per current quote: extra fees and commercial terms exactly as stated. */
  terms: z.record(z.string(), z.looseObject({
    fees: z.array(z.looseObject({ label: z.string(), amount_usd: z.number().optional(), included: z.boolean().nullable(), excerpt: z.string() })).optional(),
    deposit_terms: z.string().nullable().optional(), cancellation: z.string().nullable().optional(), exclusions: z.array(z.string()).optional(),
  })).optional(),
  /** Negotiation callbacks the evidence justifies; each needs the human's go-ahead (call_back). */
  callbacks: z.array(z.looseObject({ business_id: z.string(), business: z.string(), their_total_usd: z.number(), basis_total_usd: z.number(), basis_business: z.string(), why: z.string() })).optional(),
  contacted: z.array(z.looseObject({ business: z.string(), channel: z.string() })).optional(),
  not_contacted: z.array(z.looseObject({ business: z.string(), channel: z.string(), reason: z.string() })).optional(),
  warnings: z.array(z.string()).optional(),
  /** Demo vendors this server can't contact yet, with the exact fix. Shown before and during a deal. */
  setup: z.object({ ready: z.number().int(), total: z.number().int(), blockers: z.array(Blocker) }).optional(),
});
export type DealBoardPlus = z.infer<typeof DealBoardPlus>;

export function requestDetails(b: DealBoardData, budgetSource?: "request" | "settings_default"): NonNullable<DealBoardPlus["request_details"]> {
  const r = b.job.request;
  return {
    what: r.what, headcount: r.quantity, when: eventWhen(r.date, r.time, r.date_until), place: eventPlace(r.area, r.venue), date: r.date, ...(r.time ? { time: r.time } : {}),
    requirements: r.requirements.map(requirementText), budget_usd: b.job.budget_usd, ...(budgetSource ? { budget_source: budgetSource } : {}),
  };
}

/** Board + request details + payment ceiling (+ setup blockers when given). */
export function toDealBoardPlus(b: DealBoardData, mode: Mode, extra: Partial<DealBoardPlus> = {}): DealBoardPlus {
  return DealBoardPlus.parse({
    ...toDealBoard(b, mode), empty: false, job_id: b.job.id, request_details: requestDetails(b), ...(b.payment_ceiling_usd !== undefined ? { payment_ceiling_usd: b.payment_ceiling_usd } : {}), ...(b.payments_enabled !== undefined ? { payments_enabled: b.payments_enabled } : {}), ...(b.value ? { value: b.value } : {}), ...(b.callbacks ? { callbacks: b.callbacks } : {}), ...(b.stages ? { stages: b.stages } : {}), ...(b.terms && Object.keys(b.terms).length ? { terms: b.terms } : {}), ...(b.contact_learning ? { contact_learning: b.contact_learning } : {}),
    quote_status: Object.fromEntries(b.quotes.filter((q) => q.total_usd !== null).map((q) => [q.quote_id, { approvable: q.approvable, ...(q.total_approximate ? { approximate: true } : {}), ...(q.approval_block ? { block: q.approval_block } : {}) }])),
    ...(b.best_value_quote_id ? { best_value_quote_id: b.best_value_quote_id } : {}), ...(b.recommendation_note ? { recommendation_note: b.recommendation_note } : {}),
    ...(b.negotiation.some((n) => n.basis_approximate) ? { negotiation_estimates: [...new Set(b.negotiation.filter((n) => n.basis_approximate).map((n) => n.basis_quote_id))] } : {}), ...extra,
  });
}

export function emptyBoard(mode: Mode): DealBoardOrEmpty {
  return DealBoardOrEmpty.parse({ job: null, empty: true, businesses: [], quotes: [], open_questions: [], mode, next: "No deals yet. Call deal with what to buy, or ask for an instant estimate." });
}

export function toApproval(
  b: DealBoardData, quote_id: string, status: ApprovalOut["status"], mode: Mode,
  extra: { next: string; reason?: string; demo?: string },
): ApprovalOut {
  const q = b.quotes.find((x) => x.quote_id === quote_id);
  const a = b.approval?.quote_id === quote_id ? b.approval : null;
  const total = q?.total_usd ?? a?.quote_total_usd ?? 0;
  // What is paid now: the stated deposit, or the full total when the business stated none (the engine's
  // rule). Never "$0": an unstated deposit is not a free deposit.
  const deposit = q?.deposit_usd;
  const payNow = a?.payment_usd ?? deposit ?? total;
  const basis = deposit !== undefined ? "deposit" as const : "full_total" as const;
  const business = q?.business ?? "unknown";
  const channel: Channel = q?.channel ?? b.businesses.find((x) => x.business_id === q?.business_id)?.channel ?? "email";
  const how = a?.channel === "elicitation" || a?.channel === "view" || a?.channel === "imessage" || a?.channel === "simulated" ? a.channel : "view";
  return ApprovalOut.parse({
    job_id: b.job.id, quote_id, business, quote_channel: channel,
    summary: `${business}: ${money(total)} order total; ${basis === "deposit" ? `pay ${money(payNow)} deposit now` : `pay ${money(payNow)} now (full total: no deposit stated)`}`,
    items: q?.items ?? [], amount_usd: payNow, ...(q || a ? { order_total_usd: total } : {}), ...(deposit !== undefined ? { deposit_usd: deposit } : {}), pay_now_basis: basis, cap_usd: a?.cap_usd ?? payNow,
    status, channel: how,
    ...(a?.approved_at ? { approved_at: a.approved_at } : {}),
    ...(a ? { approval_id: a.approval_id, expires_at: a.expires_at } : {}),
    ...(b.payment ? { payment: b.payment } : {}),
    ...(b.payment?.receipt_url ? { receipt_url: b.payment.receipt_url } : b.payment?.explorer_url ? { receipt_url: b.payment.explorer_url } : {}),
    mode, ...extra,
  });
}
