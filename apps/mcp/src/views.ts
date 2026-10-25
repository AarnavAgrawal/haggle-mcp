// Engine read models -> the shared view schemas (@haggle/core/views). Every tool that renders a view
// returns exactly one of these shapes, parsed (validated and stripped of engine-only fields).
import { Approval, DealBoard, DealBoardOrEmpty, Quote, requirementText, type Channel, type Mode } from "@haggle/core";
import { eventPlace, eventWhen, type DealBoardData, type HaggleEngine } from "@haggle/engine";
import { z } from "zod";

export { BusinessProfile, Conversation, DealBoard, DealBoardOrEmpty, Estimates, Identity } from "@haggle/core";

/**
 * approve/pay output: the shared Approval plus mock mode's "simulated" approval channel (a headless
 * client with neither a form nor a view, DEMO only) and the raw payment status. Contract decision D8
 * is open: until it is settled, "simulated" appears only in mock mode.
 */
export const ApprovalOut = Approval.extend({
  /** + "email" (a coded APPROVE reply to the approval email) and mock mode's "simulated". */
  channel: z.enum([...Approval.shape.channel.options, "email", "simulated"]),
  demo: z.string().optional(),
  /** The quote's order total; amount_usd is what is paid now (the deposit). */
  order_total_usd: z.number().nonnegative().optional(),
  /** What amount_usd is: the stated deposit, or the full total because the business stated no deposit (never $0). Absent for confirm-only. */
  pay_now_basis: z.enum(["deposit", "full_total"]).optional(),
  payment: z.looseObject({ status: z.string(), simulated: z.boolean() }).optional(),
  /** "manual": approved deals end in the manual handoff (Haggle moves no money); known before any payment row exists. */
  payment_rail: z.literal("manual").optional(),
});
export type ApprovalOut = z.infer<typeof ApprovalOut>;

/** The board's hint after a choice texted to the approver (out-of-band approvals); never carries the code. */
export function pendingByTextNext(webApp: boolean): string {
  return `Sent to the approver's phone: they approve by replying YES <code> to Haggle's text${webApp ? ", or approve it in the Haggle web app" : ""}.`;
}

/**
 * A quote as Haggle's board shows it: the shared Quote, except a total the business never stated is
 * null with total_known: false (decision 22: unknown, never $0). Core's Quote requires a number, so
 * this extension lives here (core unchanged).
 */
export const BoardQuote = Quote.extend({ total_usd: z.number().nonnegative().nullable(), total_known: z.boolean().optional() });
export type BoardQuote = z.infer<typeof BoardQuote>;

/** The shared DealBoard with BoardQuote rows (what toDealBoard returns). */
export const LiveDealBoard = DealBoard.extend({ quotes: z.array(BoardQuote) });
export type LiveDealBoard = z.infer<typeof LiveDealBoard>;

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function requestSummary(r: DealBoardData["job"]["request"]): string {
  return [r.quantity !== undefined ? `${r.what} for ${r.quantity}${r.unit ? ` ${r.unit}` : ""}` : r.what, r.date ? eventWhen(r.date, r.time, r.date_until) : "", eventPlace(r.area, r.venue)].filter(Boolean).join(" · ");
}

/** Flags that mean the business's own words must not be echoed to the model or the view. */
const UNSAFE_TEXT = new Set(["prompt_injection", "external_payment_link"]);

