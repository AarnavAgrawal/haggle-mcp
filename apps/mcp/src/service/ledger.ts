// Service route for the web dashboard's ledger (service token): every deal in a workspace in one read,
// because a board per deal is too slow live. Shapes apps/web/lib/dashboard/ledger.ts (Ledger, LedgerDeal...).
//   GET /internal/workspaces/ledger?limit=50  every deal with its quotes (all versions), open questions,
//                                             approval, payment and history; open deals first, then newest.
//                                             limit 1 to 100; `truncated` says more exist. Any member.
// Read-only: rows from HaggleEngine.workspaceLedger, never a board, an advance, a model or a message.
// Every field is picked by name, so a new column stays in: no code, no contact, no provider id leaves.
// History is an allow-list too. Business messages, questions and transcripts are data (CLAUDE.md
// section 7), so ledgerEvent writes its lines from fixed words, business names and amounts. A `reply`
// summary is engine-written but some quote a business, the human or a provider error: only its fixed
// opening clause is kept, because that text always follows a ":", "(", ";" or quotation mark.
import { centsToUsd, isApproximate, priceDoubt, toContractQuote, UNREADABLE_REPLY, type HaggleEngine, type JobEventRow, type QuoteRow } from "@haggle/engine";
import { engineError, fail, serviceGuard, type ServiceApp, type ServiceContext } from "./http.ts";

type EventGroup = "status" | "contact" | "quote" | "negotiation" | "approval" | "payment" | "problem";
export interface LedgerEvent { seq: number; at: string; group: EventGroup; business_id?: string; business?: string; text: string }
type Line = { group: EventGroup; text: string };
type LedgerRows = Awaited<ReturnType<HaggleEngine["workspaceLedger"]>>;
type DealRows = LedgerRows["deals"][number];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_EVENTS = 100;
const MAX_ITEMS = 8;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const usd = (cents: number | null | undefined) => (cents === null || cents === undefined ? null : centsToUsd(cents));
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? money(v) : null);

