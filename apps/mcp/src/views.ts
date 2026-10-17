// Engine read models -> the shared view schemas (@haggle/core/views). Every tool that renders a view
// returns exactly one of these shapes, parsed (validated and stripped of engine-only fields).
import { Approval, DealBoard, DealBoardOrEmpty, requirementText, type Channel, type Mode } from "@haggle/core";
import type { DealBoardData } from "@haggle/engine";
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
  payment: z.looseObject({ status: z.string(), simulated: z.boolean() }).optional(),
});
export type ApprovalOut = z.infer<typeof ApprovalOut>;

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function requestSummary(r: DealBoardData["job"]["request"]): string {
  return [`${r.what} for ${r.quantity}${r.unit ? ` ${r.unit}` : ""}`, r.date, r.area].filter(Boolean).join(" · ");
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
  const payNow = a?.payment_usd ?? q?.deposit_usd ?? 0;
  const business = q?.business ?? "unknown";
  const channel: Channel = q?.channel ?? b.businesses.find((x) => x.business_id === q?.business_id)?.channel ?? "email";
  const how = a?.channel === "elicitation" || a?.channel === "view" || a?.channel === "imessage" || a?.channel === "simulated" ? a.channel : "view";
  return ApprovalOut.parse({
    job_id: b.job.id, quote_id, business, quote_channel: channel,
    summary: `${business}: ${money(total)} order total; pay ${money(payNow)} deposit now`,
    items: q?.items ?? [], amount_usd: payNow, ...(q || a ? { order_total_usd: total } : {}), deposit_usd: payNow, cap_usd: a?.cap_usd ?? payNow,
    status, channel: how,
    ...(a?.approved_at ? { approved_at: a.approved_at } : {}),
    ...(a ? { approval_id: a.approval_id, expires_at: a.expires_at } : {}),
    ...(b.payment ? { payment: b.payment } : {}),
    ...(b.payment?.receipt_url ? { receipt_url: b.payment.receipt_url } : b.payment?.explorer_url ? { receipt_url: b.payment.explorer_url } : {}),
    mode, ...extra,
  });
}