export function toDealBoard(b: DealBoardData, mode: Mode): LiveDealBoard {
  // D2: a reply with no total is an open question, not a quote. Custom asks: a reply that answered
  // the asked fields is a quote even without a total (total_usd: null, total_known: false; never $0).
  const priced = b.quotes.filter((q) => q.total_usd !== null || (q.fields && Object.values(q.fields).some((v) => v !== null)));
  const r = b.job.request;
  const unsafe = new Set(b.quotes.filter((q) => q.flags.some((f) => UNSAFE_TEXT.has(f))).map((q) => q.business_id));
  return LiveDealBoard.parse({
    job: {
      id: b.job.id, request: requestSummary(r), state: b.job.state,
      ...(b.job.budget_usd !== null ? { budget_usd: b.job.budget_usd } : {}),
      requirements: r.requirements.map(requirementText),
      ...(r.ask?.length ? { ask: r.ask.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required })) } : {}),
      ...(r.compare_by ? { compare_by: r.compare_by } : {}),
    },
    businesses: b.businesses.map((x) => ({
      id: x.business_id, name: x.name, channel: x.channel, status: x.status, last_event: x.last_event ?? "Contacted",
      simulated: x.simulated,
      ...(x.transcript_snippet && !unsafe.has(x.business_id) ? { transcript_snippet: x.transcript_snippet } : {}),
      ...(x.unavailable_reason ? { unavailable_reason: x.unavailable_reason } : {}),
    })),
    quotes: priced.map((q) => ({ ...q, total_usd: q.total_usd, ...(q.total_usd === null ? { total_known: false } : {}), round: Math.max(1, q.round) })),
    ...(b.recommended_quote_id ? { recommended_quote_id: b.recommended_quote_id } : {}),
    open_questions: b.open_questions,
    next: b.next,
    mode,
    rejected: b.rejected,
    negotiation: b.negotiation,
    approval: b.approval ? { approval_id: b.approval.approval_id, quote_id: b.approval.quote_id, status: b.approval.status, channel: b.approval.channel, ...(b.approval.replaceable ? { replaceable: true } : {}) } : null,
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
  quotes: z.array(BoardQuote),
  ok: z.boolean().optional(),
  job_id: z.string().optional(),
  /** deal only: the buyer inbox replies go to, the job state when outreach started, and when first replies are expected. */
  inbox: z.string().optional(),
  state: z.string().optional(),
  eta: z.string().optional(),
  /** Exactly what the businesses were asked, so the human can check the parse. */
  request_details: z.object({
    what: z.string(), headcount: z.number().int().optional(), when: z.string(), place: z.string(), date: z.string().optional(), time: z.string().optional(),
    requirements: z.array(z.string()), budget_usd: z.number().nullable(), budget_source: z.enum(["request", "settings_default"]).optional(),
  }).optional(),
  /** Operator/settings ceiling for any single payment (the deposit), separate from the order budget. */
  payment_ceiling_usd: z.number().nonnegative().optional(),
  /** Can an approved quote be paid on this server (Stripe test mode, simulated, or the manual handoff)? Set from the engine's paymentsEnabled. */
  payments_enabled: z.boolean().optional(),
  /** The Haggle web app can record the human's approval and purchase steps on this server (service token set, HAGGLE_WEB_APPROVALS not off). */
  web_app: z.boolean().optional(),
  /** "manual": approval ends in the manual handoff (Haggle moves no money; no Pay button); known before any approval. */
  payment_rail: z.literal("manual").optional(),
  /** Per quote: can the human approve it now, and if not, why (the server decides; the view only shows it). */
  quote_status: z.record(z.string(), z.object({ approvable: z.boolean(), approximate: z.boolean().optional(), block: z.object({ code: z.string(), reason: z.string() }).optional() })).optional(),
  /** The best-value quote when it isn't the recommendation because it can't be approved; and why. */
  best_value_quote_id: z.string().optional(),
  recommendation_note: z.string().optional(),
  /** No quote meets every must: the closest approvable one. Never the recommendation; the human may choose it knowingly. */
  best_available_quote_id: z.string().optional(),
  /** Per current quote: does it meet every must (compliant / unconfirmed / noncompliant), and what it misses. Only compliant quotes are recommended. */
  compliance: z.record(z.string(), z.object({ status: z.enum(["compliant", "unconfirmed", "noncompliant"]), issues: z.array(z.object({ code: z.string(), text: z.string() })), /** Absent in the compact board when nothing was assumed. */ assumed: z.array(z.string()).optional() })).optional(),
  /** Per current quote: until when it can be approved as is; a stale one is re-confirmed with the business first. */
  freshness: z.record(z.string(), z.object({ stale: z.boolean(), good_until: z.string(), /** Absent in the compact board when it equals the quote's own valid_until. */ valid_until: z.string().nullable().optional(), reconfirmation: z.literal("requested").optional() })).optional(),
  /**
   * After approval under the manual handoff: booking, payment instructions (untrusted text, links never
   * opened), the customer's reported payment and the business's confirmation of receipt. money_verified
   * is true only when the business itself confirmed it received the money.
   */
  purchase: z.object({
    stage: z.string(), rail: z.literal("manual"), booked: z.boolean(), booked_by_human: z.literal(true).optional(), money_verified: z.boolean(),
    amount_usd: z.number(), total_usd: z.number(),
    vendor_reply: z.object({ text: z.string(), untrusted: z.literal(true), has_link: z.boolean() }).optional(),
    instructions: z.object({ text: z.string(), untrusted: z.literal(true), has_link: z.boolean() }).optional(),
    reported_paid_at: z.string().optional(), verified_at: z.string().optional(), stalled: z.literal(true).optional(), operator_attention: z.string().optional(),
    summary: z.string(), next: z.string(),
    /** The order and must-haves restated at every stage (S4-B), and a confirm-only (no payment) approval. */
    order: z.string().optional(), must_haves: z.string().optional(), confirm_only: z.literal(true).optional(),
  }).optional(),
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
    /** The compact board keeps contacted/replied jobs and reply time (what the view shows); quotes, response_rate (= replied/contacted) and confidence are in detail: true. */
    channels: z.record(z.string(), z.looseObject({ contacted_jobs: z.number(), replied_jobs: z.number(), quotes: z.number().optional(), response_rate: z.number().optional(), confidence: z.number().optional() })),
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
  /**
   * Integration slot (sprint 4, workstream A: vendor comms): per business_id, where Haggle's contact
   * with the vendor stands (e.g. delivered, bounced, opted_out, outside_contact_window, awaiting_reply)
   * in one line. Copied from the engine read model's `vendor_contact` when present.
   */
  vendor_contact: z.record(z.string(), z.looseObject({ status: z.string(), detail: z.string().optional() })).optional(),
  /**
   * Integration slot (sprint 4, workstream B: purchasing): per quote_id, why the quote was selected or
   * not, in one line. Copied from the engine read model's `selection` when present.
   */
  selection: z.record(z.string(), z.looseObject({ status: z.enum(["recommended", "selectable", "not_selectable"]), reason: z.string() })).optional(),
  /** True when this is the compact board (the default); get_quotes(detail: true) returns every ranking factor and contact statistic. */
  compact: z.boolean().optional(),
});
export type DealBoardPlus = z.infer<typeof DealBoardPlus>;