const STATE_WORDS = new Map<string, string>([
  ["collecting", "Collecting quotes"], ["negotiating", "Negotiating with the businesses"], ["awaiting_approval", "Waiting for your approval"], ["paying", "Approved; finishing the purchase"],
  ["paid", "Deal paid"], ["confirmed", "Deal confirmed"], ["cancelled", "Deal stopped"], ["failed", "Deal failed"],
]);
const BOOKING_WORDS = new Map<string, string>([
  ["awaiting_vendor_confirmation", "Waiting for the business to confirm the booking"], ["confirmed", "Booking confirmed"], ["not_in_writing", "The booking can't be confirmed in writing"],
  ["vendor_claims_confirmed", "The business says the booking is confirmed, but the sender isn't verified"], ["human_attested", "You confirmed the booking directly"],
  ["declined", "The business can't take the booking"], ["changed", "The business replied with different terms"], ["cancelled", "Booking cancelled"],
]);
/** Replies whose whole summary quotes someone, or that another event already says: a fixed line, or none. */
const REPLY_KINDS = new Map<string, Line | null>([
  ["courtesy_question", null], ["questions_surfaced", null], ["user_text", null], ["late_reply", null],
  ["ready_texted", { group: "approval", text: "Texted you Haggle's recommendation" }],
  ["ready_none_compliant", { group: "status", text: "Quotes are final, but none meets every requirement" }],
  ["ready_not_texted", { group: "status", text: "Quotes are final, but none can be approved yet" }],
  ["better_quote", { group: "quote", text: "A better quote came in after one went to you for approval" }],
  ["approver_opted_out", { group: "problem", text: "The approver stopped texts from Haggle" }],
]);
/** Business names are masked first, so `(.+)` here is only ever a name or Haggle's own words. */
const REWORD: [RegExp, string][] = [
  [/^RFQ sent to (.+)$/, "Asked $1 for a quote"],
  [/^RFQ texted to (.+)$/, "Texted $1 for a quote"],
  [/^RFQ to (.+) sent outside contact hours$/, "Asked $1 for a quote outside contact hours"],
  [/^RFQ\b/, "Quote request"],
  [/^A2A task to /, "Message to "],
  [/^A2A reply from /, "Reply from "],
  [/ by a2a$/, " by agent message"],
  [/^Asked (.+) for$/, "Asked $1 for missing details"],
  [/^(Call to .+ scheduled) for \d{4}-\d\d-\d\dT\S+$/, "$1"],
  [/^The human /, "You "],
];
const FAILURE = /\b(failed|couldn't|can't|not sent|not placed|bounced|delayed|not delivered|not verified|wasn't contacted|not contacted|unknown|ignored|held|paused|problem|asked not to be contacted)\b/i;
/** A contact, a link, an id or a raw code left in a clause: the line is dropped, not repaired. */
const LEAK = /[\w.+-]+@[\w-]+\.\w|https?:|www\.|\+?\d[\d\s().-]{7,}\d|\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b|\bRFQ\b|\bA2A\b/;

/** Swaps each known name for a token, longest first, so its own punctuation can't end a clause. */
function masker(names: Map<string, string>) {
  const known = [...new Set(names.values())].filter(Boolean).sort((a, b) => b.length - a.length);
  return {
    mask: (s: string) => known.reduce((t, name, i) => t.split(name).join(`\u0000${i}\u0000`), s),
    unmask: (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => known[Number(i)]!),
  };
}

function replyLine(d: Record<string, unknown>, who: string, names: Map<string, string>): Line | null {
  const kind = typeof d.kind === "string" ? d.kind : "";
  const fixed = REPLY_KINDS.get(kind);
  if (fixed !== undefined) return fixed;
  const summary = typeof d.summary === "string" ? d.summary : "";
  if (!summary) return null;
  if (summary === UNREADABLE_REPLY) return { group: "problem", text: "Reply received, but Haggle couldn't read a price" };
  if (kind === "question_auto_answered") return { group: "contact", text: summary.startsWith("Told ") ? `Told ${who} it is writing with your AI assistant` : `Answered ${who}'s question from your request` };
  const { mask, unmask } = masker(names);
  const masked = mask(summary);
  // The counteroffer event says these; the operator's close is a state change, with its reason kept internal.
  if (/^Counteroffer to [^:]*:/.test(masked) || /^Counteroffer to .* by call/.test(masked) || masked.startsWith("Closed by the operator")) return null;
  const unverified = masked.match(/^(Email from .+?) \(sender NOT verified\)/)?.[1] ?? null;
  const caller = masked.match(/^(.+ called Haggle) \(caller ID not verified\)/)?.[1] ?? null;
  const failedEmail = masked.match(/^(An email to .+?) \(\w+\) failed to send/)?.[1] ?? null;
  const unknown = /: outcome unknown/.test(masked);
  let head = masked.split(/: |; | \(|"/, 1)[0]!.trim().replace(/\.$/, "");
  for (const [from, to] of REWORD) head = head.replace(from, to);
  const text = unverified ? `${unverified} (sender not verified)` : caller ? `${caller} (caller ID not verified)` : failedEmail ? `${failedEmail} failed to send` : unknown ? `${head}: outcome unknown` : head;
  if (!text || LEAK.test(text)) return null;
  const group: EventGroup = FAILURE.test(text) ? "problem" : /counter/i.test(text) || kind === "counter_basis" ? "negotiation" : "contact";
  return { group, text: clip(unmask(text), 200) };
}

function paymentLine(d: Record<string, unknown>, who: string, Who: string): Line | null {
  const paid = amount(d.amount_usd);
  switch (d.status) {
    case "charging": return { group: "payment", text: "Payment started" };
    case "settled": return { group: "payment", text: d.simulated === true ? "Payment went through (simulated)" : "Payment went through" };
    case "failed": return { group: "problem", text: "Payment failed" };
    case "human_reported_paid": return { group: "payment", text: paid ? `You reported paying ${paid}` : "You reported paying" };
    case "settled_verified": return { group: "payment", text: `${Who} confirmed the payment arrived` };
    case "handoff_requested": return { group: "payment", text: `Asked ${who} how to pay` };
    case "instructions_received": return { group: "payment", text: `${Who} sent payment instructions` };
    case "instructions_changed": return { group: "problem", text: `${Who} changed its payment instructions` };
    default: return null;
  }
}

function lineFor(type: string, d: Record<string, unknown>, who: string, Who: string, names: Map<string, string>): Line | null {
  switch (type) {
    case "state": { const text = STATE_WORDS.get(String(d.to)); return text ? { group: "status", text } : null; }
    case "ready": return { group: "status", text: "Quotes are final" };
    case "reply": return replyLine(d, who, names);
    case "quote": { const total = amount(d.total_usd); return { group: "quote", text: total ? `${Who} quoted ${total}` : `${Who} replied without a stated total` }; }
    case "question": return { group: "contact", text: `${Who} asked you a question` };
    case "counteroffer": { const target = amount(d.target_total_usd); return { group: "negotiation", text: target ? `Asked ${who} to come down to ${target}` : `Sent ${who} a counteroffer` }; }
    case "counteroffers_sent": { const n = Number(d.sent); return n > 0 ? { group: "negotiation", text: n === 1 ? "Sent 1 counteroffer" : `Sent ${n} counteroffers` } : null; }
    case "approval_requested": return { group: "approval", text: "Asked you to approve a quote" };
    case "approval_verified": return { group: "approval", text: "You approved a quote" };
    case "approval_declined": return { group: "approval", text: "You declined a quote" };
    case "approval_void": return { group: "approval", text: "Approval withdrawn" };
    case "approval_expired": return { group: "approval", text: "Approval expired" };
    case "approval_superseded": return { group: "approval", text: "Approval replaced by a newer one" };
    case "payment": return paymentLine(d, who, Who);
    case "payment_refused": return { group: "problem", text: "Payment refused by a safety check" };
    case "booking": { const text = BOOKING_WORDS.get(String(d.status)); return text ? { group: "status", text } : null; }
    case "limit_set": { const to = typeof d.to_cents === "number" ? money(centsToUsd(d.to_cents)) : null; return to ? { group: "status", text: `Deal limit set to ${to}` } : null; }
    case "call_scheduled": return { group: "contact", text: `Call to ${who} scheduled` };
    case "call_failed": return { group: "problem", text: `Call to ${who} couldn't be placed` };
    case "call_dropped": return { group: "problem", text: `Call to ${who} not placed` };
    case "late_reply": return { group: "contact", text: `${Who} replied after the deal closed` };
    default: return null;
  }
}

/** One history line in the buyer's words, or null: only the types above, and only the fields they name. */
export function ledgerEvent(row: Pick<JobEventRow, "seq" | "at" | "type" | "data">, names: Map<string, string>): LedgerEvent | null {
  const id = typeof row.data.business_id === "string" ? row.data.business_id : "";
  const name = names.get(id);
  const line = lineFor(row.type, row.data, name ?? "the business", name ?? "The business", names);
  if (!line) return null;
  return { seq: row.seq, at: row.at, group: line.group, ...(name ? { business_id: id, business: name } : {}), text: line.text };
}

/** Newest first; one engine step often writes two rows that read the same, so a repeat is said once. */
function ledgerEvents(rows: JobEventRow[], names: Map<string, string>): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const row of [...rows].reverse()) {
    if (out.length === MAX_EVENTS) break;
    const e = ledgerEvent(row, names);
    const last = out.at(-1);
    if (e && !(last && last.text === e.text && last.business_id === e.business_id && last.seq - e.seq === 1)) out.push(e);
  }
  return out;
}

/** The board's "negotiated from": this business's latest other firm total, never a later version of this one. */
function negotiatedFrom(q: QuoteRow, all: QuoteRow[]): number | undefined {
  const prev = all
    .filter((x) => x.business_id === q.business_id && x.id !== q.id && x.total_cents !== null && (x.round < q.round || (x.round === q.round && x.created_at <= q.created_at)))
    .sort((x, y) => y.round - x.round || y.created_at.localeCompare(x.created_at))[0];
  return prev && !isApproximate(prev.record) && prev.total_cents !== q.total_cents ? prev.total_cents! : undefined;
}

function ledgerQuote(q: QuoteRow, r: DealRows) {
  const b = r.businesses.find((x) => x.business_id === q.business_id);
  const from = negotiatedFrom(q, r.quotes);
  // Only the check that needs no brain: the brain's own verdict is a read per quote (the board's cost).
  const view = toContractQuote(q, { name: b?.name ?? "Unknown business" } as Parameters<typeof toContractQuote>[1], { budgetCents: r.job.budget_cents, ...(from !== undefined ? { negotiatedFromCents: from } : {}), ...(priceDoubt(q.record) ? { price_check: "too_low" as const } : {}) });
  return {
    quote_id: view.quote_id, business_id: view.business_id, business: view.business, channel: b?.channel ?? "unknown", round: view.round, status: q.status, total_usd: usd(q.total_cents),
    ...(view.per_unit_usd !== undefined ? { per_unit_usd: view.per_unit_usd } : {}), ...(view.deposit_usd !== undefined ? { deposit_usd: view.deposit_usd } : {}),
    ...(view.negotiated_from !== undefined ? { negotiated_from: view.negotiated_from } : {}), ...(view.price_check ? { price_check: view.price_check } : {}),
    meets_requirements: view.meets_requirements, flags: view.flags, items: q.record.menu_items.slice(0, MAX_ITEMS).map((i) => clip(i, 120)), ...(view.valid_until ? { valid_until: view.valid_until } : {}),
    confidence: view.confidence, source: view.source, received_at: q.created_at,
  };
}

function ledgerDeal(r: DealRows) {
  const { job, approval: a, payment: p, purchase: s } = r;
  const req = job.request;
  const names = new Map(r.businesses.map((b) => [b.business_id, b.name]));
  return {
    job_id: job.id, what: req.what, ...(req.quantity !== undefined ? { quantity: req.quantity } : {}), ...(req.unit ? { unit: req.unit } : {}), ...(req.date ? { date: req.date } : {}), ...(req.area ? { area: req.area } : {}),
    state: job.state, ready: job.ready, created_at: job.created_at, updated_at: job.updated_at, budget_usd: usd(job.budget_cents), limit_usd: usd(job.payment_cap_cents), recommended_quote_id: r.recommended_quote_id,
    businesses: r.businesses.map((b) => ({ id: b.business_id, name: b.name, channel: b.channel, status: b.board_status })),
    quotes: r.quotes.map((q) => ledgerQuote(q, r)),
    questions: r.questions.filter((q) => q.status === "pending").map((q) => ({ question_id: q.id, business_id: q.business_id, business: names.get(q.business_id) ?? "Unknown business", text: clip(q.text, 300), asked_at: q.created_at })),
    approval: a ? { quote_id: a.quote_id, business_id: a.business_id, status: a.status, amount_usd: centsToUsd(a.payment_cents), total_usd: centsToUsd(a.quote_total_cents), channel: a.channel, decided_at: a.decided_at } : null,
    payment: p ? { status: p.status, amount_usd: centsToUsd(p.amount_cents), simulated: p.simulated, at: p.updated_at } : null,
    ...(s ? { purchase: { stage: s.stage } } : {}),
    events: ledgerEvents(r.events, names),
  };
}

/** A whole number from 1 to MAX_LIMIT, or null; absent means the default. */
function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = /^\d+$/.test(raw) ? Number(raw) : 0;
  return n >= 1 && n <= MAX_LIMIT ? n : null;
}