/** get_quotes budget: a six-quote board's structuredContent stays under this many characters (about 2,500 tokens at ~4 chars/token; the full board is ~14,500). */
export const BOARD_CHAR_BUDGET = 10_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The compact board every tool returns by default (the agent reads it on each poll). It keeps every
 * field the deal-board view renders and every decision-critical fact (totals, deposits, flags,
 * approvability and its reason, non-compliance and assumptions, confidence, fees and exclusions),
 * and drops what is redundant or never shown:
 * - value.ranked: only the recommended quote (the only one whose factors the board shows); every
 *   other quote's score and why-not stay in value.explanation.others;
 * - contact_learning: only businesses with history from more than one job or a stated preference;
 * - compliance: only quotes that aren't plainly compliant (absent = compliant, nothing assumed);
 * - stages: current_total_usd only when negotiation changed it, no quote_version;
 * - quotes: no message_id (get_conversation reads the thread), status only when not current,
 *   excluded_reason only when `rejected` doesn't already say it;
 * - businesses: the vendor's words and last event clipped to one line (`simulated` always kept: a
 *   real business can appear in a mock-mode deal);
 * - (sprint 5, measured on scripts/pilot-benchmark.ts) selection: a not_selectable reason that only
 *   restates quote_status[id].block or rejected[].detail; contact_learning: quotes, response_rate
 *   (= replied/contacted) and confidence, which the view never shows; compliance: an empty `assumed`.
 */