export interface LedgerRouteOptions {
  /** Tests swap the service guard for one over their own engine. */
  guard?: (c: ServiceContext, opts: { workspace?: boolean }) => Promise<{ rt: { engine: Pick<HaggleEngine, "workspaceLedger">; mode: "mock" | "live" }; workspaceId: string | null; actor: string | null } | Response>;
}

export function registerLedgerRoutes(app: ServiceApp, opts: LedgerRouteOptions = {}) {
  const guard = opts.guard ?? (serviceGuard as unknown as NonNullable<LedgerRouteOptions["guard"]>);
  app.get("/internal/workspaces/ledger", async (c) => {
    const g = await guard(c, { workspace: true });
    if (g instanceof Response) return g;
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return fail(c, 400, "INVALID_INPUT", `limit must be a whole number from 1 to ${MAX_LIMIT}.`, `Send ?limit=${DEFAULT_LIMIT}, or leave limit out for the default.`);
    try {
      const { deals, truncated } = await g.rt.engine.workspaceLedger(limit, g.workspaceId!);
      const next = truncated ? `Showing the ${deals.length} most recently active deals; more exist, so totals cover only these.` : deals.length ? "That's every deal in this workspace." : "No deals yet.";
      return c.json({ ok: true, mode: g.rt.mode, deals: deals.map(ledgerDeal), truncated, next });
    } catch (err) {
      return engineError(c, err, 503);
    }
  });
}