export function compactBoard(b: DealBoardPlus): DealBoardPlus {
  const rec = b.value?.recommendedQuoteId ?? b.recommended_quote_id ?? null;
  const rejected = new Set((b.rejected ?? []).map((r) => r.quote_id));
  const out: DealBoardPlus = {
    ...b,
    compact: true,
    businesses: b.businesses.map((x) => ({ ...x, last_event: clip(x.last_event, 120), ...(x.transcript_snippet ? { transcript_snippet: clip(x.transcript_snippet, 120) } : {}) })),
    quotes: b.quotes.map((q) => {
      const { message_id: _m, status, excluded_reason, ...rest } = q;
      return { ...rest, ...(status && status !== "current" ? { status } : {}), ...(excluded_reason && !rejected.has(q.quote_id) ? { excluded_reason } : {}) };
    }),
  };
  if (b.value) {
    out.value = {
      method: b.value.method, weights: b.value.weights, recommendedQuoteId: b.value.recommendedQuoteId,
      ranked: b.value.ranked.filter((r) => r.quoteId === rec).map((r) => ({ quoteId: r.quoteId, business: r.business, score: r.score, confidence: r.confidence, factors: r.factors.filter((f) => f.weight > 0).map((f) => ({ name: f.name, score: f.score, weight: f.weight, neutral: f.neutral, note: f.note })) })),
      // "Harbor Table: $1,008 (…), value 0.73 vs 0.77; <reason>" → "Harbor Table (value 0.73): <reason>":
      // the board shows only the reason, and the total is on the quote row.
      explanation: b.value.explanation && {
        winner: b.value.explanation.winner,
        others: b.value.explanation.others.map((o) => {
          const m = o.text.match(/^([^:]+):\s*\$[\d,.]+(?:\s*\([^)]*\))?,\s*value ([\d.]+) vs [\d.]+;\s*(.*)$/s);
          return m ? { quote_id: o.quote_id, text: `${m[1]} (value ${m[2]}): ${m[3]}` } : o;
        }),
      },
    };
  }
  if (b.contact_learning) {
    const kept = Object.entries(b.contact_learning).flatMap(([id, l]) => {
      const channels = Object.fromEntries(Object.entries(l.channels).filter(([, c]) => c.contacted_jobs > 1));
      return Object.keys(channels).length || l.stated_preference ? [[id, { channels, ...(l.stated_preference ? { stated_preference: l.stated_preference } : {}) }] as const] : [];
    });
    if (kept.length) out.contact_learning = Object.fromEntries(kept.map(([id, l]) => [id, { ...l, channels: Object.fromEntries(Object.entries(l.channels).map(([c, r]) => {
      const { quotes: _q, response_rate: _r, confidence: _c, ...shown } = r;
      return [c, shown];
    })) }]));
    else delete out.contact_learning;
  }
  if (b.compliance) out.compliance = Object.fromEntries(Object.entries(b.compliance).filter(([, c]) => c.status !== "compliant" || c.issues.length || c.assumed?.length).map(([id, c]) => {
    const { assumed, ...rest } = c;
    return [id, assumed?.length ? c : rest];
  }));
  if (b.stages) {
    out.stages = Object.fromEntries(Object.entries(b.stages).map(([id, s]) => {
      const { quote_version: _v, current_total_usd, ...rest } = s;
      return [id, { ...rest, ...(current_total_usd !== undefined && current_total_usd !== s.first_total_usd ? { current_total_usd } : {}) }];
    }));
  }
  // Stale quotes: valid_until is already on the quote row.
  if (b.freshness) out.freshness = Object.fromEntries(Object.entries(b.freshness).map(([id, f]) => [id, { stale: f.stale, good_until: f.good_until, ...(f.valid_until !== null && f.valid_until === b.quotes.find((q) => q.quote_id === id)?.valid_until ? {} : { valid_until: f.valid_until }), ...(f.reconfirmation ? { reconfirmation: f.reconfirmation } : {}) }]));
  // Selection reasons: a selectable (not recommended) quote's reason is already in value.explanation.others.
  // A not_selectable reason that restates the approval block or the rejection word for word is already on the board.
  const restates = (id: string, reason: string) => {
    const said = reason.replace(/…$/, "");
    const block = b.quote_status?.[id]?.block?.reason;
    const rej = b.rejected?.find((r) => r.quote_id === id)?.detail;
    return (!!block && `can't be approved yet: ${block}`.startsWith(said)) || (!!rej && `can't win: ${rej}`.startsWith(said));
  };
  if (b.selection) out.selection = Object.fromEntries(Object.entries(b.selection).filter(([id, s]) => s.status !== "selectable" && !(s.status === "not_selectable" && restates(id, s.reason))).map(([id, s]) => [id, { ...s, reason: clip(s.reason, 80) }]));
  for (const k of ["freshness", "terms", "selection"] as const) if (out[k] && !Object.keys(out[k]!).length) delete out[k];
  return out;
}

export function requestDetails(b: { job: Pick<DealBoardData["job"], "request" | "budget_usd"> }, budgetSource?: "request" | "settings_default"): NonNullable<DealBoardPlus["request_details"]> {
  const r = b.job.request;
  return {
    what: r.what, ...(r.quantity !== undefined ? { headcount: r.quantity } : {}), when: r.date ? eventWhen(r.date, r.time, r.date_until) : "no date given", place: eventPlace(r.area, r.venue),
    ...(r.date ? { date: r.date } : {}), ...(r.time ? { time: r.time } : {}),
    requirements: r.requirements.map(requirementText), budget_usd: b.job.budget_usd, ...(budgetSource ? { budget_source: budgetSource } : {}),
  };
}

/** Board + request details + payment ceiling (+ setup blockers when given). Compact unless `detail` (see compactBoard). */
export function toDealBoardPlus(b: DealBoardData, mode: Mode, extra: Partial<DealBoardPlus> = {}, opts: { detail?: boolean } = {}): DealBoardPlus {
  const full = fullDealBoardPlus(b, mode, extra);
  return opts.detail ? full : compactBoard(full);
}

/** Workstream A/B integration slots, read from the engine read model when it carries them. */
function integrationSlots(b: DealBoardData): Partial<DealBoardPlus> {
  const x = b as DealBoardData & { vendor_contact?: DealBoardPlus["vendor_contact"] };
  // Per current quote: why it was recommended, is selectable, or can't be selected (ranking/selection.ts).
  const selection = Object.fromEntries(b.quotes.flatMap((q) => {
    const sel = (q as { selection?: { status: "recommended" | "selectable" | "not_selectable"; reason: string } }).selection;
    return q.status === "current" && sel ? [[q.quote_id, sel]] : [];
  }));
  return { ...(x.vendor_contact && Object.keys(x.vendor_contact).length ? { vendor_contact: x.vendor_contact } : {}), ...(Object.keys(selection).length ? { selection } : {}) };
}

function fullDealBoardPlus(b: DealBoardData, mode: Mode, extra: Partial<DealBoardPlus>): DealBoardPlus {
  return DealBoardPlus.parse({
    ...integrationSlots(b),
    ...toDealBoard(b, mode), empty: false, job_id: b.job.id, request_details: requestDetails(b), ...(b.payment_ceiling_usd !== undefined ? { payment_ceiling_usd: b.payment_ceiling_usd } : {}), ...(b.payments_enabled !== undefined ? { payments_enabled: b.payments_enabled } : {}), ...(b.value ? { value: b.value } : {}), ...(b.callbacks ? { callbacks: b.callbacks } : {}), ...(b.stages ? { stages: b.stages } : {}), ...(b.terms && Object.keys(b.terms).length ? { terms: b.terms } : {}), ...(b.contact_learning ? { contact_learning: b.contact_learning } : {}),
    quote_status: Object.fromEntries(b.quotes.filter((q) => q.total_usd !== null).map((q) => [q.quote_id, { approvable: q.approvable, ...(q.total_approximate ? { approximate: true } : {}), ...(q.approval_block ? { block: q.approval_block } : {}) }])),
    ...(b.best_value_quote_id ? { best_value_quote_id: b.best_value_quote_id } : {}), ...(b.recommendation_note ? { recommendation_note: b.recommendation_note } : {}),
    ...(b.best_available_quote_id ? { best_available_quote_id: b.best_available_quote_id } : {}),
    compliance: Object.fromEntries(b.quotes.filter((q) => q.status === "current" && q.compliance).map((q) => [q.quote_id, { status: q.compliance!.status, issues: q.compliance!.issues.map((x) => ({ code: x.code, text: x.text })), assumed: q.compliance!.assumed }])),
    // Only quotes that need attention (stale, or being re-confirmed): keeps the output compact.
    freshness: Object.fromEntries(b.quotes.filter((q) => q.status === "current" && q.freshness && (q.freshness.stale || q.freshness.reconfirmation)).map((q) => [q.quote_id, { stale: q.freshness!.stale, good_until: q.freshness!.good_until, valid_until: q.freshness!.valid_until, ...(q.freshness!.reconfirmation ? { reconfirmation: q.freshness!.reconfirmation } : {}) }])),
    ...(b.purchase ? { purchase: b.purchase } : {}),
    ...(b.negotiation.some((n) => n.basis_approximate) ? { negotiation_estimates: [...new Set(b.negotiation.filter((n) => n.basis_approximate).map((n) => n.basis_quote_id))] } : {}), ...extra,
  });
}

type DealOut = {
  ok: boolean; next: string; job_id: string; inbox: string; state: string; eta: string;
  contacted: { business_id: string; business: string; channel: Channel }[];
  not_contacted: { business_id?: string; business: string; channel: Channel; reason: string }[];
};

/**
 * deal's output: the live deal board (rendered by deal-live the moment outreach starts) plus the deal
 * result fields (inbox, state, eta, contacted, not_contacted). `board` is the engine's read of the new
 * job; when that read failed (the outreach already went out, so deal must not fail), a minimal board
 * is built from the deal result: every contacted business as "contacted", no quotes yet.
 */
export function dealStartedBoard(r: DealOut, board: DealBoardData | null, request: DealBoardData["job"]["request"], mode: Mode, extra: Partial<DealBoardPlus> = {}): DealBoardPlus {
  const deal = { ok: r.ok, job_id: r.job_id, inbox: r.inbox, state: r.state, eta: r.eta, contacted: r.contacted, not_contacted: r.not_contacted };
  if (board) return toDealBoardPlus(board, mode, { ...deal, ...extra });
  return DealBoardPlus.parse({
    job: { id: r.job_id, request: requestSummary(request), state: r.state, requirements: request.requirements.map(requirementText) },
    empty: false,
    businesses: [
      ...r.contacted.map((c) => ({ id: c.business_id, name: c.business, channel: c.channel, status: "contacted", last_event: `Contacted by ${c.channel}` })),
      ...r.not_contacted.filter((c) => c.business_id).map((c) => ({ id: c.business_id!, name: c.business, channel: c.channel, status: "unavailable", last_event: "Not contacted", unavailable_reason: c.reason })),
    ],
    quotes: [], open_questions: [], next: r.next, mode, ...deal, ...extra,
  });
}

export function emptyBoard(mode: Mode): DealBoardOrEmpty {
  return DealBoardOrEmpty.parse({ job: null, empty: true, businesses: [], quotes: [], open_questions: [], mode, next: "No deals yet. Call deal with what to buy, or ask for an instant estimate." });
}

export function toApproval(
  b: DealBoardData, quote_id: string, status: ApprovalOut["status"], mode: Mode,
  extra: { next: string; reason?: string; demo?: string; payment_rail?: "manual" },
): ApprovalOut {
  const q = b.quotes.find((x) => x.quote_id === quote_id);
  const a = b.approval?.quote_id === quote_id ? b.approval : null;
  const total = q?.total_usd ?? a?.quote_total_usd ?? 0;
  // Approve, then pay (decisions 2, 3, 20): a "pay" approval pays the stated deposit, or the full total
  // when the business stated none (never "$0": an unstated deposit is not a free deposit); a confirm-only
  // approval pays nothing. The stored approval's amount wins over the quote.
  const deposit = q?.deposit_usd;
  const action: "confirm" | "pay" = a?.action === "confirm" ? "confirm" : "pay";
  const payNow = action === "confirm" ? 0 : a ? a.payment_usd : deposit && deposit > 0 ? deposit : total;
  const basis = deposit !== undefined && deposit > 0 && payNow === deposit ? "deposit" as const : "full_total" as const;
  const business = q?.business ?? "unknown";
  const channel: Channel = q?.channel ?? b.businesses.find((x) => x.business_id === q?.business_id)?.channel ?? "email";
  const how = a?.channel === "elicitation" || a?.channel === "view" || a?.channel === "imessage" || a?.channel === "email" || a?.channel === "simulated" ? a.channel : "view";
  const summary = action === "confirm" ? `${business}: ${money(total)} order total; confirm the order only (nothing is paid)`
    : `${business}: ${money(total)} order total; ${basis === "deposit" ? `pay ${money(payNow)} deposit now` : `pay ${money(payNow)} now (full total: no deposit stated)`}`;
  return ApprovalOut.parse({
    job_id: b.job.id, quote_id, business, quote_channel: channel,
    summary,
    items: q?.items ?? [], amount_usd: payNow, ...(q || a ? { order_total_usd: total } : {}), ...(deposit !== undefined ? { deposit_usd: deposit } : {}), ...(action === "pay" ? { pay_now_basis: basis } : {}), cap_usd: a?.cap_usd ?? payNow,
    status, channel: how, action,
    ...(a?.approved_at ? { approved_at: a.approved_at } : {}),
    ...(a ? { approval_id: a.approval_id, expires_at: a.expires_at } : {}),
    ...(b.payment ? { payment: b.payment } : {}),
    ...(b.payment?.receipt_url ? { receipt_url: b.payment.receipt_url } : b.payment?.explorer_url ? { receipt_url: b.payment.explorer_url } : {}),
    mode, ...extra,
  });
}

type WaitResult = Awaited<ReturnType<HaggleEngine["waitForUpdate"]>>;

/** wait_for_update returns at most this many updates (the newest); updates_omitted counts the rest. */
export const WAIT_UPDATES_MAX = 12;

/**
 * wait_for_update's output (structuredContent and text). The 12 newest updates; quotes named by
 * business. A poll that saw nothing after a cursor the agent already holds (no update, timed out)
 * carries a one-line hint instead of repeating the engine's: no event means nothing changed since
 * the response that handed out that cursor, whose hint still stands (measured on the pilot
 * benchmark: most polls of a deal are these). Cursor 0 or any update: the engine's hint as is.
 */
export function waitOutput(w: WaitResult, requestedCursor: number, o: { until: string; timeoutS: number; names?: Map<string, string> }): { structured: WaitResult & { updates_omitted?: number }; text: string } {
  const usd = (n: number | null | undefined) => (n === null || n === undefined ? "?" : money(n));
  const quiet = w.timed_out && w.updates.length === 0 && requestedCursor > 0 && w.cursor === String(requestedCursor);
  const next = quiet ? `Nothing new since cursor ${w.cursor}; the previous hint stands. Wait again with this cursor.` : w.next;
  const omitted = Math.max(0, w.updates.length - WAIT_UPDATES_MAX);
  const updates = w.updates.slice(-WAIT_UPDATES_MAX);
  const lines = updates.map((u) =>
    u.type === "quote" ? `quote ${u.quote_id} from ${o.names?.get(u.business_id) ?? "a business"}: ${usd(u.total_usd)} (round ${u.round})` : u.type === "question" ? `question ${u.question_id}: "${u.text.slice(0, 120)}"` : u.type === "state" ? `state ${u.from} -> ${u.to}` : u.type === "flag" ? `flag ${u.flag}` : u.type === "reply" ? u.summary : `payment ${u.status}`);
  const head = w.timed_out ? `No ${o.until === "any_change" ? "change" : `"${o.until}"`} in ${o.timeoutS}s (${w.state}).` : `${w.updates.length} update(s), state ${w.state}:`;
  return {
    structured: { ...w, updates, next, ...(omitted ? { updates_omitted: omitted } : {}) },
    text: [head, ...lines, `cursor=${w.cursor} · next: ${next}`].join("\n"),
  };
}
