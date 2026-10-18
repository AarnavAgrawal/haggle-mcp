// The Haggle deal engine: one object that owns the buyer workflow over the ports.
//
// Orchestration follows quote-broker@8a68559 src/jobs/advanceJob.ts + effects.ts + tools (Partner):
//   - advanceJob(jobId) is called by every tool, by inbound ingestion and by each wait poll; it is
//     safe to call concurrently and repeatedly;
//   - parsing is idempotent (one quote per inbound message);
//   - transitions are compare-and-swap on jobs.version; only the winner runs the effects, after
//     the commit, so a lost race never sends email;
//   - every outbound email has a deterministic idempotency key and is recorded once.
// v3 additions: per-job inbox and pinned recipients, quote.json fast path, questions and
// answer_seller, totals-based honest negotiation, brain.learnFromReply after every parse,
// approval (elicitation / verified email / simulated in mock mode) and the x402 payer.
// v5 additions: channel routing (A2A card > email > phone; a channel without an enabled port is
// "unavailable", never faked), Voice AI call results via ingestCall, one shared Inkbox mailbox,
// the deal-board read model, approval from the approval view, settings, and the launcher.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ApprovalRecord, AskField, Business, DealResult, JobState, JobUpdate, PaymentStatus, Profile, Quote, QuotesResult, Request, WaitResult,
} from "../contract.ts";
import { businessIdForContact, newApprovalCode, newId, newShortCode, slugify } from "../ids.ts";
import { cleanEmailBody } from "../inbound/emailBody.ts";
import { matchInbound, jobInboxAddress, jobInboxCode, normalizeAddress, subjectShortCode } from "../inbound/matching.ts";
import type { InboundMessage, TrustVerdict } from "../inbound/primitive.ts";
import { centsToUsd, usdToCents, centsToUsdcBaseUnits } from "../money.ts";
import { planCounteroffers } from "../negotiation/counteroffer.ts";
import { checkMessage, findDollarAmounts } from "../negotiation/messageGuard.ts";
import { buildRfqEmail, quantityText } from "../outbound/rfq.ts";
import { messageSnippet, transcriptSnippet } from "./transcriptSnippet.ts";
import { sendKeys, type OutboundAttachment } from "../outbound/primitiveSender.ts";
import type { FieldValue, QuoteRecord } from "../parsing/extraction.ts";
import { businessText, dropAgentOnlyAmounts } from "../parsing/heuristic.ts";
import { evaluateRequirements, meetsHardRequirements, type EngineRequirement } from "../parsing/requirements.ts";
import { validateQuote } from "../parsing/validate.ts";
import { firstReplyLine, verifyApproval } from "../approvals/verifyApproval.ts";
import { isUnansweredLimitError, ROUTINE_TEXT_LIMIT, TextBudget } from "./textBudget.ts";
import { parseChallengePart, preparePayment } from "../payments/x402Challenge.ts";
import { checkStripePaymentAllowed, STRIPE_NETWORK, type StripeGuardCode } from "../payments/stripe.ts";
import { rankQuotes, rejectReason, type RankableQuote } from "../ranking/rank.ts";
import { DEFAULT_WORKSPACE_ID, type ApprovalRow, type Channel, type JobBusinessRow, type JobRow, type MessageRow, type PaymentRow, type QuestionRow, type QuoteRow, type Repository, type SettingsRow } from "../store/types.ts";
import { quotePartToExtraction } from "./quotePart.ts";
import { toContractQuote, toEngineRequirement, toParsedReply } from "./mapping.ts";
import { MAX_ROUND, start, TERMINAL, transition, type ApprovalAction, type Effect, type JobEvent, type MachineState } from "./stateMachine.ts";
import { ChannelSendError, type EngineDeps } from "./ports.ts";
import { answeredSomething, buildVoiceInstructions, isWithinCallHours, nextCallHoursStart } from "./callPolicy.ts";

/** Board excerpt of what a business said (see transcriptSnippet.ts), only when there is one. */
const snippet = (s: string) => (s ? { transcript_snippet: s } : {});

/** A Voice AI call we placed (any purpose): an outbound phone-channel row that isn't a text. */
const isPlacedCall = (m: Pick<MessageRow, "direction" | "channel" | "provider_email_id">) =>
  m.direction === "out" && m.channel === "phone" && !!m.provider_email_id && !/^(sms|imsg):/.test(m.provider_email_id);

export class EngineError extends Error {
  override name = "EngineError";
  readonly code: string;
  readonly fix: string;
  readonly next: string;
  constructor(code: string, message: string, fix: string, next: string) {
    super(message);
    this.code = code;
    this.fix = fix;
    this.next = next;
  }
}

/** A business to contact. At least one of email / phone / a2a_card_url. */
export interface DealBusiness {
  name: string;
  email?: string;
  phone?: string; // E.164
  a2a_card_url?: string; // https
  /** Preferred channel when several are possible, e.g. "imessage" to text a business at `phone`. */
  channel?: Channel;
  source?: Business["source"];
  simulated?: boolean;
}

export interface DealInput {
  request: Request;
  businesses: DealBusiness[];
  budget_usd?: number;
  reply_by?: string; // ISO
  approver_email?: string;
  max_rounds?: number;
  client_request_id?: string;
  /** Owning workspace; DEFAULT_WORKSPACE_ID on single-tenant servers. */
  workspace_id?: string;
}

const ASK_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_SEND_ATTEMPTS = 3;
const DEFAULT_CALL_COOLDOWN_MS = 2 * 60_000;
const DEFAULT_MAX_APPROVAL_ATTEMPTS = 5;
/** A placed call with no call-ended result after this long no longer blocks new calls. */
const CALL_IN_PROGRESS_MS = 15 * 60_000;
/** Characters an agent-written message may have, per channel (the call brief has its own cap). */
const MESSAGE_LIMIT: Record<Channel, number> = { email: 5000, a2a: 5000, phone: 1500, imessage: 159 };
/** Two SMS segments: long enough for a quote update, short enough to read at a glance. */
const SMS_LIMIT = 320;
const usdText = (cents: number) => `$${centsToUsd(cents).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** Extra human channels an approval also goes out on (the first human decision wins). */
export type ApprovalOffer = { text?: boolean; email?: boolean };

/** A text to the human (update, question, approval request); kept while their number is paused. */
type HeldText = { key: string; text: string; questionId?: string; approvalId?: string };

/** A texted (SMS or iMessage) approval decision: "YES 4821", "no 4821", "approve". */
const TEXT_DECISION = /^(yes|y|approve|approved|no|n|decline|declined)\b[\s,.:!-]*(\d{4})?[\s.!]*$/i;

/** Detail labels that name who the order is for (the person or company the AI assistant acts for). */
const CUSTOMER_LABEL_RE = /^(customer|client|company|organi[sz]ation|requester|requested by|on behalf of|ordered by|customer name|company name)$/i;
const plainName = (s: string, n: number) => s.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/\+?\d[\d\s().-]{6,}\d/g, "").replace(/\s+/g, " ").trim().slice(0, n).trim();

/**
 * Who the AI assistant acts for, as businesses hear it: the customer named on the request (a detail
 * like "Customer: Acme Labs"), else the operator's configured name, else "a customer". Never "Haggle":
 * businesses deal with the customer's AI assistant, not with a brand.
 */
export function customerOf(request: { details?: { label: string; value: string }[] }, configured?: string | null): string {
  const named = request.details?.find((d) => CUSTOMER_LABEL_RE.test(d.label.trim()))?.value ?? configured ?? "";
  return plainName(named, 40) || "a customer";
}

/** Clip a text to `limit` chars, keeping a trailing reference code ("Ref HG-AB12") intact. */
export function fitText(text: string, limit: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= limit) return t;
  const ref = t.match(/\s((?:Ref )?HG-[A-Z0-9]+)$/);
  if (!ref) return t.slice(0, limit).trimEnd();
  return `${t.slice(0, t.length - ref[0].length).slice(0, limit - ref[1]!.length - 1).trimEnd()} ${ref[1]}`;
}

/** Validate a request's custom ask (keys, compare_by, payable_field). Throws an EngineError. */
export function validateAsk(r: Request): void {
  const ask = r.ask ?? [];
  const keys = new Set<string>();
  for (const f of ask) {
    if (!ASK_KEY_RE.test(f.key)) throw new EngineError("bad_ask", `Ask key "${f.key}" must be lowercase letters, digits and _ (start with a letter, ≤ 32).`, "Rename the key, e.g. earliest_date.", "deal");
    if (keys.has(f.key)) throw new EngineError("bad_ask", `Ask key "${f.key}" is listed twice.`, "Use each key once.", "deal");
    keys.add(f.key);
  }
  if (r.compare_by && !keys.has(r.compare_by.field)) throw new EngineError("bad_ask", `compare_by.field "${r.compare_by.field}" isn't one of the ask keys.`, "Point compare_by at an ask field.", "deal");
  if (r.payable_field) {
    const f = ask.find((x) => x.key === r.payable_field);
    if (!f) throw new EngineError("bad_ask", `payable_field "${r.payable_field}" isn't one of the ask keys.`, "Point payable_field at a money ask field.", "deal");
    if (f.type !== "money") throw new EngineError("bad_ask", `payable_field "${r.payable_field}" must be a money field.`, "Pick a money ask field (the amount paid on approval).", "deal");
  }
}

/** Proposed addition to the Brain contract; used only when the brain implements it. */
export interface ProfileReader {
  getProfile(businessId: string): Promise<Profile | null>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Contract DealResult plus the v5 channel per business and who could not be contacted (and why). */
export type EngineDealResult = Omit<DealResult, "contacted"> & {
  contacted: (DealResult["contacted"][number] & { channel: Channel })[];
  not_contacted: { business_id: string; business: string; channel: Channel; reason: string }[];
};

/** Engine-side business status → the deal board's v5 status. */
export type BoardStatus = "contacted" | "ringing" | "on_call" | "quoted" | "negotiating" | "won" | "declined" | "no_reply" | "unavailable";

export interface BoardBusiness {
  id: string;
  business_id: string;
  name: string;
  business: string;
  channel: Channel;
  status: BoardStatus;
  engine_status: JobBusinessRow["status"];
  simulated: boolean;
  last_event: string | null;
  transcript_snippet?: string;
  unavailable_reason?: string;
}

export type BoardQuote = Omit<Quote, "total_usd"> & {
  /** null when the business hasn't stated a total (unknown is never 0). */
  total_usd: number | null;
  channel: Channel;
  eligible: boolean;
  verdict: "compliant" | "rejected" | "incomplete";
  excluded_reason?: string;
  /** Custom ask answers by key (money in USD); only for requests with `ask`. */
  fields?: Record<string, number | string | boolean | null>;
  /** Labels of required ask answers still missing. */
  missing_fields?: string[];
};

export interface NegotiationStep {
  business_id: string;
  business: string;
  round: number;
  target_total_usd: number;
  basis_quote_id: string;
  outcome_total_usd: number | null; // the business's answer, when it came back
}

export type DealBoardData = Omit<QuotesResult, "quotes" | "rejected" | "pending_questions"> & {
  job: { id: string; request: Request; state: JobState; budget_usd: number | null; created_at: string; updated_at: string };
  quotes: BoardQuote[];
  rejected: { business_id: string; quote_id: string; reason: import("../contract.ts").QuoteFlag; detail: string }[];
  open_questions: { question_id: string; business_id: string; business: string; text: string }[];
  /** Same list as open_questions (v3 name, kept for the existing deal-board view). */
  pending_questions: { question_id: string; business_id: string; business: string; text: string }[];
  negotiation: NegotiationStep[];
  business_names: Record<string, string>;
  businesses: BoardBusiness[];
  approval: EngineApprovalRecord | null;
  payment: EnginePaymentStatus | null;
  ready: boolean;
  inbox: string;
  request: Request;
  budget_usd: number | null;
};

const REJECT_TEXT: Record<import("../ranking/rank.ts").RejectReason, string> = {
  not_current: "superseded by a newer quote", unavailable: "the business declined", unverified_sender: "sender could not be verified",
  external_payment_link: "asked for payment through an external link (blocked)", prompt_injection: "contained instructions aimed at the agent (ignored)",
  requirement_unmet: "does not meet every hard requirement", missing_info: "a required answer is still missing", no_total: "no exact total yet", over_budget: "over the budget",
};

export type WaitUntil = "any_change" | "ready" | "approval_decided" | "done";

/** One entry of get_conversation: a message or call, oldest first. */
export interface ConversationEntry {
  message_id: string;
  direction: "in" | "out";
  channel: Channel;
  kind: MessageRow["kind"];
  at: string;
  subject?: string;
  /** Clipped to 800 chars; email replies without the quoted thread; calls hold the brief (out) or transcript (in). */
  text: string;
  attachments: string[];
  sender_verified?: boolean;
  quarantined?: boolean;
}

/** "+1 ••• ••• 0142", "a•••@example.com": enough to recognise, not to reuse. */
export function maskHandle(h: string): string {
  if (h.includes("@")) {
    const [local, domain] = h.split("@");
    return `${local!.slice(0, 1)}•••@${domain}`;
  }
  return h.length > 4 ? `${h.slice(0, 2)} ••• ••• ${h.slice(-4)}` : "••••";
}

/**
 * Fill what a new reply didn't state from the business's current (trusted) quote: money figures
 * with their sources, delivery, dietary coverage, items and custom answers. A decline never
 * inherits anything, and a stated value always wins.
 */
export function mergeCarryOver(next: QuoteRecord, prev: QuoteRecord | null): QuoteRecord {
  if (!prev || !next.available || !prev.available) return next;
  const out: QuoteRecord = { ...next, sources: { ...next.sources }, dietary_coverage: { ...next.dietary_coverage }, missing_fields: [...next.missing_fields], flags: [...next.flags] };
  const money = [["total_cents", "total"], ["deposit_cents", "deposit"], ["price_per_head_cents", "price_per_head"], ["subtotal_cents", "subtotal"], ["delivery_fee_cents", "delivery_fee"], ["tax_cents", "tax"]] as const;
  for (const [k, field] of money) {
    if (out[k] !== null || prev[k] === null) continue;
    out[k] = prev[k];
    if (prev.sources[field]) out.sources[field] = prev.sources[field];
    out.missing_fields = out.missing_fields.filter((m) => m !== field);
    if (field === "deposit" && prev.flags.includes("hidden_deposit")) out.flags.push("hidden_deposit");
  }
  if (out.delivery_included === null) out.delivery_included = prev.delivery_included;
  if (out.tax_included === null) out.tax_included = prev.tax_included;
  if (out.headcount === null) out.headcount = prev.headcount;
  if (out.valid_until === null) out.valid_until = prev.valid_until;
  for (const [need, d] of Object.entries(prev.dietary_coverage)) if (!out.dietary_coverage[need]) out.dietary_coverage[need] = d;
  if (out.menu_items.length === 0) out.menu_items = prev.menu_items;
  if (out.delivery_included !== null || out.delivery_fee_cents !== null) {
    out.flags = out.flags.filter((f) => f !== "delivery_unclear");
    out.missing_fields = out.missing_fields.filter((m) => m !== "delivery");
  }
  if (out.total_cents !== null) out.missing_fields = out.missing_fields.filter((m) => m !== "total");
  if (prev.fields || out.fields) {
    const fields = { ...(prev.fields ?? {}), ...Object.fromEntries(Object.entries(out.fields ?? {}).filter(([, v]) => v !== null)) };
    out.fields = fields;
    out.fields_missing = Object.entries(fields).filter(([, v]) => v === null).map(([k]) => k);
  }
  out.flags = [...new Set(out.flags)];
  return out;
}

/** A request's custom ask, as the engine uses it (empty for the catering default). */
function askInfo(r: Request): { ask: AskField[]; compare: AskField | undefined; moneyCompare: boolean; required: string[]; payable: AskField | undefined } {
  const ask = r.ask ?? [];
  const compare = r.compare_by ? ask.find((f) => f.key === r.compare_by!.field) : undefined;
  return { ask, compare, moneyCompare: compare?.type === "money", required: ask.filter((f) => f.required).map((f) => f.key), payable: r.payable_field ? ask.find((f) => f.key === r.payable_field) : undefined };
}

/** True when the request ranks on a custom answer that isn't money (no total is needed). */
function nonMoneyCompare(r: Request): boolean {
  const { compare, moneyCompare } = askInfo(r);
  return compare !== undefined && !moneyCompare;
}

/** A comparable value for compare_by: numbers numerically, dates and times lexically (YYYY-MM-DD, HH:MM). */
function sortable(f: AskField, v: FieldValue): number | string | null {
  if (v === null) return null;
  if (f.type === "money" || f.type === "number") return typeof v === "number" ? v : null;
  if (f.type === "date" || f.type === "time") return typeof v === "string" ? v : null;
  return null;
}

/** "$450.00", "2026-10-20", "yes": one custom answer for messages and the board. */
export function fieldText(f: AskField, v: FieldValue): string {
  if (v === null) return "not stated";
  if (f.type === "money" && typeof v === "number") return `$${(v / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (f.type === "boolean") return v === true ? "yes" : "no";
  return String(v);
}

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const jsonPart = (filename: string, o: unknown): OutboundAttachment => ({ filename, contentType: "application/json", content: enc(o) });

export class HaggleEngine {
  private readonly d: EngineDeps;
  /** Inkbox refuses an 11th text to a number that hasn't replied: every SMS goes through this count. */
  private readonly textBudget: TextBudget | null;
  constructor(d: EngineDeps) {
    this.textBudget = d.sms ? new TextBudget(d.sms) : null;
    this.d = this.textBudget ? { ...d, sms: this.textBudget.wrap() } : d;
  }

  private get repo(): Repository {
    return this.d.repo;
  }
  private now() {
    return this.d.now ? this.d.now() : new Date();
  }
  private log(event: string, data: Record<string, unknown>) {
    this.d.log?.(event, data);
  }
  private requirements(job: JobRow): EngineRequirement[] {
    return job.request.requirements.map(toEngineRequirement);
  }

  // ───────────────────────────── deal ─────────────────────────────

  async deal(input: DealInput): Promise<EngineDealResult> {
    const mode = this.d.config.mode;
    const ws = input.workspace_id ?? DEFAULT_WORKSPACE_ID;
    if (input.client_request_id) {
      const existing = await this.repo.findJobByClientRequestId(input.client_request_id, ws);
      if (existing) return this.dealResult(existing);
    }
    if (input.businesses.length === 0) throw new EngineError("no_businesses", "No businesses to contact.", "Pass businesses[] (name + email or phone), or call discover first.", "discover");
    validateAsk(input.request);
    const approverPhone = (await this.getSettings(ws)).approver_phone;
    const seen = new Set<string>();
    const planned = input.businesses.map((b) => {
      const email = b.email ? normalizeAddress(b.email) : null;
      const phone = b.phone ? b.phone.replace(/[\s().-]/g, "") : null;
      const card = b.a2a_card_url?.trim() || null;
      if (!email && !phone && !card) throw new EngineError("no_contact", `${b.name} has no email, phone or Agent Card.`, "Add an email (or an E.164 phone) for every business.", "deal");
      if (email && !EMAIL_RE.test(email)) throw new EngineError("bad_email", `Not an email address: ${b.email}`, "Fix the business email.", "deal");
      if (phone && !E164_RE.test(phone)) throw new EngineError("bad_phone", `Not an E.164 phone number: ${b.phone}`, "Use the +<country><number> form, e.g. +14155550123.", "deal");
      if (card && !/^https:\/\//.test(card)) throw new EngineError("bad_a2a_card", `Agent Card URL must be https: ${card}`, "Fix the Agent Card URL or omit it.", "deal");
      if (email && this.isOwnAddress(email)) throw new EngineError("bad_email", "That's Haggle's own inbox.", "Use the business's address.", "deal");
      // The approver's contacts are reserved for approvals: a business can't be the human who approves.
      if ((email && input.approver_email && normalizeAddress(input.approver_email) === email) || (phone && approverPhone && phone === approverPhone)) {
        throw new EngineError("reserved_for_approvals", `${b.name} uses the approver's own ${phone === approverPhone ? "phone number" : "email"}.`, "Give the business its own contact; the approver's is reserved for approvals.", "deal");
      }
      const blocked = [email, phone, card].find((c) => c !== null && !this.allowedRecipient(c));
      if (blocked) throw new EngineError("recipient_not_allowed", `${b.name} (${blocked}) isn't on this server's list of businesses it may contact.`, "Use the simulated demo businesses from discover, or ask the operator to add it to HAGGLE_ALLOWED_RECIPIENTS.", "discover");
      for (const key of [email, phone].filter((k): k is string => k !== null)) {
        if (seen.has(key)) throw new EngineError("duplicate_business", `Listed twice: ${key}`, "Remove the duplicate.", "deal");
        seen.add(key);
      }
      return { b, email, phone, card, ...this.route({ email, phone, card, prefer: b.channel }) };
    });
    if (!planned.some((p) => p.reachable)) {
      throw new EngineError("no_usable_channel", "None of these businesses can be reached: phone and A2A outreach aren't enabled in this deployment.", "Give at least one business an email address.", "deal");
    }
    const budgetCents = input.budget_usd === undefined ? null : usdToCents(input.budget_usd);
    if (budgetCents !== null && budgetCents <= 0) throw new EngineError("bad_budget", "budget_usd must be positive.", "Pass a positive budget_usd or omit it.", "deal");
    const replyBy = input.reply_by ? new Date(input.reply_by) : new Date(this.now().getTime() + this.d.config.collectionWindowMs);
    if (Number.isNaN(replyBy.getTime()) || replyBy <= this.now()) throw new EngineError("bad_deadline", "reply_by must be a future ISO time.", "Pass a future reply_by or omit it.", "deal");

    // The per-job payment cap is the operator's per-payment ceiling. The settings spending cap and
    // the budget are the human's preferences: shown as caveats on the approval, never a refusal.
    const paymentCapCents = this.d.config.globalPaymentCapCents;
    let job: JobRow | null = null;
    for (let i = 0; i < 5 && !job; i++) {
      const code = newShortCode();
      const at = this.now().toISOString();
      try {
        job = await this.repo.insertJob({
          id: newId("job"), workspace_id: ws, short_code: code, state: "created", mode, request: input.request, budget_cents: budgetCents,
          payment_cap_cents: paymentCapCents, approver_email: input.approver_email ? normalizeAddress(input.approver_email) : null,
          inbox: this.d.config.sharedInbox ?? jobInboxAddress(code, this.d.config.inboxDomain), round: 1, max_rounds: Math.min(input.max_rounds ?? this.d.config.maxRounds, 2),
          collect_until: replyBy.toISOString(), ready: false, pay_intent: false, failure_reason: null,
          client_request_id: input.client_request_id ?? null, version: 0, created_at: at, updated_at: at,
        });
      } catch (e) {
        if (input.client_request_id && /client_request/.test(String(e))) {
          const existing = await this.repo.findJobByClientRequestId(input.client_request_id, ws);
          if (existing) return this.dealResult(existing);
        }
        if (!String(e).includes("short_code")) throw e;
      }
    }
    if (!job) throw new Error("could not allocate a job code");
    await this.repo.insertBusinesses(planned.map(({ b, email, phone, card, channel, reachable }): JobBusinessRow => ({
      job_id: job!.id, business_id: businessIdForContact({ email, phone, a2a_card_url: card }), name: b.name.slice(0, 120), email, phone, a2a_card_url: card, channel,
      source: b.source ?? "agent", simulated: b.simulated ?? mode === "mock", status: reachable ? "pending" : "unavailable", thread_id: null, rfq_message_id: null,
      last_inbound_message_id: null, references: [], contacted_at: null, last_reply_at: null, followups_sent: 0, countered_round: 0,
      send_attempts: 0, next_attempt_at: null, escalated_at: null,
    })));
    await this.repo.appendEvent(job.id, "state", { from: null, to: "created" });
    for (const p of planned.filter((x) => !x.reachable)) {
      await this.repo.appendEvent(job.id, "reply", { business_id: businessIdForContact({ email: p.email, phone: p.phone, a2a_card_url: p.card }), summary: `${p.b.name} not contacted: ${p.reason}` });
    }
    const started = start(this.machine(job));
    if (started.ok) await this.commit(job, started.next, started.effects, "deal");
    this.syncVoiceContext();
    // RFQs are sent by the effect (synchronously here, like quote-broker); the job is returned at once.
    return this.dealResult((await this.repo.getJob(job.id))!);
  }

  private async dealResult(job: JobRow): Promise<EngineDealResult> {
    const businesses = await this.repo.getBusinesses(job.id);
    return {
      ok: true, mode: job.mode, job_id: job.id, inbox: job.inbox, state: job.state,
      contacted: businesses.filter((b) => b.contacted_at).map((b) => ({ business_id: b.business_id, business: b.name, simulated: b.simulated, channel: b.channel })),
      not_contacted: businesses.filter((b) => !b.contacted_at).map((b) => ({
        business_id: b.business_id, business: b.name, channel: b.channel,
        reason: b.status === "unavailable" ? this.route(b).reason : b.status === "bounced" ? "send failed" : b.next_attempt_at ? (b.channel === "phone" ? `call scheduled for ${b.next_attempt_at} (call hours)` : `retrying at ${b.next_attempt_at}`) : "pending",
      })),
      eta: `replies usually within minutes; collecting until ${job.collect_until}`,
      next: "Call wait_for_update with this job_id (timeout_s up to 60). Don't email the businesses yourself.",
    };
  }

  /** May deal() contact this business? Every contact it has must be on the recipient allowlist. */
  canContact(b: { email?: string | null; phone?: string | null; a2a_card_url?: string | null }): boolean {
    return [b.email, b.phone?.replace(/[\s().-]/g, ""), b.a2a_card_url].filter((c): c is string => !!c).every((c) => this.allowedRecipient(c));
  }

  private allowedRecipient(contact: string): boolean {
    const list = this.d.config.recipientAllowlist;
    if (!list) return true;
    const c = contact.toLowerCase();
    return list.some((e) => { const x = e.trim().toLowerCase(); return x === c || (x.startsWith("@") && c.endsWith(x)); });
  }

  /** Is this address Haggle's own mailbox (shared Inkbox identity, or any per-job inbox)? */
  private isOwnAddress(address: string): boolean {
    const a = normalizeAddress(address);
    if (this.d.config.sharedInbox) return a === normalizeAddress(this.d.config.sharedInbox);
    return a.endsWith(`@${this.d.config.inboxDomain}`);
  }

  /**
   * Channel routing (CLAUDE.md §6): A2A if the business has an Agent Card, else email, else a Voice
   * AI call. A channel whose port isn't enabled is skipped; email is the fallback for A2A.
   */
  private route(c: { email: string | null; phone: string | null; card?: string | null; a2a_card_url?: string | null; prefer?: Channel; channel?: Channel }): { channel: Channel; reachable: boolean; reason: string } {
    const card = c.card ?? c.a2a_card_url ?? null;
    const prefer = c.prefer ?? (c.channel === "imessage" ? "imessage" : undefined);
    // Text a business: over iMessage (it must have texted `connect @<buyer>` first) or, with iMessage
    // off, SMS from the buyer's own number.
    if (prefer === "imessage" && c.phone) return this.d.imessage || this.d.sms ? { channel: "imessage", reachable: true, reason: this.d.imessage ? "imessage" : "sms" } : { channel: "imessage", reachable: false, reason: "texting businesses is not enabled in this deployment" };
    // An explicit preference for a call or email wins over the default order when it's possible.
    const preferred = c.channel ?? c.prefer;
    if (preferred === "phone" && c.phone && this.d.phone) return { channel: "phone", reachable: true, reason: "phone (preferred)" };
    if (preferred === "email" && c.email) return { channel: "email", reachable: true, reason: "email (preferred)" };
    if (card && this.d.a2a) return { channel: "a2a", reachable: true, reason: "a2a" };
    if (c.email) return { channel: "email", reachable: true, reason: card ? "A2A not enabled; using email" : "email" };
    if (c.phone) return this.d.phone ? { channel: "phone", reachable: true, reason: "phone" } : { channel: "phone", reachable: false, reason: "phone calls are not enabled in this deployment" };
    return { channel: "a2a", reachable: false, reason: "A2A outreach is not enabled in this deployment" };
  }

  // ───────────────────────────── state plumbing ─────────────────────────────

  private machine(job: JobRow): MachineState {
    return { state: job.state, round: job.round, max_rounds: job.max_rounds, collect_until: job.collect_until, ready: job.ready, failure_reason: job.failure_reason };
  }

  private async rankRows(job: JobRow) {
    const quotes = (await this.repo.listQuotes(job.id)).filter((q) => q.status === "current");
    const { compare, moneyCompare, required } = askInfo(job.request);
    const hardIds = new Set(this.requirements(job).filter((r) => r.hard).map((r) => r.id));
    const rankable = quotes.map((q): RankableQuote => ({
      quoteId: q.id, businessId: q.business_id, totalCents: q.total_cents, available: q.record.available, compliant: q.compliant,
      unmet: q.requirement_results.some((r) => hardIds.has(r.requirement_id) && r.met === false),
      senderTrusted: q.sender_trusted, status: q.status, confidence: q.record.confidence, flags: q.record.flags,
      // Custom requests: rank on compare_by (a non-money field needs no total), and a quote missing a required answer can't win.
      ...(compare && !moneyCompare ? { sortValue: sortable(compare, q.record.fields?.[compare.key] ?? null), needsTotal: false } : {}),
      ...(compare ? { direction: job.request.compare_by!.direction } : {}),
      ...(required.length ? { missingRequired: required.some((k) => (q.record.fields?.[k] ?? null) === null) } : {}),
    }));
    return { quotes, rankable, ranking: rankQuotes(rankable, job.budget_cents) };
  }

  /**
   * Can the human approve (and pay) this quote, and what are they knowingly accepting? Only safety
   * and impossibility refuse: a superseded quote, a business that declined, an unverified sender, a
   * pay-elsewhere link, instructions aimed at the agent, or no amount at all. Everything else (over
   * budget, over the spending cap, a requirement failed or not confirmed, a computed total, no
   * deposit, fine-print deposit) is a caveat the approval shows. The operator's per-payment ceiling
   * is checked separately in requestApproval.
   */
  private approvability(job: JobRow, q: QuoteRow, spendingCapCents: number | null = null): { hard: string | null; caveats: string[] } {
    const hard = q.status !== "current" ? "not_current" : !q.record.available ? "unavailable" : !q.sender_trusted ? "unverified_sender"
      : q.record.flags.includes("external_payment_link") ? "external_payment_link" : q.record.flags.includes("prompt_injection") ? "prompt_injection"
      // A request ranked on a non-money answer (e.g. earliest date) needs that answer, not a total.
      : q.total_cents === null && !nonMoneyCompare(job.request) ? "no_total"
      : nonMoneyCompare(job.request) && (q.record.fields?.[job.request.compare_by!.field] ?? null) === null ? "missing_info" : null;
    const caveats: string[] = [];
    const dollars = (c: number) => `$${centsToUsd(c).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const unanswered = (job.request.ask ?? []).filter((f) => f.required && (q.record.fields?.[f.key] ?? null) === null).map((f) => f.label);
    if (unanswered.length) caveats.push(`Didn't answer: ${unanswered.join(", ")}`);
    if (q.total_cents !== null) {
      if (job.budget_cents !== null && q.total_cents > job.budget_cents) caveats.push(`${dollars(q.total_cents - job.budget_cents)} over the ${dollars(job.budget_cents)} budget`);
      if (spendingCapCents !== null && q.total_cents > spendingCapCents) caveats.push(`${dollars(q.total_cents)} is over your ${dollars(spendingCapCents)} spending cap`);
    }
    const reqs = new Map(this.requirements(job).map((r) => [r.id, r]));
    for (const r of q.requirement_results) {
      const req = reqs.get(r.requirement_id);
      if (!req?.hard) continue;
      if (r.met === false) caveats.push(`Doesn't meet: ${req.text} (${r.reason})`);
      else if (r.met === null) caveats.push(`Not confirmed by the business: ${req.text}`);
    }
    const totalSource = q.record.sources.total?.source ?? "";
    if (/^computed/.test(totalSource)) caveats.push(`Total worked out by Haggle, not stated by the business (${totalSource})`);
    const FLAG_TEXT: Record<string, string> = {
      hidden_deposit: "The deposit was only in the fine print (PDF page 2+)", delivery_unclear: "Delivery cost wasn't stated",
      tax_excluded: "Tax isn't included", conflicting_numbers: "Some numbers in the reply didn't add up", low_confidence: "Haggle wasn't confident reading this reply",
    };
    for (const f of q.record.flags) if (FLAG_TEXT[f]) caveats.push(FLAG_TEXT[f]!);
    if (q.total_cents !== null && !(q.deposit_cents && q.deposit_cents > 0)) caveats.push(`No deposit stated: the full ${dollars(q.total_cents)} is charged now`);
    return { hard, caveats };
  }

  /** What the human is knowingly accepting by approving this quote (empty for a clean quote). */
  async approvalCaveats(jobId: string, quoteId: string): Promise<string[]> {
    const job = await this.loadJob(jobId);
    const q = await this.repo.getQuote(quoteId);
    return q && q.job_id === jobId ? this.approvability(job, q, (await this.getSettings(job.workspace_id)).spending_cap_cents).caveats : [];
  }

  private async context(job: JobRow, event?: JobEvent) {
    const { quotes, rankable, ranking } = await this.rankRows(job);
    const businesses = await this.repo.getBusinesses(job.id);
    const manual = event?.type === "negotiation_requested" ? { businessIds: event.businessIds } : undefined;
    const plan = this.counterPlan(job, rankable, businesses, manual);
    const payment = await this.repo.getPaymentForJob(job.id);
    const approval = event?.type === "approval_verified" ? await this.repo.getLatestApproval(job.id) : null;
    return {
      now: this.now(), eligibleQuotes: ranking.ranked.length, approvableQuotes: quotes.filter((q) => this.approvability(job, q).hard === null).length, counterable: plan.length > 0,
      negotiationWindowMs: this.d.config.negotiationWindowMs, paymentInFlight: payment !== null && ["signed", "sent"].includes(payment.status),
      ...(approval ? { approvalAction: approval.action } : {}),
    };
  }

  /**
   * Honest counteroffers. Every eligible quote (any channel) can be the cited basis; each business
   * priced above it is countered on its own channel (email thread, text, a short Voice AI call, or
   * its open A2A context) when that channel can still reach it.
   * Only money comparisons where lower is better are negotiated. A manual round (negotiate tool)
   * may go one round past max_rounds and can be limited to some businesses.
   */
  private counterPlan(job: JobRow, rankable: RankableQuote[], businesses: JobBusinessRow[], manual?: { businessIds?: string[] | undefined }) {
    const { compare, moneyCompare } = askInfo(job.request);
    if (compare && (!moneyCompare || job.request.compare_by?.direction === "max")) return [];
    const byId = new Map(businesses.map((b) => [b.business_id, b]));
    const only = manual?.businessIds?.length ? new Set(manual.businessIds) : null;
    return planCounteroffers(
      rankable.map((r) => ({ ...r, businessName: byId.get(r.businessId)?.name ?? "there", round: this.quoteRound(r.quoteId) })),
      new Date(manual ? this.now().getTime() + this.d.config.negotiationWindowMs : job.collect_until), manual ? MAX_ROUND : job.max_rounds, job.budget_cents,
    ).filter((c) => { const b = byId.get(c.businessId); return (!only || only.has(c.businessId)) && !!b && this.canReach(b); });
  }

  private roundCache = new Map<string, number>();
  private quoteRound(quoteId: string): number {
    return this.roundCache.get(quoteId) ?? 1;
  }

  /** CAS-commit a transition, record it, then run its effects. Returns the committed row or null on conflict. */
  private async commit(job: JobRow, next: MachineState, effects: Effect[], cause: string): Promise<JobRow | null> {
    const updated = await this.repo.casJob(job.id, job.version, {
      state: next.state, round: next.round, collect_until: next.collect_until, ready: next.ready, failure_reason: next.failure_reason,
    });
    if (!updated) return null;
    if (updated.state !== job.state) await this.repo.appendEvent(job.id, "state", { from: job.state, to: updated.state, cause, ...(updated.failure_reason ? { reason: updated.failure_reason } : {}) });
    if (updated.ready && !job.ready) {
      await this.repo.appendEvent(job.id, "ready", { round: updated.round });
      await this.notifyReady(updated);
    }
    if (updated.state === "failed" && job.state !== "failed") await this.notifyHuman(updated, "failed", `the deal for ${updated.request.what} ended without a usable quote${updated.failure_reason ? ` (${updated.failure_reason})` : ""}.`);
    for (const e of effects) await this.runEffect(updated, e);
    if (TERMINAL.has(updated.state) && !TERMINAL.has(job.state)) this.syncVoiceContext();
    return updated;
  }

  async fire(jobId: string, event: JobEvent, cause = event.type): Promise<{ ok: boolean; reason?: string; job?: JobRow }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const job = await this.repo.getJob(jobId);
      if (!job) return { ok: false, reason: "job not found" };
      await this.refreshRounds(job);
      const r = transition(this.machine(job), event, await this.context(job, event));
      if (!r.ok) return { ok: false, reason: r.reason };
      const committed = await this.commit(job, r.next, r.effects, cause);
      if (committed) return { ok: true, job: committed };
    }
    return { ok: false, reason: "conflict" };
  }

  private async refreshRounds(job: JobRow) {
    for (const q of await this.repo.listQuotes(job.id)) this.roundCache.set(q.id, q.round);
  }

  // ───────────────────────────── effects (after commit) ─────────────────────────────

  private async runEffect(job: JobRow, e: Effect) {
    if (e.type === "send_rfqs") await this.sendRfqs(job);
    else if (e.type === "send_counteroffers") await this.sendCounteroffers(job, e.round, e.businessIds);
    else if (e.type === "send_accept") await this.sendAccept(job);
    else if (e.type === "send_confirmation") await this.sendConfirmation(job);
    else if (e.type === "notify_cancelled") await this.notifyCancelled(job);
  }

  /** Send once per idempotency key; record the outbound message. */
  private async sendRecorded(job: JobRow, b: JobBusinessRow | null, kind: MessageRow["kind"], key: string, msg: { to: string | null; subject: string; bodyText: string; attachments?: OutboundAttachment[]; inThread?: boolean; round?: number; approvalId?: string }) {
    const prior = await this.repo.findMessageByIdempotencyKey(key);
    if (prior) return prior;
    if (!msg.to) throw new EngineError("no_email", `${b?.name ?? "This recipient"} has no email address.`, "Reach this business on its own channel.", "get_quotes");
    const to = msg.to;
    const thread = msg.inThread && b?.last_inbound_message_id ? { inReplyTo: b.last_inbound_message_id, references: b.references.slice(-10) } : undefined;
    const out = await this.d.email.send({ from: job.inbox, to, subject: msg.subject, bodyText: msg.bodyText, idempotencyKey: key, ...(thread ? { thread } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}) });
    const row = await this.repo.insertMessage({
      job_id: job.id, business_id: b?.business_id ?? null, approval_id: msg.approvalId ?? null, direction: "out", kind,
      provider_email_id: out.providerId, idempotency_key: key, rfc_message_id: out.messageId, thread_id: b?.thread_id ?? null,
      from_address: job.inbox, to_address: to, subject: msg.subject, body_text: msg.bodyText,
      attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, content_type: a.contentType, size_bytes: a.content.byteLength, tar_path: null })),
      attachments_download_url: null, sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null,
      round: msg.round ?? null, simulated: job.mode === "mock",
    });
    return row ?? (await this.repo.findMessageByIdempotencyKey(key));
  }

  private async sendRfqs(job: JobRow) {
    for (const b of await this.repo.getBusinesses(job.id)) {
      if (b.status !== "pending") continue;
      if (b.channel === "phone") {
        if ((this.d.config.callDelayMs ?? 0) > 0 && this.d.phone && b.phone) {
          // Scheduled: the call goes out after callDelayMs (advanceJob), citing real competing quotes.
          await this.repo.updateBusiness(job.id, b.business_id, { status: "contacted" });
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call to ${b.name} scheduled (Voice AI)`, channel: "phone" });
          continue;
        }
        await this.placeRfqCall(job, b);
        continue;
      }
      if (b.channel === "imessage") {
        await this.sendIMessageToBusiness(job, b, "rfq", `imsg-rfq:${job.id}:${b.business_id}`, HaggleEngine.rfqIMessageText(b.name, job, this.customer(job)), 1);
        continue;
      }
      if (b.channel === "a2a") {
        await this.sendA2aRfq(job, b);
        continue;
      }
      if (b.email) await this.sendRfqEmail(job, b);
    }
    await this.fire(job.id, { type: "rfqs_sent" });
  }

  /** First contact on the business's routed channel (also used for retries that come due). */
  private async contactBusiness(job: JobRow, b: JobBusinessRow) {
    if (b.channel === "phone") await this.placeRfqCall(job, b);
    else if (b.channel === "imessage") await this.sendIMessageToBusiness(job, b, "rfq", `imsg-rfq:${job.id}:${b.business_id}`, HaggleEngine.rfqIMessageText(b.name, job, this.customer(job)), 1);
    else if (b.channel === "a2a") await this.sendA2aRfq(job, b);
    else if (b.email) await this.sendRfqEmail(job, b);
  }

  /** Who this job's AI assistant acts for, as businesses hear it ("Acme Labs" or "a customer"). */
  private customer(job: Pick<JobRow, "request">): string {
    return customerOf(job.request, this.d.config.customerName);
  }

  /** The sign-off on every email to a business: the customer's AI assistant, never a brand. */
  private signOff(job: Pick<JobRow, "request">): string {
    return `Thank you!\nAI assistant for ${this.customer(job)}`;
  }

  /** The RFQ email for this job (catering default, or the custom ask and details). */
  private rfqEmail(job: JobRow, b: JobBusinessRow) {
    const r = job.request;
    return buildRfqEmail({
      shortCode: job.short_code, businessName: b.name, what: r.what, customer: this.customer(job), ...(r.quantity !== undefined ? { quantity: r.quantity } : {}), ...(r.unit ? { unit: r.unit } : {}),
      ...(r.date ? { date: r.date } : {}), location: r.area, requirements: r.requirements.filter((x) => x.hard).map((x) => x.text), replyBy: new Date(job.collect_until),
      ...(r.details?.length ? { details: r.details } : {}), ...(r.ask?.length ? { askLabels: r.ask.map((f) => ({ label: f.label, required: f.required })) } : {}),
    });
  }

  private async sendRfqEmail(job: JobRow, b: JobBusinessRow) {
    try {
      const m = await this.sendRecorded(job, b, "rfq", sendKeys.rfq(job.id, b.business_id), { to: b.email, ...this.rfqEmail(job, b), attachments: [jsonPart("rfq.json", this.rfqPart(job))] });
      await this.repo.updateBusiness(job.id, b.business_id, { status: "contacted", contacted_at: this.now().toISOString(), rfq_message_id: m?.rfc_message_id ?? null, references: m?.rfc_message_id ? [m.rfc_message_id] : [], next_attempt_at: null });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `RFQ sent to ${b.name}` });
    } catch (err) {
      await this.onSendFailure(job, b, err, "RFQ");
    }
  }

  /**
   * A send failed. Retryable provider errors (rate limits, outages) keep the business pending and
   * retry the same channel later with the same idempotency key, a bounded number of times. Anything
   * else (bad address, opted out, out of retries) moves on: a business with a phone gets a Voice AI
   * call (email -> call escalation), otherwise it is marked bounced.
   */
  private async onSendFailure(job: JobRow, b: JobBusinessRow, err: unknown, what: string) {
    const f = err instanceof ChannelSendError ? err : null;
    this.log("send_failed", { job_id: job.id, business_id: b.business_id, what, reason: f?.reason ?? "error", error: (err as Error).message });
    if (f?.retryable && b.send_attempts + 1 < MAX_SEND_ATTEMPTS) {
      const at = new Date(this.now().getTime() + Math.max(f.retryAfterMs, 1_000)).toISOString();
      await this.repo.updateBusiness(job.id, b.business_id, { send_attempts: b.send_attempts + 1, next_attempt_at: at });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${what} to ${b.name} delayed (${f.reason.replace(/_/g, " ")}); retrying` });
      return;
    }
    await this.repo.updateBusiness(job.id, b.business_id, { status: "bounced", next_attempt_at: null });
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${what} to ${b.name} failed: ${f?.reason.replace(/_/g, " ") ?? (err as Error).name}` });
    if (b.channel === "email" && b.phone && this.d.phone && this.d.config.escalateEmailToCallAfterMs !== undefined) await this.placeRfqCall(job, { ...b, status: "bounced" }, { escalation: true });
  }

  /**
   * The structured RFQ (email rfq.json and A2A data part). v3 keys plus the CONTRACTS.md §5 keys
   * (protocol/type) and the flat keys Aarnav's sellers read (quantity, vegetarian, date). Additive:
   * unknown keys are ignored by every reader.
   */
  private rfqPart(job: JobRow) {
    const veg = job.request.requirements.find((r) => r.kind === "dietary" && /vegetarian/i.test(r.text) && r.min_count !== undefined);
    return {
      haggle: "rfq/1", protocol: "haggle.v0", type: "rfq", job_id: job.id, what: job.request.what,
      ...(job.request.quantity !== undefined ? { quantity: job.request.quantity } : {}), ...(job.request.unit ? { unit: job.request.unit } : {}),
      ...(veg ? { vegetarian: veg.min_count } : {}),
      ...(job.request.date ? { date: job.request.date } : {}), location: job.request.area,
      requirements: job.request.requirements.map((r) => ({ id: r.id, text: r.text, label: r.text, hard: r.hard, mandatory: r.hard, ...(r.min_count !== undefined ? { min_count: r.min_count } : {}) })),
      ...(job.request.details?.length ? { details: job.request.details } : {}),
      ...(job.request.ask?.length ? { ask: job.request.ask.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required })) } : {}),
      reply_by: job.collect_until, reply_to: job.inbox,
    };
  }

  /** Record an outbound A2A task (the RFQ or a counter) once, keyed like an email send. */
  private async recordA2aOutbound(job: JobRow, b: JobBusinessRow, kind: "rfq" | "counter" | "message" | "confirmation" | "followup" | "answer", key: string, taskId: string, text: string, round: number) {
    return this.repo.insertMessage({
      job_id: job.id, business_id: b.business_id, approval_id: null, direction: "out", kind, channel: "a2a", provider_email_id: `a2a-task:${taskId}`, idempotency_key: key,
      rfc_message_id: null, thread_id: b.thread_id, from_address: job.inbox, to_address: b.a2a_card_url, subject: null, body_text: text, attachments: [], attachments_download_url: null,
      sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round, simulated: job.mode === "mock",
    });
  }

  /** A2A task to the business's pinned Agent Card: readable text + the RFQ as a data part. */
  private async sendA2aRfq(job: JobRow, b: JobBusinessRow) {
    const key = `a2a:${job.id}:${b.business_id}`;
    if (!this.d.a2a || !b.a2a_card_url) {
      await this.repo.updateBusiness(job.id, b.business_id, { status: "unavailable" });
      return;
    }
    if (await this.repo.findMessageByIdempotencyKey(key)) return;
    const email = this.rfqEmail(job, b);
    try {
      const t = await this.d.a2a.send({ cardUrl: b.a2a_card_url, text: email.bodyText, data: this.rfqPart(job), messageId: `haggle-rfq-${job.id}-${b.business_id}` });
      await this.repo.updateBusiness(job.id, b.business_id, { status: "contacted", contacted_at: this.now().toISOString(), thread_id: t.contextId, rfq_message_id: t.taskId });
      await this.recordA2aOutbound(job, { ...b, thread_id: t.contextId }, "rfq", key, t.taskId, email.bodyText, 1);
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `RFQ sent to ${b.name} (A2A task)`, channel: "a2a" });
    } catch (err) {
      await this.repo.updateBusiness(job.id, b.business_id, { status: "bounced" });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `A2A task to ${b.name} failed: ${(err as Error).name}` });
      this.log("a2a_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
    }
  }

  private a2aPolledAt = new Map<string, number>();

  /**
   * Results of an A2A task Haggle sent (webhook a2a.sent_task.updated, or polling). Matched by the
   * task id recorded at send time, so only tasks Haggle sent to the PINNED card count. Each agent
   * message becomes one inbound reply (text + its data part as quote.json), parsed like email.
   * Idempotent per (task, message).
   */
  async ingestA2aTask(taskId: string, opts: { simulated?: boolean } = {}): Promise<{ jobId: string | null; outcome: string }> {
    const out = await this.repo.findMessageByProviderId(`a2a-task:${taskId}`);
    if (!out || out.direction !== "out" || out.channel !== "a2a" || !out.job_id || !out.business_id) return { jobId: null, outcome: "unknown_task" };
    const job = await this.repo.getJob(out.job_id);
    const b = (await this.repo.getBusinesses(out.job_id)).find((x) => x.business_id === out.business_id);
    if (!job || !b || !b.a2a_card_url || !this.d.a2a) return { jobId: out.job_id, outcome: "a2a_unavailable" };
    this.a2aPolledAt.set(taskId, Date.now());
    const view = await this.d.a2a.getTask({ cardUrl: b.a2a_card_url, taskId });
    let stored = 0;
    for (const m of view.agentMessages) {
      const quote = m.data.find((d) => d.type === "quote" || d.haggle === "quote/1") ?? m.data[0];
      const row = await this.repo.insertMessage({
        job_id: job.id, business_id: b.business_id, approval_id: null, direction: "in", kind: "reply", channel: "a2a", provider_email_id: `a2a-msg:${taskId}:${m.messageId}`, idempotency_key: null,
        rfc_message_id: null, thread_id: view.contextId, from_address: b.a2a_card_url, to_address: job.inbox, subject: null, body_text: m.text.slice(0, 20_000) || null,
        attachments: quote ? [{ filename: "quote.json", content_type: "application/json", size_bytes: JSON.stringify(quote).length, tar_path: null, content_base64: Buffer.from(JSON.stringify(quote)).toString("base64") }] : [],
        attachments_download_url: null,
        // Trusted: Haggle created this task at the business's pinned Agent Card and read the result back itself.
        sender_trusted: true, trust_reason: "a2a-task-to-pinned-card", matched_via: "a2a_task", parse_status: m.text || quote ? "pending" : "none", quarantine_reason: null,
        round: null, simulated: opts.simulated ?? job.mode === "mock",
      });
      if (!row) continue;
      stored++;
      if (!TERMINAL.has(job.state)) {
        await this.repo.updateBusiness(job.id, b.business_id, { last_reply_at: this.now().toISOString(), ...(b.status === "contacted" || b.status === "question" ? { status: "replied" as const } : {}) });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `A2A reply from ${b.name}`, channel: "a2a", ...snippet(messageSnippet(m.text)) });
      }
    }
    if (stored === 0 && ["failed", "canceled", "rejected"].includes(view.state) && b.status === "contacted") {
      await this.repo.updateBusiness(job.id, b.business_id, { status: "declined" });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `A2A task to ${b.name} ended: ${view.state}`, channel: "a2a" });
    }
    if (stored) await this.repo.touchJob(job.id);
    return { jobId: job.id, outcome: stored ? "stored" : `a2a:${view.state}` };
  }

  /** Poll unanswered A2A tasks (at most every 15 s each), so results arrive even without the webhook. */
  private async pollA2a(job: JobRow) {
    if (!this.d.a2a) return;
    const msgs = await this.repo.listMessages(job.id);
    const answered = new Set(msgs.filter((m) => m.direction === "in" && m.channel === "a2a" && m.provider_email_id).map((m) => m.provider_email_id!.split(":")[1]));
    for (const m of msgs) {
      if (m.direction !== "out" || m.channel !== "a2a" || !m.provider_email_id) continue;
      const taskId = m.provider_email_id.slice("a2a-task:".length);
      if (answered.has(taskId) || Date.now() - (this.a2aPolledAt.get(taskId) ?? 0) < 15_000) continue;
      try {
        await this.ingestA2aTask(taskId);
      } catch (err) {
        this.a2aPolledAt.set(taskId, Date.now());
        this.log("a2a_poll_failed", { job_id: job.id, error: (err as Error).message });
      }
    }
  }

  /**
   * The RFQ as one iMessage within Inkbox's pre-reply rules: ≤ 159 chars, no links, no phone numbers.
   * It says it's an AI assistant and for whom (the customer, never "Haggle"), what, when, where, the
   * hard requirements, and asks for the total and deposit. Long names are clipped (the area first),
   * never the disclosure or the reference code.
   */
  static rfqIMessageText(business: string, job: Pick<JobRow, "short_code" | "request">, customer?: string): string {
    const r = job.request;
    // Clip at a word boundary when that keeps at least half; no links or phone numbers.
    const clean = (s: string, n: number) => {
      const full = plainName(s, 200);
      if (full.length <= n) return full;
      const cut = full.slice(0, n);
      const space = cut.lastIndexOf(" ");
      return (space >= n / 2 ? cut.slice(0, space) : cut).trim();
    };
    const who = clean(customer ?? customerOf(r), 24) || "a customer";
    const veg = r.requirements.find((q) => q.kind === "dietary" && q.min_count !== undefined);
    const delivery = r.requirements.some((q) => q.kind === "delivery" && q.hard);
    const d = new Date(`${r.date}T12:00:00Z`);
    const date = Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const needs = [veg ? `${veg.min_count}+ ${/veg/i.test(veg.text) ? "veg" : "special"}` : "", delivery ? "delivered" : ""].filter(Boolean).join(", ");
    const build = (whatN: number, areaN: number, refWord: boolean) =>
      `Hi ${clean(business, 24)}, I'm an AI assistant for ${who}. Quote for ${clean(r.what, whatN)}${r.quantity !== undefined ? ` for ${r.quantity}` : ""}${date ? ` on ${date}` : ""}${areaN && r.area ? ` in ${clean(r.area.split(",")[0]!, areaN)}` : ""}${needs ? `: ${needs}` : ""}. Total + deposit? ${refWord ? "Ref " : ""}HG-${job.short_code}`;
    const tries: [number, number, boolean][] = [[24, 18, true], [24, 12, true], [24, 18, false], [24, 12, false], [20, 0, true], [14, 0, true]];
    for (const [w, a, ref] of tries) {
      const t = build(w, a, ref);
      if (t.length <= 159) return t;
    }
    return fitText(build(14, 0, true), 159);
  }

  /** One text to a business on the text channel (iMessage, or SMS when iMessage is off), recorded once per idempotency key. */
  private async sendIMessageToBusiness(job: JobRow, b: JobBusinessRow, kind: "rfq" | "answer" | "counter" | "followup" | "message" | "confirmation" | "cancel", key: string, text: string, round: number | null) {
    const prior = await this.repo.findMessageByIdempotencyKey(key);
    if (prior) return prior;
    if ((!this.d.imessage && !this.d.sms) || !b.phone) {
      // Only an RFQ that can't go out makes the business unavailable; a later text just isn't sent.
      if (kind === "rfq") await this.repo.updateBusiness(job.id, b.business_id, { status: "unavailable" });
      return null;
    }
    // iMessage when it's on; otherwise SMS from the buyer's own number (same text channel).
    const viaSms = !this.d.imessage;
    try {
      const body = fitText(text, viaSms ? SMS_LIMIT : 159);
      const sent = viaSms ? await this.d.sms!.send({ to: b.phone, text: body, idempotencyKey: key }) : await this.d.imessage!.send({ to: b.phone, text: body, idempotencyKey: key });
      if (viaSms) this.lastSms.set(b.phone, { kind: "business", jobId: job.id });
      const row = await this.repo.insertMessage({
        job_id: job.id, business_id: b.business_id, approval_id: null, direction: "out", kind, channel: "imessage", provider_email_id: `${viaSms ? "sms" : "imsg"}:${sent.messageId}`, idempotency_key: key,
        rfc_message_id: null, thread_id: null, from_address: job.inbox, to_address: b.phone, subject: null, body_text: body, attachments: [], attachments_download_url: null,
        sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round, simulated: job.mode === "mock",
      });
      if (kind === "rfq") {
        await this.repo.updateBusiness(job.id, b.business_id, { status: "contacted", contacted_at: this.now().toISOString() });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `RFQ texted to ${b.name} (${viaSms ? "SMS" : "iMessage"})`, channel: "imessage" });
      }
      return row;
    } catch (err) {
      if (kind === "rfq") {
        await this.repo.updateBusiness(job.id, b.business_id, { status: "bounced" });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: viaSms ? `Text to ${b.name} failed` : `iMessage to ${b.name} failed (has it texted connect @${job.inbox.split("@")[0]}?)`, channel: "imessage" });
      }
      this.log("imessage_business_failed", { job_id: job.id, business_id: b.business_id, kind, error: (err as Error).message });
      if (kind !== "rfq") throw err;
      return null;
    }
  }

  /** The last SMS to each number: a texted reply answers whatever Haggle texted that number last. */
  private lastSms = new Map<string, { kind: "business" | "human"; jobId: string; questionId?: string; approvalId?: string }>();
  private notified = new Set<string>();
  /** `${to}|${text}` already texted: the same words again (a re-read, an unchanged revision) aren't news. */
  private notifiedText = new Set<string>();
  /** Texts that need the human (questions, approvals, results) refused while their number was paused; re-sent when it texts back. */
  private heldTexts = new Map<string, (HeldText & { jobId: string })[]>();
  /** Numbers already asked to reply RESUME in this pause. */
  private resumeAsked = new Set<string>();
  /** `${to}|${jobId}|${kind}`: the pause was already noted on that deal. */
  private pausedNoted = new Set<string>();

  /**
   * A Voice AI call to a business after first contact (a follow-up, an answer, a counteroffer, a
   * message, a confirmation): a phone business stays on the phone. Placed once per key, only to the
   * pinned number. During another call to the number, the cooldown or outside call hours it is
   * scheduled (a `call_scheduled` event) and placed by a later advance (dueScheduledCalls); `now`
   * skips the wait (a confirmation, sent as the job closes, as before).
   */
  private async callBusiness(job: JobRow, b: JobBusinessRow, c: { key: string; kind: MessageRow["kind"]; reason: string; body: string; round?: number | null; approvalId?: string | null; now?: boolean }): Promise<{ placed: MessageRow | null; scheduledFor?: string }> {
    const prior = await this.repo.findMessageByIdempotencyKey(c.key);
    if (prior) return { placed: prior };
    if (!this.d.phone || !b.phone) return { placed: null };
    const blocked = c.now ? null : await this.callBlockedUntil(job, b.phone);
    if (blocked) {
      const at = blocked.toISOString();
      if (!(await this.repo.listEvents(job.id)).some((e) => e.type === "call_scheduled" && e.data.key === c.key)) {
        await this.repo.appendEvent(job.id, "call_scheduled", { business_id: b.business_id, key: c.key, kind: c.kind, reason: c.reason, body: c.body, round: c.round ?? null, approval_id: c.approvalId ?? null, at });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call to ${b.name} scheduled for ${at} (call hours or a recent call)`, channel: "phone" });
      }
      return { placed: null, scheduledFor: at };
    }
    const { callId } = await this.d.phone.placeCall({ jobId: job.id, businessId: b.business_id, toNumber: b.phone, reason: c.reason, idempotencyKey: c.key });
    const row = await this.repo.insertMessage({
      job_id: job.id, business_id: b.business_id, approval_id: c.approvalId ?? null, direction: "out", kind: c.kind, channel: "phone", provider_email_id: callId, idempotency_key: c.key,
      rfc_message_id: null, thread_id: null, from_address: job.inbox, to_address: b.phone, subject: null, body_text: c.body, attachments: [], attachments_download_url: null,
      sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: c.round ?? null, simulated: job.mode === "mock",
    });
    return { placed: row ?? (await this.repo.findMessageByIdempotencyKey(c.key)) };
  }

  /** Scheduled calls (callBusiness) whose time has come: placed once each, re-checking call hours and the cooldown. */
  private async dueScheduledCalls(job: JobRow) {
    if (!this.d.phone || TERMINAL.has(job.state)) return;
    const scheduled = (await this.repo.listEvents(job.id)).filter((e) => e.type === "call_scheduled");
    if (!scheduled.length) return;
    const now = this.now().getTime();
    const businesses = await this.repo.getBusinesses(job.id);
    for (const e of scheduled) {
      const d = e.data;
      const key = String(d.key);
      if (Date.parse(String(d.at)) > now || (d.kind === "counter" && job.state !== "negotiating")) continue;
      if (await this.repo.findMessageByIdempotencyKey(key)) continue;
      const b = businesses.find((x) => x.business_id === d.business_id);
      if (!b?.phone) continue;
      try {
        const r = await this.callBusiness(job, b, { key, kind: d.kind as MessageRow["kind"], reason: String(d.reason), body: String(d.body), round: d.round == null ? null : Number(d.round), approvalId: d.approval_id == null ? null : String(d.approval_id) });
        if (!r.placed) continue;
        if (!["quoted", "declined"].includes(b.status)) await this.repo.updateBusiness(job.id, b.business_id, { status: "ringing" });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Calling ${b.name} (Voice AI, ${d.kind === "counter" ? "counteroffer" : d.kind === "answer" ? "answer to its question" : d.kind})`, channel: "phone" });
      } catch (err) {
        this.log("call_failed", { job_id: job.id, business_id: b.business_id, key, error: (err as Error).message });
      }
    }
  }

  /** An A2A message task in the business's open context (follow-up, answer, message), recorded once per key. */
  private async sendA2aMessage(job: JobRow, b: JobBusinessRow, kind: "followup" | "answer" | "message", key: string, text: string): Promise<MessageRow | null> {
    const prior = await this.repo.findMessageByIdempotencyKey(key);
    if (prior) return prior;
    if (!this.d.a2a || !b.a2a_card_url || !b.thread_id) return null;
    const t = await this.d.a2a.send({ cardUrl: b.a2a_card_url, text, data: { haggle: "message/1", protocol: "haggle.v0", type: kind, job_id: job.id }, messageId: `haggle-${key.replace(/:/g, "-")}`, contextId: b.thread_id });
    return this.recordA2aOutbound(job, b, kind, key, t.taskId, text, job.round);
  }

  /** Whether the business's own (first-contact) channel can carry another message right now. */
  private canReach(b: JobBusinessRow): boolean {
    return b.channel === "email" ? !!b.email : b.channel === "imessage" ? !!((this.d.imessage || this.d.sms) && b.phone)
      : b.channel === "phone" ? !!(this.d.phone && b.phone) : !!(this.d.a2a && b.a2a_card_url && b.thread_id);
  }

  /**
   * The one automatic follow-up for an exact all-in total (none stated, or only worked out from its
   * parts), on the channel the business was first contacted on: in its email thread, by text, as a
   * short Voice AI call, or in its A2A context. Never switches channel. Returns whether it went out
   * (or, for a call, was scheduled).
   */
  private async askExactTotal(job: JobRow, b: JobBusinessRow, readCents: number | null): Promise<boolean> {
    if (b.followups_sent >= 1 || !this.canReach(b)) return false;
    const r = job.request;
    const key = sendKeys.followUp(job.id, b.business_id, 1);
    const qty = quantityText(r.quantity, r.unit);
    let how: string | null = null;
    try {
      if (b.channel === "email") {
        const read = readCents !== null ? ` We read your quote as ${usdText(readCents)} in total.` : "";
        await this.sendRecorded(job, b, "followup", key, {
          to: b.email, subject: `[HG-${job.short_code}] Quote request: ${r.what}`, inThread: true,
          bodyText: `Hi ${b.name},\n\nThanks for your reply!${read} Could you tell us the exact all-in total${qty ? ` for ${qty}` : ""}, including delivery and tax, and any deposit? We can't compare estimates.\n\n${this.signOff(job)}`,
        });
        how = "email";
      } else if (b.channel === "imessage") {
        const read = readCents !== null ? ` We worked it out as ${usdText(readCents)} all in.` : "";
        how = (await this.sendIMessageToBusiness(job, b, "followup", key, `Thanks! AI assistant for ${this.customer(job)} again.${read} Could you text back your exact all-in total, incl. delivery and tax, and the deposit? Ref HG-${job.short_code}`, null)) ? "text" : null;
      } else if (b.channel === "phone") {
        const ask = `${readCents !== null ? `the exact all-in total (we worked it out as ${usdText(readCents)} from their prices; ask them to confirm or correct it)` : "one exact all-in total"}, including delivery and tax, and any deposit`;
        const c = await this.callBusiness(job, b, { key, kind: "followup", reason: this.taskBrief(job, b, "followup", ask), body: ask });
        how = c.placed ? "call" : c.scheduledFor ? "call, scheduled" : null;
      } else {
        const read = readCents !== null ? ` We read your quote as ${usdText(readCents)} in total.` : "";
        how = (await this.sendA2aMessage(job, b, "followup", key, `Thanks for your reply!${read} Could you send the exact all-in total${qty ? ` for ${qty}` : ""}, including delivery and tax, and any deposit?`)) ? "A2A" : null;
      }
    } catch (err) {
      this.log("followup_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
      return false;
    }
    if (!how) return false;
    await this.repo.updateBusiness(job.id, b.business_id, { followups_sent: b.followups_sent + 1 });
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Asked ${b.name} for the exact total (${how})`, channel: b.channel });
    return true;
  }

  /** Quotes are final: text the best eligible one (computed by the ranker, never by the model). */
  private async notifyReady(job: JobRow) {
    if (!this.d.sms) return;
    try {
      const { ranking, quotes } = await this.rankRows(job);
      const best = ranking.ranked[0];
      const q = best ? quotes.find((x) => x.id === best.quoteId) : undefined;
      const name = q ? (await this.repo.getBusinesses(job.id)).find((b) => b.business_id === q.business_id)?.name : undefined;
      await this.notifyHuman(job, `ready:${job.round}`, q?.total_cents && name
        ? `quotes for ${job.request.what} are in. Best: ${name} at ${usdText(q.total_cents)}. Approve it on the deal board.`
        : `quotes for ${job.request.what} are in, but none meets every requirement. See the deal board.`);
    } catch (err) {
      this.log("notify_failed", { job_id: job.id, key: "ready", error: (err as Error).message });
    }
  }

  /** Who gets update texts for this job: the operator's notify number, else the settings approver. */
  private async notifyTarget(job: JobRow): Promise<string | null> {
    if (!this.d.sms) return null;
    return this.d.config.notifyPhone?.trim() || (await this.getSettings(job.workspace_id)).approver_phone || null;
  }

  /**
   * Text the human about an update. Best effort: a failed text never blocks the deal. One text per
   * key (also Inkbox-idempotent across restarts), never the same words twice; the reply comes back
   * through ingestText. Routine updates (a new quote, a finished call) stop at ROUTINE_TEXT_LIMIT
   * unanswered texts so questions, approvals and the result still get through Inkbox's 10-text limit.
   */
  private async notifyHuman(job: JobRow, key: string, text: string, questionId?: string) {
    const idempotencyKey = `notify:${job.id}:${key}`;
    if (this.notified.has(idempotencyKey)) return;
    try {
      const to = await this.notifyTarget(job);
      if (!to) return;
      const body = `Haggle: ${text} (HG-${job.short_code})`.slice(0, SMS_LIMIT);
      if (this.notifiedText.has(`${to}|${body}`)) return;
      await this.textHuman(job, to, { key: idempotencyKey, text: body, routine: !questionId && /^(quote|unpriced|call):/.test(key), ...(questionId ? { questionId } : {}) });
    } catch (err) {
      this.log("notify_failed", { job_id: job.id, key, reason: "error", error: (err as Error).message });
    }
  }

  /**
   * Send one text to the human through the text budget. Never throws: a refusal is logged with its
   * reason and noted on the deal once, and a text that needs the human is held until they reply.
   */
  private async textHuman(job: JobRow, to: string, t: HeldText & { routine?: boolean; attempt?: number }): Promise<{ ok: true; messageId: string } | { ok: false; reason: string }> {
    const budget = this.textBudget!;
    const short = t.key.replace(`notify:${job.id}:`, "");
    if (budget.isBlocked(to)) {
      if (!t.routine) this.holdText(to, job.id, t);
      this.log("notify_held", { job_id: job.id, key: short, reason: "unanswered_limit" });
      await this.noteTextsPaused(job, to, "blocked");
      return { ok: false, reason: "unanswered_limit" };
    }
    if (t.routine && (await budget.unanswered(to)) >= ROUTINE_TEXT_LIMIT) {
      this.log("notify_held", { job_id: job.id, key: short, reason: "routine_text_budget" });
      await this.noteTextsPaused(job, to, "held");
      if (!this.resumeAsked.has(to)) {
        this.resumeAsked.add(to);
        await this.textHuman(job, to, { key: `notify:${job.id}:resume:${this.now().getTime()}`, text: `Haggle: more updates are waiting. Reply RESUME to keep getting texts (they pause after 10 with no reply). (HG-${job.short_code})` });
      }
      return { ok: false, reason: "routine_text_budget" };
    }
    this.notified.add(t.key);
    try {
      // A retry gets a fresh provider key: Inkbox may replay a refused send for the old one.
      const sent = await this.d.sms!.send({ to, text: t.text, idempotencyKey: t.attempt ? `${t.key}:retry:${t.attempt}` : t.key });
      this.notifiedText.add(`${to}|${t.text}`);
      // Only a question or an approval expects the human's reply; other updates don't change where a reply goes.
      if (t.questionId || t.approvalId) this.lastSms.set(to, { kind: "human", jobId: job.id, ...(t.questionId ? { questionId: t.questionId } : {}), ...(t.approvalId ? { approvalId: t.approvalId } : {}) });
      return { ok: true, messageId: sent.messageId };
    } catch (err) {
      this.notified.delete(t.key);
      const blocked = isUnansweredLimitError(err);
      const reason = blocked ? "unanswered_limit" : err instanceof ChannelSendError ? err.reason : "error";
      this.log(blocked ? "notify_blocked" : "notify_failed", { job_id: job.id, key: short, reason, error: (err as Error).message.slice(0, 300) });
      if (blocked) {
        if (!t.routine) this.holdText(to, job.id, t);
        await this.noteTextsPaused(job, to, "blocked");
      }
      return { ok: false, reason };
    }
  }

  private holdText(to: string, jobId: string, t: HeldText) {
    const list = (this.heldTexts.get(to) ?? []).filter((h) => h.key !== t.key);
    list.push({ jobId, key: t.key, text: t.text, ...(t.questionId ? { questionId: t.questionId } : {}), ...(t.approvalId ? { approvalId: t.approvalId } : {}) });
    this.heldTexts.set(to, list.slice(-3));
  }

  /** Once per deal and pause: say on the deal (wait_for_update) why texts stopped and how to resume. */
  private async noteTextsPaused(job: JobRow, to: string, kind: "blocked" | "held") {
    const k = `${to}|${job.id}|${kind}`;
    if (this.pausedNoted.has(k)) return;
    this.pausedNoted.add(k);
    await this.repo.appendEvent(job.id, "reply", {
      business_id: null, channel: "phone",
      summary: kind === "blocked"
        ? "Texts to you are paused: Inkbox holds texts after 10 with no reply. Text Haggle back (e.g. RESUME) and it re-sends what you missed; the deal board is up to date."
        : "Routine text updates paused to keep texts for questions and approval (Inkbox allows 10 without a reply). Reply RESUME to get every update again.",
    }).catch(() => undefined);
  }

  /** Any text from a number lifts Inkbox's pause on it and resets its count. */
  private textReplied(from: string) {
    if (!this.textBudget) return;
    this.textBudget.replied(from);
    this.resumeAsked.delete(from);
    for (const k of [...this.pausedNoted]) if (k.startsWith(`${from}|`)) this.pausedNoted.delete(k);
  }

  /** Re-send what the human missed while paused (still-open questions and approvals, results). */
  private async flushHeldTexts(from: string) {
    const held = this.heldTexts.get(from);
    if (!held?.length) return;
    this.heldTexts.delete(from);
    for (const h of held) {
      try {
        const job = await this.repo.getJob(h.jobId);
        if (!job) continue;
        if (h.approvalId) {
          const a = await this.repo.getApproval(h.approvalId);
          if (a?.status === "pending") await this.sendApprovalSms(job, a, this.now().getTime());
          continue;
        }
        if (h.questionId && (await this.repo.listQuestions(job.id)).find((q) => q.id === h.questionId)?.status !== "pending") continue;
        await this.textHuman(job, from, { ...h, attempt: this.now().getTime() });
      } catch (err) {
        this.log("notify_failed", { job_id: h.jobId, key: h.key, reason: "error", error: (err as Error).message });
      }
    }
  }

  /**
   * A text to the buyer's number (Inkbox text.received). It answers whatever Haggle texted that
   * number last: from a phone business it is a reply parsed like its call; from the human (the
   * notify number or a settings approver) it answers the open business question. Anyone else is
   * ignored. Idempotent per message id.
   */
  async ingestText(m: { messageId: string; from: string; text: string; inbound?: boolean }): Promise<{ jobId: string | null; outcome: string }> {
    if (m.inbound === false) return { jobId: null, outcome: "outbound" };
    const from = m.from.replace(/[\s().-]/g, "");
    if (await this.repo.findMessageByProviderId(`sms-in:${m.messageId}`)) return { jobId: null, outcome: "duplicate" };
    // Any reply lifts Inkbox's pause on this number; what the human missed is re-sent after routing.
    this.textReplied(from);
    const r = await this.routeText(m, from);
    await this.flushHeldTexts(from);
    return r;
  }

  /**
   * An approval decision texted by the human ("YES 4821" / "NO 4821") to an approval Haggle texted
   * them. Only the job's text number (notify number, else settings approver) counts. Without a code,
   * a bare yes/no counts only when the approval was the last thing Haggle texted that number;
   * otherwise it is left to the normal routing (an answer to a business, a business reply).
   */
  private async ingestTextApproval(m: { messageId: string; text: string }, from: string, open: JobRow[]): Promise<{ jobId: string | null; outcome: string } | null> {
    const parsed = m.text.trim().match(TEXT_DECISION);
    if (!parsed) return null;
    const texted: ApprovalRow[] = [];
    for (const job of open) {
      if (from !== (await this.notifyTarget(job))) continue;
      const a = await this.repo.getLatestApproval(job.id);
      if (a && (await this.repo.findMessageByIdempotencyKey(`sms:${sendKeys.approvalRequest(a.id)}`))) texted.push(a);
    }
    const last = this.lastSms.get(from);
    // The approval texted last may belong to a deal that has since closed (approved on the card and paid).
    if (last?.approvalId && !texted.some((a) => a.id === last.approvalId)) {
      const a = await this.repo.getApproval(last.approvalId);
      if (a) texted.push(a);
    }
    const pending = texted.filter((a) => a.status === "pending");
    const code = parsed[2];
    if (code && !pending.some((a) => a.code === code)) {
      // Already decided elsewhere (the card, email) or unknown: tell the human, never forward the code.
      const decided = texted.find((a) => a.code === code);
      if (decided || pending.length === 0) {
        const job = await this.repo.getJob(decided?.job_id ?? last?.jobId ?? open.find(() => true)?.id ?? "");
        const stored = job ? await this.repo.insertMessage({
          job_id: job.id, business_id: null, approval_id: decided?.id ?? null, direction: "in", kind: "approval_reply", channel: "imessage", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
          rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 500), attachments: [], attachments_download_url: null,
          sender_trusted: true, trust_reason: "sms-from-text-approver", matched_via: "approval_code", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
        }) : null;
        if (job && !stored) return { jobId: job.id, outcome: "duplicate" };
        if (job) {
          const what = !decided ? `no approval is waiting for code ${code}, so nothing was done.`
            : `that approval was already ${decided.status === "approved" || decided.status === "used" ? "approved" : decided.status}${decided.channel === "view" ? " on the card" : ""}. Nothing else to do.`;
          await this.notifyHuman(job, `approval-ack:${m.messageId}`, what);
        }
        return { jobId: job?.id ?? null, outcome: decided ? "approval_already_decided" : "no_matching_approval" };
      }
    }
    if (pending.length === 0) return null;
    if (!parsed[2] && !(last?.approvalId && pending.some((a) => a.id === last.approvalId))) return null;
    return this.decideByText(pending, { providerId: `sms-in:${m.messageId}`, from, text: m.text, trustReason: "sms-from-text-approver" });
  }

  private async routeText(m: { messageId: string; from: string; text: string }, from: string): Promise<{ jobId: string | null; outcome: string }> {
    const open = await this.repo.listOpenJobs();
    {
      // The human even when no deal is open any more (e.g. "YES <code>" after the card approved and paid).
      let isHuman = (!!this.d.sms && from === this.d.config.notifyPhone?.replace(/[\s().-]/g, "")) || !!this.lastSms.get(from)?.approvalId;
      for (const job of open) if (from === (await this.notifyTarget(job))) isHuman = true;
      if (isHuman) {
        const decided = await this.ingestTextApproval(m, from, open);
        if (decided) return decided;
        // "RESUME" (asked for when routine updates paused) is not an answer to a business.
        if (/^\s*(resume|updates?|start)\s*[.!]*\s*$/i.test(m.text)) return { jobId: this.lastSms.get(from)?.jobId ?? null, outcome: "texts_resumed" };
      }
    }
    const businesses: { job: JobRow; b: JobBusinessRow; at: number }[] = [];
    for (const job of open) {
      const texted = (await this.repo.listMessages(job.id)).filter((x) => x.direction === "out" && x.to_address === from && x.provider_email_id?.startsWith("sms:"));
      for (const x of texted) {
        const b = (await this.repo.getBusinesses(job.id)).find((y) => y.business_id === x.business_id);
        if (b) businesses.push({ job, b, at: Date.parse(x.created_at) });
      }
    }
    let human = false;
    for (const job of open) if (from === (await this.notifyTarget(job))) human = true;
    // The same number can be both (a teammate playing a business): the last text to it decides.
    const last = this.lastSms.get(from);
    if (businesses.length > 0 && (!human || last?.kind !== "human")) {
      const { job, b } = businesses.sort((x, y) => y.at - x.at)[0]!;
      const stored = await this.repo.insertMessage({
        job_id: job.id, business_id: b.business_id, approval_id: null, direction: "in", kind: "reply", channel: b.channel === "imessage" ? "imessage" : "phone", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
        rfc_message_id: null, thread_id: null, from_address: from, to_address: job.inbox, subject: null, body_text: m.text.slice(0, 5000) || null, attachments: [], attachments_download_url: null,
        // A reply to the follow-up Haggle texted to this business's pinned number.
        sender_trusted: true, trust_reason: "sms-reply-to-pinned-number", matched_via: "sms_number", parse_status: m.text.trim() ? "pending" : "none", quarantine_reason: null,
        round: null, simulated: false,
      });
      if (!stored) return { jobId: job.id, outcome: "duplicate" };
      await this.repo.updateBusiness(job.id, b.business_id, { last_reply_at: this.now().toISOString(), ...(b.status === "contacted" || b.status === "question" || b.status === "silent" || b.status === "replied" ? { status: "replied" as const } : {}) });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Text from ${b.name}`, channel: b.channel === "imessage" ? "imessage" : "phone", ...snippet(messageSnippet(m.text)) });
      await this.repo.touchJob(job.id);
      return { jobId: job.id, outcome: "stored" };
    }
    if (!human) return { jobId: null, outcome: "unknown_sender" };
    // The human: answer the question Haggle texted them about, else the newest open one.
    const pending: QuestionRow[] = [];
    for (const job of open) if (from === (await this.notifyTarget(job))) pending.push(...(await this.repo.listQuestions(job.id)).filter((q) => q.status === "pending"));
    let answer = m.text;
    let named: QuestionRow | undefined;
    const instruction = m.text.match(/^\s*(?:please\s+)?(?:answer|tell|reply(?:\s+to)?|respond(?:\s+to)?|for)\s+(.+)$/is);
    if (instruction) {
      for (const q of pending) {
        const b = (await this.repo.getBusinesses(q.job_id)).find((x) => x.business_id === q.business_id);
        if (!b || !instruction[1]!.toLowerCase().startsWith(b.name.toLowerCase())) continue;
        named = q;
        answer = instruction[1]!.slice(b.name.length).replace(/^\s*(?:with|that|saying|[:,\-–])\s*/i, "").trim() || m.text;
        break;
      }
    }
    const target = named ?? pending.find((q) => q.id === last?.questionId) ?? pending.sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0];
    const jobId = target?.job_id ?? last?.jobId ?? null;
    const stored = jobId ? await this.repo.insertMessage({
      job_id: jobId, business_id: null, approval_id: null, direction: "in", kind: "answer", channel: "phone", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 2000) || null, attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: "sms-from-notify-number", matched_via: "sms_number", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
    }) : null;
    if (jobId && !stored) return { jobId, outcome: "duplicate" };
    if (!target) return { jobId, outcome: "no_open_question" };
    await this.answerSeller(target.job_id, target.id, answer);
    return { jobId: target.job_id, outcome: "answered" };
  }

  /**
   * A text from a business on the iMessage channel (not the approver): matched by its pinned
   * number to the most recent open job that texted it, stored and parsed like an email body.
   * Trusted: iMessage sender handles are carrier/Apple-registered and Inkbox delivers them on the
   * buyer identity's own connection (not caller ID). Idempotent per message id.
   */
  private async ingestBusinessIMessage(m: { messageId: string; from: string; text: string }): Promise<{ jobId: string | null; outcome: string }> {
    const hits: { job: JobRow; b: JobBusinessRow }[] = [];
    for (const job of await this.repo.listOpenJobs()) for (const b of await this.repo.getBusinesses(job.id)) if (b.channel === "imessage" && b.phone === m.from && b.contacted_at) hits.push({ job, b });
    if (!hits.length) return { jobId: null, outcome: "unknown_sender" };
    const { job, b } = hits.sort((x, y) => Date.parse(y.b.contacted_at!) - Date.parse(x.b.contacted_at!))[0]!;
    const stored = await this.repo.insertMessage({
      job_id: job.id, business_id: b.business_id, approval_id: null, direction: "in", kind: "reply", channel: "imessage", provider_email_id: `imsg-in:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: m.from, to_address: job.inbox, subject: null, body_text: m.text.slice(0, 5000) || null, attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: "imessage-from-pinned-number", matched_via: "imessage_number", parse_status: m.text.trim() ? "pending" : "none", quarantine_reason: null,
      round: null, simulated: false,
    });
    if (!stored) return { jobId: job.id, outcome: "duplicate" };
    await this.repo.updateBusiness(job.id, b.business_id, { last_reply_at: this.now().toISOString(), ...(b.status === "contacted" || b.status === "question" ? { status: "replied" as const } : {}) });
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Text from ${b.name}`, channel: "imessage", ...snippet(messageSnippet(m.text)) });
    await this.repo.touchJob(job.id);
    return { jobId: job.id, outcome: "stored" };
  }

  /** The best eligible competing quote on this job (another business), for honest negotiation. */
  private async bestCompetingQuote(job: JobRow, excludeBusinessId: string): Promise<{ total_cents: number; id: string } | null> {
    const { ranking, quotes } = await this.rankRows(job);
    const best = ranking.ranked.find((r) => r.businessId !== excludeBusinessId);
    const q = best ? quotes.find((x) => x.id === best.quoteId) : undefined;
    return q?.total_cents ? { total_cents: q.total_cents, id: q.id } : null;
  }

  /**
   * Scheduled RFQ calls (callDelayMs) and email -> call escalation (escalateEmailToCallAfterMs):
   * each places at most one call per business (idempotency key), only to the pinned number.
   */
  private async dueCalls(job: JobRow) {
    if (!this.d.phone || TERMINAL.has(job.state)) return;
    const now = this.now().getTime();
    const created = Date.parse(job.created_at);
    const esc = this.d.config.escalateEmailToCallAfterMs;
    for (const b of await this.repo.getBusinesses(job.id)) {
      if (!b.phone || (await this.repo.findMessageByIdempotencyKey(`call:${job.id}:${b.business_id}`))) continue;
      if (b.next_attempt_at && Date.parse(b.next_attempt_at) > now) continue; // deferred (call hours, cooldown, retry)
      if (b.channel === "phone" && b.status === "contacted" && now >= created + (this.d.config.callDelayMs ?? 0)) await this.placeRfqCall(job, b);
      else if (esc !== undefined && b.channel === "email" && ((b.status === "contacted" && b.contacted_at && now >= Date.parse(b.contacted_at) + esc) || b.status === "bounced")) await this.placeRfqCall(job, b, { escalation: true });
    }
  }

  /**
   * The Voice AI's instructions for one quote call: short numbered steps, AI disclosure first, the
   * date as people say it, only real competing figures, no commitments. Under Inkbox's 2,000 chars.
   */
  static callBrief(name: string, job: Pick<JobRow, "request" | "short_code">, reqs: string[], opts: { escalation?: boolean; competingTotalUsd?: number; customer?: string } = {}): string {
    const r = job.request;
    const d = new Date(`${r.date}T12:00:00Z`);
    const when = Number.isNaN(d.getTime()) ? r.date : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
    const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const customer = opts.customer ?? customerOf(r);
    return [
      `You are an AI assistant phoning ${name} on behalf of ${customer} to get a price quote. You have no name or company of your own: introduce yourself only as their AI assistant. Be brief, warm and natural; keep the call under three minutes.`,
      `1. Open with: "Hi, I'm an AI assistant calling on behalf of ${customer} about a quote for ${r.what}. Do you have a minute?"${opts.escalation ? " Mention we emailed earlier and wanted to follow up by phone." : ""}`,
      `2. The order: ${r.what} for ${r.quantity} ${r.unit ?? "people"} on ${when}${r.area ? `, in ${r.area}` : ""}.${reqs.length ? ` Must have: ${reqs.join("; ")}.` : ""}`,
      `3. Ask for: the all-in total including delivery and tax, how each requirement is met (for example how many vegetarian meals), any deposit and when it is due, and what is included.`,
      opts.competingTotalUsd !== undefined ? `4. We have a real quote of ${money(opts.competingTotalUsd)} total for the same order. You may say that figure and ask if they can do better. Never invent, round down or exaggerate it.` : `4. Do not mention other businesses or prices.`,
      `5. If they give parts (a price per person, a delivery fee, tax as a percent), work out the all-in total yourself. Before ending, read back every figure they gave plus that total, in the form "Just to confirm: [price] per person for [count], [fee] delivery, [rate] tax, so [total] all in, with a [deposit] deposit. Is that right?" (their numbers only, never these placeholders). Wait for their yes or correction, then thank them and end the call.`,
      `If they ask something you don't know, say you'll pass it on to the customer; never guess. If they can't do it or decline, thank them and end politely. If you reach voicemail, leave one sentence asking for a quote by email and hang up.`,
      `Never agree to buy, book or pay, and never share payment details. Reference HG-${job.short_code}.`,
    ].join("\n").slice(0, 2000);
  }

  /**
   * The Voice AI brief for a call after first contact (a follow-up, an answer, a counteroffer, a
   * message, a confirmation) (≤ 2,000 chars): AI disclosure on behalf of the customer, what to say
   * or ask, and the safety rules. A counter cites only the real competing total it is given.
   */
  private taskBrief(job: JobRow, b: JobBusinessRow, purpose: "rfq" | "escalation" | "message" | "followup" | "confirmation" | "answer" | "counter", extra?: string, counter?: { theirCents: number; targetCents: number }): string {
    const r = job.request;
    const customer = this.customer(job);
    const reqs = r.requirements.filter((x) => x.hard).map((x) => x.text);
    const what = [r.what, quantityText(r.quantity, r.unit), r.date ? `on ${r.date}` : null, `in ${r.area}`].filter(Boolean).join(", ");
    const find = r.ask?.length ? r.ask.map((f) => f.label).join("; ") : "the all-in total, any deposit, and what is included";
    const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const rules = `Do not agree to buy or pay anything, and do not share payment details. Never name other businesses${counter ? "; the only other price you may mention is the one above" : " or their prices"}. Reference code HG-${job.short_code}.`;
    const opener = `Open with: "Hi, I'm an AI assistant calling on behalf of ${customer}", then say why you're calling. You have no name or company of your own. If a call screener or voicemail answers, say who you are and why you're calling in one sentence.`;
    const body = purpose === "message" ? `Pass on this message to ${b.name} about their quote for ${what}: "${extra ?? ""}". Note their answer.`
      : purpose === "followup" ? `${b.name} already quoted for ${what}. Ask only for: ${extra ?? find}. Read back any figures they give and confirm them.`
      : purpose === "answer" ? `${b.name} asked a question about their quote for ${what}. Give them the customer's answer: "${extra ?? ""}". Then ask for their full quote: ${find}. Read back any figures they give and confirm them.`
      : purpose === "counter" && counter ? `${b.name} quoted ${money(counter.theirCents)} total for ${what}. Thank them, then say we've received another quote of ${money(counter.targetCents)} total for the same order and ask whether they can match or beat it. That is a real quote: say exactly that figure. Never invent, round down or exaggerate it, and never say who quoted it. If they can do better, get their updated all-in total and deposit and read them back to confirm. If not, thank them and end politely.`
      : purpose === "confirmation" ? `Tell ${b.name} the customer would like to go ahead with their quote for ${what}. ${extra ?? ""} Ask them to confirm.`
      : `Ask ${b.name} for a quote for: ${what}.${purpose === "escalation" ? " We emailed them earlier and didn't hear back." : ""} ${reqs.length ? `Requirements: ${reqs.join("; ")}. ` : ""}${(r.details ?? []).map((d) => `${d.label}: ${d.value}.`).join(" ")} Find out: ${find}.`;
    return [`You are an AI assistant calling ${b.name} on behalf of ${customer}${purpose === "rfq" || purpose === "escalation" ? " to request a price quote" : ""}.`, opener, body, rules].join(" ").replace(/\s+/g, " ").trim().slice(0, 2000);
  }

  /**
   * When a call to this number may be placed: never during another call to it, not within the
   * cooldown after the last one (either direction), and only inside call hours in the workspace's
   * timezone. Returns null when it may be placed now, else when to try again.
   */
  private async callBlockedUntil(job: JobRow, phone: string): Promise<Date | null> {
    const now = this.now();
    const cooldown = this.d.config.callCooldownMs ?? DEFAULT_CALL_COOLDOWN_MS;
    // cooldown 0 (the simulated fleet in mock mode): no one real is being rung, so no spacing.
    if (cooldown > 0) {
      const recent = await this.repo.listPhoneMessages(phone, new Date(now.getTime() - CALL_IN_PROGRESS_MS).toISOString());
      const ended = new Set(recent.filter((m) => m.direction === "in" && m.provider_email_id?.startsWith("call-ended:")).map((m) => m.provider_email_id!.slice("call-ended:".length)));
      const inProgress = recent.some((m) => isPlacedCall(m) && !ended.has(m.provider_email_id!));
      if (inProgress) return new Date(now.getTime() + cooldown);
      const last = Math.max(0, ...recent.map((m) => Date.parse(m.created_at)));
      if (last && now.getTime() - last < cooldown) return new Date(last + cooldown);
    }
    const hours = this.d.config.callHours;
    if (hours) {
      const tz = (await this.repo.getWorkspace(job.workspace_id))?.timezone ?? "America/Los_Angeles";
      if (!isWithinCallHours(now, tz, hours)) return nextCallHoursStart(now, tz, hours);
    }
    return null;
  }

  /**
   * A Voice AI quote call: the first contact for a phone business, or the email -> call escalation.
   * One call per business (idempotency key), only to the pinned number. Outside call hours, during
   * another call to the number or within the cooldown it is deferred (next_attempt_at) and placed
   * by a later advance (dueCalls).
   */
  private async placeRfqCall(job: JobRow, b: JobBusinessRow, opts: { escalation?: boolean } = {}) {
    const key = `call:${job.id}:${b.business_id}`;
    if (!this.d.phone || !b.phone) {
      if (!opts.escalation) await this.repo.updateBusiness(job.id, b.business_id, { status: "unavailable" });
      return;
    }
    if (await this.repo.findMessageByIdempotencyKey(key)) return;
    const blocked = await this.callBlockedUntil(job, b.phone);
    if (blocked) {
      if (b.next_attempt_at !== blocked.toISOString()) {
        // A phone business waits as "contacted" so dueCalls places the call once it may go out.
        await this.repo.updateBusiness(job.id, b.business_id, { next_attempt_at: blocked.toISOString(), ...(b.status === "pending" ? { status: "contacted" as const } : {}) });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call to ${b.name} scheduled for ${blocked.toISOString()} (call hours or a recent call)`, channel: "phone" });
      }
      return;
    }
    const reqs = job.request.requirements.filter((r) => r.hard).map((r) => r.text);
    const competing = await this.bestCompetingQuote(job, b.business_id);
    const reason = HaggleEngine.callBrief(b.name, job, reqs, { escalation: opts.escalation, competingTotalUsd: competing ? centsToUsd(competing.total_cents) : undefined, customer: this.customer(job) });
    try {
      const { callId } = await this.d.phone.placeCall({ jobId: job.id, businessId: b.business_id, toNumber: b.phone, reason, idempotencyKey: key });
      await this.repo.insertMessage({
        job_id: job.id, business_id: b.business_id, approval_id: null, direction: "out", kind: "call", channel: "phone", provider_email_id: callId, idempotency_key: key,
        rfc_message_id: null, thread_id: null, from_address: job.inbox, to_address: b.phone, subject: null, body_text: reason, attachments: [], attachments_download_url: null,
        sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: 1, simulated: job.mode === "mock",
      });
      await this.repo.updateBusiness(job.id, b.business_id, { status: "ringing", next_attempt_at: null, ...(opts.escalation ? { escalated_at: this.now().toISOString() } : { contacted_at: this.now().toISOString() }) });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Calling ${b.name} (Voice AI${opts.escalation ? ", email unanswered" : ""}${competing ? `, citing a real $${centsToUsd(competing.total_cents).toFixed(0)} quote` : ""})`, channel: "phone" });
    } catch (err) {
      const f = err instanceof ChannelSendError ? err : null;
      if (f?.retryable && b.send_attempts + 1 < MAX_SEND_ATTEMPTS) {
        await this.repo.updateBusiness(job.id, b.business_id, { send_attempts: b.send_attempts + 1, next_attempt_at: new Date(this.now().getTime() + Math.max(f.retryAfterMs, 1_000)).toISOString() });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call to ${b.name} delayed (${f.reason.replace(/_/g, " ")}); retrying` });
        return;
      }
      await this.repo.updateBusiness(job.id, b.business_id, opts.escalation ? { escalated_at: this.now().toISOString(), next_attempt_at: null } : { status: "bounced", next_attempt_at: null });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call to ${b.name} failed: ${f?.reason.replace(/_/g, " ") ?? (err as Error).name}` });
      this.log("call_failed", { job_id: job.id, business_id: b.business_id, escalation: opts.escalation === true, error: (err as Error).message });
    }
  }

  /** Sends whose retry time has come (rate limits, provider outages): same channel, same idempotency key. */
  private async runDueContacts(job: JobRow) {
    if (!["contacting", "collecting", "negotiating"].includes(job.state)) return;
    const now = this.now().getTime();
    for (const b of await this.repo.getBusinesses(job.id)) {
      if (b.status === "pending" && b.next_attempt_at && Date.parse(b.next_attempt_at) <= now) await this.contactBusiness(job, b);
    }
  }

  /**
   * One call-ended result (Inkbox `call.ended`, or the simulated fleet). Matched by the call id we
   * recorded when placing the call, so only calls Haggle placed to the pinned number count. The
   * transcript is untrusted data, parsed like an email body. Idempotent per call id.
   */
  async ingestCall(call: { callId: string; outcome: "completed" | "no_answer" | "declined" | "failed"; transcript: string; endedAt?: string; simulated?: boolean; direction?: "outbound" | "inbound"; remoteNumber?: string }): Promise<{ jobId: string | null; outcome: string }> {
    const placed = await this.repo.findMessageByProviderId(call.callId);
    if (!placed && call.direction === "inbound" && call.remoteNumber) return this.ingestInboundCall({ ...call, remoteNumber: call.remoteNumber });
    // Any call we placed counts: the quote call, and the follow-up, answer, counter or message calls after it.
    if (!placed || !isPlacedCall(placed) || !placed.job_id || !placed.business_id) return { jobId: null, outcome: "unknown_call" };
    const job = await this.repo.getJob(placed.job_id);
    const b = (await this.repo.getBusinesses(placed.job_id)).find((x) => x.business_id === placed.business_id);
    if (!job || !b) return { jobId: null, outcome: "unknown_call" };
    const transcript = call.transcript.trim().slice(0, 20_000);
    // A screener, voicemail greeting or phone menu "completes" a call without anyone answering:
    // that's "reached, no answer", never an empty quote (and never an instant follow-up call).
    const reached = call.outcome === "completed" && transcript.length > 0;
    const completed = reached && answeredSomething(transcript);
    const stored = await this.repo.insertMessage({
      job_id: job.id, business_id: b.business_id, approval_id: null, direction: "in", kind: "reply", channel: "phone", provider_email_id: `call-ended:${call.callId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: b.phone, to_address: job.inbox, subject: null, body_text: transcript || null, attachments: [], attachments_download_url: null,
      // Trusted: Haggle placed this call to the business's pinned number (not caller ID on an inbound call).
      sender_trusted: true, trust_reason: "outbound-call-to-pinned-number", matched_via: "call_id", parse_status: completed ? "pending" : "none", quarantine_reason: null,
      round: null, simulated: call.simulated ?? false,
    });
    if (!stored) return { jobId: job.id, outcome: "duplicate" };
    if (TERMINAL.has(job.state)) return { jobId: job.id, outcome: "job_closed" };
    // Conditional: a concurrent parse of this transcript may already have set "quoted", and a business
    // that already quoted keeps its status when a later call (message, follow-up) goes unanswered.
    await this.repo.updateBusiness(job.id, b.business_id, completed ? { status: "replied", last_reply_at: this.now().toISOString() } : { status: call.outcome === "declined" ? "declined" : "no_reply" },
      { ifStatus: completed ? ["pending", "contacted", "ringing", "question", "no_reply", "bounced"] : ["pending", "contacted", "ringing"] });
    const how = completed ? call.outcome : reached ? "reached, no answer (screener or voicemail)" : call.outcome;
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call with ${b.name} ended: ${how}`, channel: "phone", transcript_snippet: transcriptSnippet(transcript, b.name) });
    await this.repo.touchJob(job.id);
    // A completed call is texted with its quote (or its missing total) once the transcript is read.
    if (!completed) await this.notifyHuman(job, `call:${call.callId}`, `the call to ${b.name} ended: ${how.replace(/_/g, " ")}.`);
    return { jobId: job.id, outcome: completed ? "stored" : reached ? "call:no_answer" : `call:${call.outcome}` };
  }

  /**
   * A business called Haggle (it wasn't our call). Matched by caller number to exactly one pinned
   * business on an open job. Caller ID is spoofable, so the transcript is trusted only when the
   * operator opted in (config.trustInboundCallerId); otherwise it is kept for audit, never a quote.
   */
  private async ingestInboundCall(call: { callId: string; outcome: string; transcript: string; simulated?: boolean; remoteNumber: string }): Promise<{ jobId: string | null; outcome: string }> {
    const num = call.remoteNumber.replace(/[\s().-]/g, "");
    const hits: { job: JobRow; b: JobBusinessRow }[] = [];
    for (const job of await this.repo.listOpenJobs()) for (const b of await this.repo.getBusinesses(job.id)) if (b.phone === num) hits.push({ job, b });
    if (hits.length !== 1) return { jobId: null, outcome: hits.length ? "ambiguous_caller" : "unknown_caller" };
    const { job, b } = hits[0]!;
    const trusted = this.d.config.trustInboundCallerId === true;
    const transcript = call.transcript.trim().slice(0, 20_000);
    const stored = await this.repo.insertMessage({
      job_id: job.id, business_id: b.business_id, approval_id: null, direction: "in", kind: "reply", channel: "phone", provider_email_id: `call-ended:${call.callId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: num, to_address: job.inbox, subject: null, body_text: transcript || null, attachments: [], attachments_download_url: null,
      sender_trusted: trusted, trust_reason: trusted ? "inbound-caller-id-match (operator opt-in)" : "inbound-caller-id-unverified", matched_via: "caller_number",
      parse_status: call.outcome === "completed" && transcript ? "pending" : "none", quarantine_reason: null, round: null, simulated: call.simulated ?? false,
    });
    if (!stored) return { jobId: job.id, outcome: "duplicate" };
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${b.name} called Haggle${trusted ? "" : " (caller ID not verified)"}`, channel: "phone", transcript_snippet: transcriptSnippet(transcript, b.name) });
    await this.repo.touchJob(job.id);
    return { jobId: job.id, outcome: trusted ? "stored" : "stored_unverified" };
  }



  private async sendCounteroffers(job: JobRow, round: number, businessIds?: string[]) {
    await this.refreshRounds(job);
    const { rankable } = await this.rankRows(job);
    const businesses = await this.repo.getBusinesses(job.id);
    const byId = new Map(businesses.map((b) => [b.business_id, b]));
    // A manual round (negotiate tool) may target some businesses and go one round past max_rounds.
    const manual = businessIds?.length || round > job.max_rounds ? { businessIds } : undefined;
    const plan = this.counterPlan(job, rankable, businesses, manual);
    let sent = 0;
    for (const c of plan) {
      const b = byId.get(c.businessId);
      if (!b) continue;
      const counter = { haggle: "counter/1", protocol: "haggle.v0", type: "counter", job_id: job.id, round: c.round, target_total_usd: centsToUsd(c.targetTotalCents), basis: "competing_quote", basis_quote_total_usd: centsToUsd(c.targetTotalCents), respond_by: job.collect_until };
      if (b.channel === "imessage") {
        const key = sendKeys.counter(job.id, b.business_id, c.round);
        if (await this.repo.findMessageByIdempotencyKey(key)) continue;
        try {
          await this.sendIMessageToBusiness(job, b, "counter", key, `Thanks! We have another quote of $${centsToUsd(c.targetTotalCents).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} total for the same order. Can you match or beat it? Ref HG-${job.short_code}`, c.round);
          await this.repo.updateBusiness(job.id, b.business_id, { countered_round: c.round });
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer to ${b.name} by text: match ${centsToUsd(c.targetTotalCents)} (real quote ${c.basisQuoteId})`, basis_quote_id: c.basisQuoteId });
          await this.repo.appendEvent(job.id, "counteroffer", { business_id: b.business_id, round: c.round, target_total_usd: centsToUsd(c.targetTotalCents), basis_quote_id: c.basisQuoteId });
          sent++;
        } catch (err) {
          this.log("counter_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
        }
        continue;
      }
      if (b.channel === "a2a") {
        const key = sendKeys.counter(job.id, b.business_id, c.round);
        if (await this.repo.findMessageByIdempotencyKey(key)) continue;
        try {
          // A new task in the same A2A context (the seller keeps its conversation state per context).
          const t = await this.d.a2a!.send({ cardUrl: b.a2a_card_url!, text: c.text, data: counter, messageId: `haggle-${key.replace(/:/g, "-")}`, contextId: b.thread_id! });
          await this.recordA2aOutbound(job, b, "counter", key, t.taskId, c.text, c.round);
          await this.repo.updateBusiness(job.id, b.business_id, { countered_round: c.round });
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer to ${b.name} over A2A: match ${counter.target_total_usd} (real quote ${c.basisQuoteId})`, basis_quote_id: c.basisQuoteId });
          await this.repo.appendEvent(job.id, "counteroffer", { business_id: b.business_id, round: c.round, target_total_usd: counter.target_total_usd, basis_quote_id: c.basisQuoteId });
          sent++;
        } catch (err) {
          this.log("counter_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
        }
        continue;
      }
      if (b.channel === "phone") {
        // A phone business stays on the phone: a short follow-up call citing only the real competing
        // total (same fixed figures as the email). Its answer is read from the transcript like any
        // call, and an amount only our voice agent said is never taken as the business's price.
        const key = sendKeys.counter(job.id, b.business_id, c.round);
        if (await this.repo.findMessageByIdempotencyKey(key)) continue;
        try {
          const r = await this.callBusiness(job, b, {
            key, kind: "counter", round: c.round, body: `Counteroffer call: we have another quote of ${usdText(c.targetTotalCents)} total; can you match or beat it?`,
            reason: this.taskBrief(job, b, "counter", undefined, { theirCents: c.theirTotalCents, targetCents: c.targetTotalCents }),
          });
          if (!r.placed && !r.scheduledFor) continue;
          await this.repo.updateBusiness(job.id, b.business_id, { countered_round: c.round });
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer to ${b.name} by call${r.placed ? "" : " (scheduled)"}: match ${counter.target_total_usd} (real quote ${c.basisQuoteId})`, basis_quote_id: c.basisQuoteId, channel: "phone" });
          await this.repo.appendEvent(job.id, "counteroffer", { business_id: b.business_id, round: c.round, target_total_usd: counter.target_total_usd, basis_quote_id: c.basisQuoteId });
          sent++;
        } catch (err) {
          this.log("counter_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
        }
        continue;
      }
      try {
        await this.sendRecorded(job, b, "counter", sendKeys.counter(job.id, b.business_id, c.round), {
          to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, bodyText: `${c.text}\nAI assistant for ${this.customer(job)}`, attachments: [jsonPart("counter.json", counter)], inThread: true, round: c.round,
        });
        await this.repo.updateBusiness(job.id, b.business_id, { countered_round: c.round });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer to ${b.name}: match ${counter.target_total_usd} (real quote ${c.basisQuoteId})`, basis_quote_id: c.basisQuoteId });
        await this.repo.appendEvent(job.id, "counteroffer", { business_id: b.business_id, round: c.round, target_total_usd: counter.target_total_usd, basis_quote_id: c.basisQuoteId });
        sent++;
      } catch (err) {
        this.log("counter_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
      }
    }
    await this.repo.appendEvent(job.id, "counteroffers_sent", { round, sent, planned: plan.length });
  }

  private async sendAccept(job: JobRow) {
    const approval = await this.repo.getLatestApproval(job.id);
    if (!approval || approval.status !== "approved") return;
    // Stripe rail: nothing is sent to the business and nothing is charged until the agent calls pay().
    if (this.d.stripe) return;
    const quote = await this.repo.getQuote(approval.quote_id);
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === approval.business_id);
    if (!quote || !b) return;
    await this.repo.insertPayment({
      id: newId("pay"), job_id: job.id, approval_id: approval.id, business_id: b.business_id, status: "awaiting_invoice", rail: "x402", idempotency_key: null, stripe_payment_intent_id: null,
      amount_cents: approval.payment_cents, amount_base_units: centsToUsdcBaseUnits(approval.payment_cents), network: "base-sepolia",
      challenge_json: null, challenge_step_id: null, challenge_message_id: null, challenge_trusted: false, challenge_thread_matched: false,
      pay_to: null, interaction_json: null, settle_tx: null, simulated: this.d.payer.simulated, reason: this.d.payer.disabledReason ?? null,
      ...(this.d.payer.disabledReason ? { status: "failed" as const } : {}),
    });
    if (this.d.payer.disabledReason) {
      // No payment rail: never ask the seller for an invoice we can't pay.
      await this.repo.appendEvent(job.id, "payment", { status: "failed", reason: this.d.payer.disabledReason });
      return;
    }
    const accept = { haggle: "accept/1", job_id: job.id, quote_total_usd: centsToUsd(approval.quote_total_cents), deposit_usd: centsToUsd(approval.payment_cents), network: "base-sepolia", payer: job.inbox, conditional: true };
    const text = [
      `Hi ${b.name},`, "",
      `We'd like to go ahead with your quote of $${centsToUsd(approval.quote_total_cents).toFixed(2)} total, conditional on the deposit settling.`,
      `Please send an x402 payment request for the $${centsToUsd(approval.payment_cents).toFixed(2)} deposit (USDC on base-sepolia) in this thread.`, "", "Thank you!",
    ].join("\n");
    await this.sendRecorded(job, b, "accept", sendKeys.accept(approval.id), { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, bodyText: text, attachments: [jsonPart("accept.json", accept)], inThread: true });
    await this.repo.appendEvent(job.id, "payment", { status: "awaiting_invoice" });
  }

  /**
   * After a confirm-only approval, or once the approved payment settles: tell the winning business
   * (go ahead with your quote; payment sent, with the reference) on its own channel, and send the
   * approver a receipt by email when one is set. Each is sent once (idempotency keys).
   */
  private async sendConfirmation(job: JobRow) {
    const a = await this.repo.getLatestApproval(job.id);
    if (!a || !["approved", "used"].includes(a.status)) return;
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === a.business_id);
    if (!b) return;
    const pay = await this.repo.getPaymentForJob(job.id);
    const paid = pay && pay.approval_id === a.id && pay.status === "settled" ? pay : null;
    const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const ref = paid?.stripe_payment_intent_id ?? paid?.settle_tx ?? null;
    const payLine = paid ? `A payment of ${money(paid.amount_cents)} has been sent${paid.rail === "stripe" ? " (Stripe test mode)" : ""}${ref ? `, reference ${ref}` : ""}.` : "";
    const confirm = a.action !== "pay";
    const what = [job.request.what, quantityText(job.request.quantity, job.request.unit), job.request.date ? `on ${job.request.date}` : null].filter(Boolean).join(", ");
    const text = [
      `Hi ${b.name},`, "",
      ...(confirm ? [`We'd like to go ahead with your quote${a.quote_total_cents ? ` of ${money(a.quote_total_cents)} total` : ""} for ${what}.`] : []),
      ...(payLine ? [payLine] : []),
      ...(confirm ? ["Please reply to confirm the booking."] : []),
      "", this.signOff(job),
    ].join("\n");
    const key = `confirm:${a.id}`;
    try {
      if (b.channel === "a2a" && this.d.a2a && b.a2a_card_url && b.thread_id) {
        if (!(await this.repo.findMessageByIdempotencyKey(key))) {
          const t = await this.d.a2a.send({ cardUrl: b.a2a_card_url, text, data: { haggle: "confirm/1", protocol: "haggle.v0", type: "confirmation", job_id: job.id, quote_total_usd: centsToUsd(a.quote_total_cents), ...(paid ? { paid_usd: centsToUsd(paid.amount_cents), payment_reference: ref } : {}) }, messageId: `haggle-${key.replace(/:/g, "-")}`, contextId: b.thread_id });
          await this.recordA2aOutbound(job, b, "confirmation", key, t.taskId, text, job.round);
        }
      } else if (b.channel === "email" && b.email) {
        await this.sendRecorded(job, b, "confirmation", key, { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, bodyText: text, inThread: true });
      } else if (b.channel === "imessage" && this.canReach(b)) {
        // A text business is confirmed by text (never switched to email).
        const sms = [confirm ? `Hi ${b.name}, the customer would like to go ahead with your quote${a.quote_total_cents ? ` of ${money(a.quote_total_cents)} total` : ""} for ${what}.` : `Hi ${b.name},`, payLine, confirm ? "Please reply to confirm." : "", `Ref HG-${job.short_code}`].filter(Boolean).join(" ");
        if (!(await this.sendIMessageToBusiness(job, b, "confirmation", key, sms, null))) throw new Error("text not sent");
      } else if (b.channel === "phone" && b.phone && this.d.phone) {
        // A phone business is confirmed by a short call, placed now (the job is closing), as before.
        await this.callBusiness(job, b, { key, kind: "call", reason: this.taskBrief(job, b, "confirmation", payLine), body: text, approvalId: a.id, now: true });
      } else {
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Couldn't send the confirmation to ${b.name}: no reachable channel` });
        return;
      }
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${confirm ? "Confirmation" : "Payment notice"} sent to ${b.name}` });
    } catch (err) {
      this.log("confirmation_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
    }
    const approver = (await this.getSettings(job.workspace_id)).approver_email ?? job.approver_email;
    if (!approver) return;
    try {
      await this.sendRecorded(job, null, "receipt", `receipt:${a.id}:person`, {
        to: approver, subject: `[HG-${job.short_code}] Done: ${confirm ? "confirmed" : "paid"} ${b.name}`,
        bodyText: [`Your agent finished this deal.`, "", `- Business: ${b.name}`, `- Quote total: ${money(a.quote_total_cents)}`, ...(paid ? [`- Paid: ${money(paid.amount_cents)}${ref ? ` (reference ${ref})` : ""}`] : []), `- Action: ${a.action.replace(/_/g, " ")}`].join("\n"),
        approvalId: a.id,
      });
    } catch (err) {
      this.log("receipt_failed", { job_id: job.id, error: (err as Error).message });
    }
  }

  private async notifyCancelled(job: JobRow) {
    const pending = await this.repo.getLatestApproval(job.id);
    if (pending?.status === "pending") await this.repo.transitionApproval(pending.id, "pending", { status: "expired", decided_at: this.now().toISOString() });
    // A short note on the business's own channel to businesses that replied: in the email thread, or
    // by text. Nobody is phoned just to hear a request was cancelled.
    for (const b of await this.repo.getBusinesses(job.id)) {
      if (!["replied", "quoted", "question", "declined"].includes(b.status)) continue;
      try {
        if (b.channel === "email" && b.last_inbound_message_id) {
          await this.sendRecorded(job, b, "cancel", sendKeys.cancel(job.id, b.business_id), {
            to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true,
            bodyText: `Hi ${b.name},\n\nThank you for your quote. The customer has cancelled this request, so we won't be moving forward. Thanks for your time.\n\n${this.signOff(job)}`,
          });
        } else if (b.channel === "imessage" && b.last_reply_at && this.canReach(b)) {
          await this.sendIMessageToBusiness(job, b, "cancel", sendKeys.cancel(job.id, b.business_id), `Thanks for your quote. The customer has cancelled this request, so we won't be moving forward. Ref HG-${job.short_code}`, null);
        }
      } catch (err) {
        this.log("cancel_note_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
      }
    }
  }

  // ───────────────────────────── inbound ─────────────────────────────

  /**
   * One idempotent entry point for webhook, long-poll and simulated mail. `trustFor(address)`
   * answers "is this email really from <address>?" (senderTrust on the signed event, or the
   * simulated verdict in mock mode). Returns the job to advance, if any.
   */
  async ingest(msg: InboundMessage, trustFor: (expected: string) => TrustVerdict, opts: { simulated?: boolean; inlineAttachments?: { filename: string; contentType: string; data: Uint8Array }[] } = {}): Promise<{ jobId: string | null; outcome: string }> {
    const codes = [...new Set([...msg.to.map((a) => jobInboxCode(a, this.d.config.inboxDomain)), subjectShortCode(msg.subject)].filter((c): c is string => c !== null))];
    const messageIds = [...msg.inReplyTo, ...msg.references];
    const lookup = { shortCodes: codes, threadId: msg.threadId, messageIds };
    const [bizRows, apprRows] = await Promise.all([this.repo.findBusinessCandidates(lookup), this.repo.listPendingApprovalCandidates(lookup)]);
    const match = matchInbound(
      { to: msg.to, threadId: msg.threadId, inReplyTo: msg.inReplyTo, references: msg.references, subject: msg.subject, from: msg.from ?? "" },
      bizRows.filter((b) => b.email).map((b) => ({ businessId: b.business_id, jobId: b.job_id, shortCode: b.short_code, email: b.email!, threadId: b.thread_id, outboundMessageId: b.rfq_message_id })),
      apprRows.map((a) => ({ approvalId: a.id, jobId: a.job_id, shortCode: a.short_code, approverEmail: a.approver_email, threadId: a.thread_id, outboundMessageId: a.outbound_message_id })),
      this.d.config.inboxDomain,
    );
    const attachments = [
      ...msg.attachments.map((a) => ({ filename: a.filename, content_type: a.contentType, size_bytes: a.sizeBytes, tar_path: a.tarPath })),
      ...(opts.inlineAttachments ?? []).map((a) => ({ filename: a.filename, content_type: a.contentType, size_bytes: a.data.byteLength, tar_path: null, content_base64: Buffer.from(a.data).toString("base64") })),
    ];
    const base = {
      approval_id: null, direction: "in" as const, provider_email_id: msg.providerEmailId, idempotency_key: null, rfc_message_id: msg.messageId,
      thread_id: msg.threadId, from_address: msg.from, to_address: msg.to[0] ?? null, subject: msg.subject, body_text: msg.bodyText, attachments,
      attachments_download_url: msg.attachmentsDownloadUrl, round: null, simulated: opts.simulated ?? false,
    };

    if (match.kind === "unmatched" || match.kind === "quarantine" || !msg.from) {
      const reason = !msg.from ? "from_unparseable" : match.kind === "quarantine" || match.kind === "unmatched" ? match.reason : "unexpected";
      const jobId = match.kind === "quarantine" ? match.jobId : null;
      await this.repo.insertMessage({ ...base, job_id: jobId, business_id: match.kind === "quarantine" ? match.businessId : null, kind: "quarantine", sender_trusted: false, trust_reason: null, matched_via: match.kind === "quarantine" ? match.via : null, parse_status: "none", quarantine_reason: reason });
      if (jobId) await this.repo.appendEvent(jobId, "flag", { business_id: match.kind === "quarantine" ? match.businessId : "", flag: "unverified_sender", summary: "message in a business thread from another address was quarantined" });
      this.log("inbound_quarantined", { reason, job_id: jobId });
      return { jobId, outcome: `quarantined:${reason}` };
    }

    if (match.kind === "approval") {
      const approval = await this.repo.getApproval(match.approvalId);
      const job = approval ? await this.repo.getJob(approval.job_id) : null;
      if (!approval || !job?.approver_email) return { jobId: null, outcome: "approval_not_found" };
      const trust = trustFor(job.approver_email);
      if (!trust.trusted && trust.retryable) throw new RetryLater("sender authentication temporarily unavailable");
      // Inkbox can't authenticate outside mail (e.g. Gmail). With emailApprovalByCode, the reply's
      // first line carrying this approval's one-time code, from the approver's exact address, in
      // the approval's thread, stands in for sender authentication. Wrong codes count toward the lockout.
      const command = !trust.trusted && this.d.config.emailApprovalByCode && normalizeAddress(msg.from) === normalizeAddress(job.approver_email)
        ? firstReplyLine(msg.bodyText)?.match(/\b(APPROVE|NO)\b\W{0,3}(\d{4})\b/i) ?? null
        : null;
      const codeProof = command !== null && command[2] === approval.code;
      const senderTrusted = trust.trusted || codeProof;
      const stored = await this.repo.insertMessage({ ...base, job_id: job.id, business_id: null, approval_id: approval.id, kind: "approval_reply", sender_trusted: senderTrusted, trust_reason: codeProof ? "approval-code-from-approver-address" : trust.reason, matched_via: match.via, parse_status: "none", quarantine_reason: null });
      if (!stored) return { jobId: job.id, outcome: "duplicate" };
      if (!approval.thread_id && msg.threadId) await this.repo.updateApproval(approval.id, { thread_id: msg.threadId });
      if (command && !codeProof && /approve/i.test(command[1]!)) {
        const w = await this.repo.recordWrongApprovalCode(approval.id, this.d.config.maxApprovalAttempts ?? DEFAULT_MAX_APPROVAL_ATTEMPTS);
        if (w?.locked) {
          await this.repo.appendEvent(job.id, "approval_locked", { approval_id: approval.id, attempts: w.attempts });
          await this.advanceJob(job.id);
        }
        return { jobId: job.id, outcome: w?.locked ? "approval:locked" : "approval:wrong_code" };
      }
      const v = verifyApproval({ ...approval, approver_email: job.approver_email }, { from: msg.from, senderTrusted, threadMatched: true, bodyText: msg.bodyText }, this.now());
      if (v.decision === "approve" || v.decision === "decline") {
        await this.decideApproval(approval.id, v.decision, "email", job.approver_email);
      } else {
        await this.repo.appendEvent(job.id, "approval_ignored", { reason: v.reason });
      }
      return { jobId: job.id, outcome: `approval:${v.decision}` };
    }

    // A business on a job.
    const b = bizRows.find((x) => x.job_id === match.jobId && x.business_id === match.businessId)!;
    const trust = trustFor(b.email!);
    if (!trust.trusted && trust.retryable) throw new RetryLater("sender authentication temporarily unavailable");
    const stored = await this.repo.insertMessage({ ...base, job_id: b.job_id, business_id: b.business_id, kind: "reply", sender_trusted: trust.trusted, trust_reason: trust.reason, matched_via: match.via, parse_status: msg.bodyText || attachments.length ? "pending" : "failed", quarantine_reason: null });
    if (!stored) return { jobId: b.job_id, outcome: "duplicate" };
    await this.repo.updateBusiness(b.job_id, b.business_id, {
      last_reply_at: this.now().toISOString(), ...(msg.threadId ? { thread_id: msg.threadId } : {}),
      ...(msg.messageId ? { last_inbound_message_id: msg.messageId, references: [...b.references, msg.messageId].slice(-20) } : {}),
    });
    // Conditional in the store: a concurrent parse (wait_for_update, the tick) may already have set
    // "quoted" from this very message; `b` was read before the insert and must not overwrite it.
    await this.repo.updateBusiness(b.job_id, b.business_id, { status: "replied" }, { ifStatus: ["contacted", "question", "no_reply", "ringing", "bounced"] });
    await this.repo.appendEvent(b.job_id, "reply", { business_id: b.business_id, summary: `Email from ${b.name}${trust.trusted ? "" : " (sender NOT verified)"}`, ...(trust.trusted ? snippet(messageSnippet(msg.bodyText, { pricedOnly: true })) : {}) });
    await this.repo.touchJob(b.job_id);
    return { jobId: b.job_id, outcome: "stored" };
  }

  // ───────────────────────────── advance ─────────────────────────────

  private readonly advancing = new Map<string, Promise<void>>();

  /**
   * One advance per job at a time. The webhook, every wait_for_update and the backup tick all call
   * this; run concurrently, two of them parse the same reply (a slow LLM call) and store it twice:
   * duplicate questions, duplicate quotes. Callers queue behind the running advance instead.
   */
  async advanceJob(jobId: string): Promise<void> {
    const prev = this.advancing.get(jobId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.advanceJobOnce(jobId));
    this.advancing.set(jobId, run);
    try {
      await run;
    } finally {
      if (this.advancing.get(jobId) === run) this.advancing.delete(jobId);
    }
  }

  private async advanceJobOnce(jobId: string): Promise<void> {
    const first = await this.repo.getJob(jobId);
    if (!first || TERMINAL.has(first.state)) return;
    await this.pollA2a(first);
    await this.dueCalls(first);
    await this.dueScheduledCalls(first);
    await this.parsePending(first);
    await this.runDueContacts((await this.repo.getJob(jobId)) ?? first);
    await this.processPayment(jobId);
    for (let step = 0; step < 6; step++) {
      const job = await this.repo.getJob(jobId);
      if (!job || TERMINAL.has(job.state)) return;
      const event = await this.dueEvent(job);
      if (!event) return;
      const r = await this.fire(jobId, event);
      if (!r.ok) return;
    }
  }

  private async dueEvent(job: JobRow): Promise<JobEvent | null> {
    const now = this.now().getTime();
    const deadlinePassed = now > Date.parse(job.collect_until);
    const businesses = await this.repo.getBusinesses(job.id);
    if (job.state === "contacting") return businesses.every((b) => b.status !== "pending") ? { type: "rfqs_sent" } : null;
    if ((job.state === "collecting" || job.state === "negotiating") && !job.ready) {
      if (job.state === "collecting") {
        // Still waiting on: anyone contacted and silent, a call or a retry/deferred call that is due,
        // and a business that owes the answer to Haggle's follow-up (it keeps the window open).
        const owesFollowUp = await this.owingFollowUp(job);
        const waiting = businesses.filter((b) => b.status === "contacted" || b.status === "replied" || b.status === "question" || b.status === "ringing"
          || (b.status === "pending" && b.next_attempt_at !== null) || owesFollowUp.has(b.business_id));
        if (businesses.length > 0 && waiting.length === 0) return { type: "window_closed" };
      } else {
        const sent = (await this.repo.listEvents(job.id)).some((e) => e.type === "counteroffers_sent" && e.data.round === job.round);
        if (sent) {
          const quotes = (await this.repo.listQuotes(job.id)).filter((q) => q.status === "current");
          const countered = businesses.filter((b) => b.countered_round === job.round);
          const answered = countered.every((b) => b.status === "bounced" || quotes.some((q) => q.business_id === b.business_id && q.round >= b.countered_round));
          if (answered) return { type: "window_closed" };
        }
      }
      return deadlinePassed ? { type: "window_closed" } : null;
    }
    if (job.state === "awaiting_approval") {
      const a = await this.repo.getLatestApproval(job.id);
      if (a?.status === "approved") return { type: "approval_verified" };
      if (!a || a.status === "declined" || a.status === "expired" || a.status === "locked") return { type: "approval_void" };
      if (now > Date.parse(a.expires_at)) {
        await this.repo.transitionApproval(a.id, "pending", { status: "expired", decided_at: this.now().toISOString() });
        await this.repo.appendEvent(job.id, "approval_expired", { approval_id: a.id });
        return { type: "approval_void" };
      }
    }
    if (job.state === "paying") {
      const p = await this.repo.getPaymentForJob(job.id);
      if (p?.status === "settled") return { type: "payment_settled" };
      if (p && (p.status === "rejected" || p.status === "failed")) return { type: "payment_failed_final" };
    }
    return null;
  }

  /**
   * Businesses that got Haggle's missing-info follow-up and haven't replied since. Only custom-ask
   * requests hold the window for them (a missing required answer blocks nothing else); catering
   * gaps are caveats on the approval, so the follow-up goes out without delaying the deal.
   */
  private async owingFollowUp(job: JobRow): Promise<Set<string>> {
    if (!job.request.ask?.length) return new Set();
    const msgs = await this.repo.listMessages(job.id);
    const owe = new Set<string>();
    for (const f of msgs.filter((m) => m.direction === "out" && m.kind === "followup" && m.idempotency_key?.endsWith(":missing") && m.business_id)) {
      // Strictly after: the reply that triggered the follow-up was stored just before it.
      const answered = msgs.some((m) => m.direction === "in" && m.business_id === f.business_id && m.kind === "reply" && m.created_at > f.created_at);
      if (!answered) owe.add(f.business_id!);
    }
    return owe;
  }

  private async parsePending(job: JobRow) {
    const reqs = this.requirements(job);
    const businesses = await this.repo.getBusinesses(job.id);
    for (const msg of await this.repo.getPendingMessages(job.id)) {
      const b = businesses.find((x) => x.business_id === msg.business_id);
      if (!b) {
        await this.repo.updateMessage(msg.id, { parse_status: "failed" });
        continue;
      }
      // Unauthenticated mail is kept for audit but never parsed: no LLM call, no attachment
      // download, no quote, question or payment step can come from it.
      if (msg.sender_trusted !== true) {
        await this.repo.updateMessage(msg.id, { parse_status: "done" });
        await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "unverified_sender", summary: `ignored an unauthenticated email claiming to be ${b.name}` });
        await this.repo.touchJob(job.id);
        continue;
      }
      try {
        const files = await this.d.attachments.load(msg);
        const interaction = files.find((f) => f.kind === "json" && /interaction\.json$/i.test(f.filename));
        if (interaction) {
          await this.handleInteraction(job, b, msg, interaction.data);
          await this.repo.updateMessage(msg.id, { parse_status: "done" });
          continue;
        }
        let extraction = null;
        const qj = files.find((f) => f.kind === "json" && /quote\.json$/i.test(f.filename));
        if (qj) {
          try {
            const parsed = quotePartToExtraction(JSON.parse(Buffer.from(qj.data).toString("utf8")), job.id, reqs, job.request.quantity);
            if (parsed.ok) extraction = parsed.extraction;
            else await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "conflicting_numbers", summary: parsed.reason });
          } catch {
            await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "conflicting_numbers", summary: "quote.json is not valid JSON" });
          }
        }
        const r = job.request;
        // Email: only what the business wrote this time (our quoted RFQ can't be read back as its quote).
        let bodyText = msg.channel === "email" ? cleanEmailBody(msg.body_text ?? "") : msg.body_text ?? "";
        // A text reply ("1454") answers the last thing Haggle texted that business: read them together.
        if (msg.provider_email_id?.startsWith("sms-in:") || msg.provider_email_id?.startsWith("imsg-in:")) {
          const asked = (await this.repo.listMessages(job.id)).filter((m) => m.business_id === b.business_id && m.direction === "out" && !isPlacedCall(m) && m.body_text && m.created_at <= msg.created_at).at(-1);
          if (asked) bodyText = `[Haggle's last text to the business, for context only; these are not the business's words]: ${asked.body_text}\n[The business's reply]: ${bodyText}`;
        }
        const images = files.filter((f): f is typeof f & { kind: "image"; contentType: string } => f.kind === "image" && typeof f.contentType === "string");
        extraction ??= await this.d.extractor.extract({
          request: {
            what: r.what, ...(r.date ? { date: r.date } : {}), ...(r.quantity !== undefined ? { headcount: r.quantity } : {}), location: r.area,
            dietary: reqs.filter((x) => x.kind === "dietary" && x.need).map((x) => ({ need: x.need!, count: x.min_count ?? 0 })), requirements: r.requirements.map((x) => x.text),
            ...(r.details?.length ? { details: r.details } : {}), ...(r.ask?.length ? { ask: r.ask } : {}), channel: msg.channel,
          },
          bodyText, pdfs: files.filter((f): f is typeof f & { kind: "pdf" } => f.kind === "pdf"), ...(images.length ? { images } : {}), message: msg,
        });
        // A call: an amount only Haggle's own voice agent said is never the business's price.
        if (msg.channel === "phone") extraction = dropAgentOnlyAmounts(extraction, bodyText, r.ask ?? []);
        if (msg.channel === "a2a") for (const src of extraction.sources) src.source = "a2a task";
        await this.storeExtraction(job, b, msg, extraction, msg.channel === "a2a" ? "a2a task" : msg.channel === "phone" ? "call transcript" : qj ? "quote.json" : files.some((f) => f.kind === "pdf") ? "pdf" : images.length ? "image" : "email body");
        await this.repo.updateMessage(msg.id, { parse_status: "done" });
      } catch (err) {
        this.log("parse_failed", { job_id: job.id, message_id: msg.id, error: (err as Error).message });
        await this.repo.updateMessage(msg.id, { parse_status: "failed" });
        await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "low_confidence", summary: "could not read this reply" });
      }
    }
  }

  private async storeExtraction(job: JobRow, b: JobBusinessRow, msg: MessageRow, x: Parameters<typeof validateQuote>[0], kind: string) {
    // Mail that fails sender authentication never becomes a quote or a question: it can't win, and
    // it must not supersede (knock out) the business's genuine quote either. Kept for audit only.
    if (msg.sender_trusted !== true) {
      await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "unverified_sender", summary: `ignored an unauthenticated email claiming to be ${b.name}` });
      await this.repo.touchJob(job.id);
      return;
    }
    const reqs = this.requirements(job);
    const { ask, compare, moneyCompare, payable } = askInfo(job.request);
    const prior = (await this.repo.listQuotes(job.id)).filter((q) => q.business_id === b.business_id);
    const priorCurrent = prior.find((q) => q.status === "current");
    // A reply that answers only part (e.g. the follow-up) keeps everything stated before: unstated
    // facts carry over from the business's current quote (never across a decline).
    const record = mergeCarryOver(validateQuote(x, job.request.quantity, ask), priorCurrent?.sender_trusted ? priorCurrent.record : null);
    // Custom requests: a money compare_by field IS the total that ranks and negotiates (after the
    // carry-over, so a revised price wins over the old one); payable_field is what approval pays.
    if (compare && moneyCompare) {
      const v = record.fields?.[compare.key];
      if (typeof v === "number") record.total_cents = v;
    }
    if (payable) {
      const v = record.fields?.[payable.key];
      if (typeof v === "number" && (record.total_cents === null || v <= record.total_cents)) record.deposit_cents = v;
      else if (typeof v === "number") record.flags = [...new Set([...record.flags, "conflicting_numbers"])];
    }
    const results = evaluateRequirements(record, reqs, job.request.quantity);
    const compliant = meetsHardRequirements(results, reqs);
    const questionIds: string[] = [];
    for (const text of record.questions) {
      const q = await this.repo.insertQuestion({ job_id: job.id, business_id: b.business_id, message_id: msg.id, text });
      questionIds.push(q.id);
      await this.repo.appendEvent(job.id, "question", { question_id: q.id, business_id: b.business_id, text });
      await this.notifyHuman(job, `question:${q.id}`, `${b.name} asks: "${text.replace(/\s+/g, " ").slice(0, 180)}" Reply to this text to answer.`, q.id);
    }
    let quoteRow: QuoteRow | null = null;
    // Every priced reply is reported as a quote, even without a single stated total (flagged; Haggle
    // asks for the exact total below when it can).
    const priced = record.total_cents !== null || record.subtotal_cents !== null || record.price_per_head_cents !== null || record.deposit_cents !== null;
    const statedField = Object.values(record.fields ?? {}).some((v) => v !== null);
    if (priced || !record.available || statedField) {
      const source = record.sources.total?.source ?? (kind === "quote.json" ? "quote.json" : kind);
      quoteRow = await this.repo.insertCurrentQuote({
        job_id: job.id, business_id: b.business_id, message_id: msg.id, round: prior.length + 1, record, total_cents: record.total_cents,
        deposit_cents: record.deposit_cents, compliant, requirement_results: results, sender_trusted: msg.sender_trusted === true, source,
      });
      if (quoteRow) {
        this.roundCache.set(quoteRow.id, quoteRow.round);
        await this.repo.appendEvent(job.id, "quote", { quote_id: quoteRow.id, business_id: b.business_id, total_usd: record.total_cents === null ? null : centsToUsd(record.total_cents), round: quoteRow.round });
        {
          const how = msg.provider_email_id?.startsWith("call-ended:") ? " on the call" : msg.provider_email_id?.startsWith("sms-in:") ? " by text" : "";
          const all = await this.repo.getBusinesses(job.id);
          const quoted = new Set((await this.repo.listQuotes(job.id)).filter((q) => q.status === "current").map((q) => q.business_id)).size;
          const worked = /^computed/.test(record.sources.total?.source ?? "") ? " (total worked out from their prices)" : "";
          await this.notifyHuman(job, `quote:${quoteRow.id}`, record.total_cents === null
            ? `${b.name} replied${how} without one clear total. ${quoted} of ${all.length} quotes in.`
            : `${b.name} quoted ${usdText(record.total_cents)}${how} for ${job.request.what}${worked}. ${quoted} of ${all.length} quotes in.`);
        }
        for (const f of record.flags) await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: f });
        if (!compliant) await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "requirement_unmet" });
        if (priorCurrent) await this.onRevision(job, priorCurrent);
        // No stated total (missing or worked out from parts): ask once for the exact figure, on the
        // channel the business was first contacted on (email, text, a follow-up call, A2A).
        const stated = record.total_cents !== null && !/^computed/.test(record.sources.total?.source ?? "");
        if (record.available && !stated && record.questions.length === 0) await this.askExactTotal(job, b, record.total_cents);
      }
    } else if (record.questions.length === 0) {
      for (const f of record.flags) await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: f });
      // Vague reply ("~900ish", or a call that ended without a price): ask once for one exact total
      // instead of guessing a number, on the same channel (a phone business gets a follow-up call).
      if (record.available && (await this.askExactTotal(job, b, null)) && b.channel === "phone") {
        await this.notifyHuman(job, `unpriced:${msg.id}`, `${b.name} gave no clear total${msg.provider_email_id?.startsWith("call-ended:") ? " on the call" : ""}; a follow-up call will ask for it.`);
      }
    }
    const status = !record.available ? "declined" : quoteRow ? "quoted" : record.questions.length ? "question" : b.followups_sent >= 1 ? "silent" : "replied";
    await this.repo.updateBusiness(job.id, b.business_id, { status });
    // One automatic follow-up for whatever the quote still lacks (required answers, unstated hard
    // requirements). The window stays open until the business answers it or the deadline passes.
    if (quoteRow && record.available && job.request.auto_follow_up !== false && !TERMINAL.has(job.state) && !job.ready) {
      const missing = this.missingLabels(job, quoteRow);
      if (missing.length) await this.sendMissingFollowUp(job, { ...b, status }, missing);
    }
    // Partner's brain learns from every parsed reply; a brain failure never blocks the deal.
    try {
      const contractQuote = quoteRow ? toContractQuote(quoteRow, b, { budgetCents: job.budget_cents }) : null;
      await this.d.brain.learnFromReply(b.business_id, toParsedReply(x, contractQuote, questionIds), {
        job_id: job.id, business_id: b.business_id, business_email: b.email ?? `tel:${b.phone ?? ""}`, message_id: msg.id, thread_id: msg.thread_id ?? "",
        received_at: msg.created_at, rfq_sent_at: b.contacted_at ?? job.created_at, channel: kind === "quote.json" ? "quote.json" : kind === "pdf" ? "pdf" : kind === "a2a task" ? "a2a" : kind === "call transcript" ? "transcript" : "text", reply_channel: msg.channel,
        sender_trusted: msg.sender_trusted === true, sender_trust_reason: msg.trust_reason ?? "unknown", request: job.request, simulated: b.simulated,
      });
    } catch (err) {
      this.log("brain_learn_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
    }
    await this.repo.touchJob(job.id);
  }

  /** What a stored quote still lacks: required custom answers, or hard requirements the business didn't address. */
  private missingLabels(job: JobRow, q: QuoteRow): string[] {
    if (q.record.flags.some((f) => f === "external_payment_link" || f === "prompt_injection")) return []; // never chase a suspicious reply
    const { ask } = askInfo(job.request);
    if (ask.length) return ask.filter((f) => f.required && (q.record.fields?.[f.key] ?? null) === null).map((f) => f.label);
    const reqs = new Map(job.request.requirements.map((r) => [r.id, r]));
    return q.requirement_results.filter((r) => r.met === null && reqs.get(r.requirement_id)?.hard).map((r) => reqs.get(r.requirement_id)!.text);
  }

  /**
   * One follow-up per business asking only for what's missing, on the channel it was first contacted
   * on: in its email thread, by text, as a short Voice AI call (scheduled when call hours or the
   * cooldown say wait), or in its A2A context. Never switches channel.
   */
  private async sendMissingFollowUp(job: JobRow, b: JobBusinessRow, missing: string[]) {
    const key = `followup:${job.id}:${b.business_id}:missing`;
    if (await this.repo.findMessageByIdempotencyKey(key)) return;
    if (!this.canReach(b)) return;
    const list = missing.map((m) => `- ${m}`).join("\n");
    let how: string;
    try {
      if (b.channel === "email") {
        await this.sendRecorded(job, b, "followup", key, {
          to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true,
          bodyText: `Hi ${b.name},\n\nThanks for your quote! Could you also tell us:\n${list}\n\n${this.signOff(job)}`,
        });
        how = "email";
      } else if (b.channel === "imessage") {
        if (!(await this.sendIMessageToBusiness(job, b, "followup", key, `Thanks for the quote! Could you also confirm: ${missing.join("; ")}? Ref HG-${job.short_code}`, null))) return;
        how = "text";
      } else if (b.channel === "phone") {
        const c = await this.callBusiness(job, b, { key, kind: "followup", reason: this.taskBrief(job, b, "followup", missing.join("; ")), body: missing.join("; ") });
        if (!c.placed && !c.scheduledFor) return;
        how = c.placed ? "call" : "call, scheduled";
      } else {
        if (!(await this.sendA2aMessage(job, b, "followup", key, `Thanks for your quote! Could you also tell us:\n${list}`))) return;
        how = "A2A";
      }
      await this.repo.updateBusiness(job.id, b.business_id, { followups_sent: b.followups_sent + 1 });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Asked ${b.name} for: ${missing.join(", ")} (${how})`, channel: b.channel });
      // Keep the window open long enough for the answer.
      const grace = this.d.config.replyGraceMs ?? Math.min(this.d.config.collectionWindowMs, 15 * 60_000);
      const until = new Date(this.now().getTime() + grace).toISOString();
      const fresh = await this.repo.getJob(job.id);
      if (fresh && !fresh.ready && ["collecting", "negotiating"].includes(fresh.state) && fresh.collect_until < until) await this.repo.touchJob(job.id, { collect_until: until });
    } catch (err) {
      this.log("followup_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
    }
  }

  /** A business revised its quote: any approval for the old revision is void. */
  private async onRevision(job: JobRow, old: QuoteRow) {
    const a = await this.repo.getLatestApproval(job.id);
    if (a && a.quote_id === old.id && (a.status === "pending" || a.status === "approved")) {
      const pay = await this.repo.getPaymentForJob(job.id);
      if (pay && ["signed", "sent", "settled", "charging"].includes(pay.status)) return; // money already moving; guard protects anyway
      await this.repo.transitionApproval(a.id, a.status, { status: "expired", decided_at: this.now().toISOString() });
      if (pay && ["awaiting_invoice", "invoice_received"].includes(pay.status)) await this.repo.transitionPayment(pay.id, ["awaiting_invoice", "invoice_received"], { status: "failed", reason: "quote_revised" });
      await this.repo.appendEvent(job.id, "approval_void", { approval_id: a.id, reason: "quote revised after approval" });
    }
  }

  // ───────────────────────────── x402 ─────────────────────────────

  private async handleInteraction(job: JobRow, b: JobBusinessRow, msg: MessageRow, data: Uint8Array) {
    const pay = await this.repo.getPaymentForJob(job.id);
    let envelope: { step?: string; payload?: Record<string, unknown>; prev_step_id?: string | null } = {};
    try {
      envelope = JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "conflicting_numbers", summary: "interaction.json is not valid JSON" });
      return;
    }
    if (!pay || pay.business_id !== b.business_id) {
      await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "external_payment_link", summary: "payment request from a business that wasn't approved; ignored" });
      return;
    }
    const threadMatched = msg.matched_via === "thread" || msg.matched_via === "message_id" || (msg.to_address ?? "") === job.inbox;
    if (envelope.step === "challenge") {
      const parsed = parseChallengePart(data);
      if (!parsed.ok) {
        await this.repo.appendEvent(job.id, "payment", { status: "invoice_rejected", reason: parsed.reason });
        return;
      }
      if (pay.status !== "awaiting_invoice" && pay.status !== "expired") return; // duplicate or late challenge: stored, not paid
      const updated = await this.repo.transitionPayment(pay.id, ["awaiting_invoice", "expired"], {
        status: "invoice_received", challenge_json: Buffer.from(data).toString("utf8"), challenge_step_id: parsed.parsed.stepId, challenge_message_id: msg.id,
        challenge_trusted: msg.sender_trusted === true, challenge_thread_matched: threadMatched, pay_to: parsed.parsed.payTo,
      });
      if (updated) await this.repo.appendEvent(job.id, "payment", { status: "invoice_received" });
      return;
    }
    if (envelope.step === "receipt") {
      // NOT VERIFIED against a live receipt: accept only a trusted, in-thread receipt for our step with a tx hash.
      const p = envelope.payload ?? {};
      const tx = typeof p.settle_tx === "string" ? p.settle_tx : typeof p.transaction === "string" ? p.transaction : null;
      const ok = msg.sender_trusted === true && threadMatched && pay.status === "sent" && tx !== null && p.status !== "rejected";
      if (ok) {
        const done = await this.repo.transitionPayment(pay.id, ["sent"], { status: "settled", settle_tx: tx, simulated: pay.simulated || msg.simulated });
        if (done) await this.repo.appendEvent(job.id, "payment", { status: "settled", settle_tx: tx, simulated: done.simulated });
      } else if (pay.status === "sent" && p.status === "rejected") {
        await this.repo.transitionPayment(pay.id, ["sent"], { status: "rejected", reason: typeof p.reason === "string" ? p.reason.slice(0, 200) : "rejected" });
        await this.repo.appendEvent(job.id, "payment", { status: "rejected" });
      }
    }
  }

  /** Called from POST /inbound for Primitive's signed payment.settled webhook. */
  async recordSettlement(jobId: string, challengeStepId: string, settleTx: string) {
    const pay = await this.repo.getPaymentForJob(jobId);
    if (!pay || pay.challenge_step_id !== challengeStepId) return false;
    const done = await this.repo.transitionPayment(pay.id, ["sent"], { status: "settled", settle_tx: settleTx });
    if (done) await this.repo.appendEvent(jobId, "payment", { status: "settled", settle_tx: settleTx, simulated: done.simulated });
    return done !== null;
  }

  private async processPayment(jobId: string) {
    if (this.d.stripe) {
      await this.processStripePayment(jobId);
      return;
    }
    const job = await this.repo.getJob(jobId);
    if (!job || job.state !== "paying") return;
    const pay = await this.repo.getPaymentForJob(jobId);
    if (!pay) return;
    const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === pay.business_id);
    if (!b) return;
    if (pay.status === "signed" && pay.interaction_json) {
      // Crash between sign and send: resend the identical bytes under the same key.
      await this.sendPaymentStep(job, b, pay, new TextEncoder().encode(pay.interaction_json));
      return;
    }
    if (pay.status !== "invoice_received" || !job.pay_intent || !pay.challenge_json) return;
    const approval = await this.repo.getApproval(pay.approval_id);
    const quote = approval ? await this.repo.getQuote(approval.quote_id) : null;
    const parsed = parseChallengePart(pay.challenge_json);
    if (!parsed.ok) return;
    const prepared = await preparePayment(this.d.payer.client, this.d.payer.signer, parsed.parsed, {
      job: { id: job.id, state: job.state },
      approval: approval ? { id: approval.id, job_id: approval.job_id, quote_id: approval.quote_id, business_id: approval.business_id, quote_total_cents: approval.quote_total_cents, payment_cents: approval.payment_cents, status: approval.status, expires_at: approval.expires_at } : null,
      quote: quote ? { id: quote.id, business_id: quote.business_id, total_cents: quote.total_cents, deposit_cents: quote.deposit_cents, status: quote.status } : null,
      knownPayTo: null, existingPayment: null, spendCapCents: Math.min(job.payment_cap_cents, this.d.config.globalPaymentCapCents), now: this.now(),
      challengeEmail: { business_id: pay.business_id, sender_trusted: pay.challenge_trusted, thread_matched: pay.challenge_thread_matched },
    });
    if (!prepared.ok) {
      const code = prepared.guard.code;
      const status = code === "CHALLENGE_EXPIRED" ? "expired" : "failed";
      await this.repo.transitionPayment(pay.id, ["invoice_received"], { status, reason: code });
      await this.repo.appendEvent(job.id, "payment", { status, reason: code });
      return;
    }
    const signed = await this.repo.transitionPayment(pay.id, ["invoice_received"], { status: "signed", interaction_json: Buffer.from(prepared.interactionJson).toString("utf8") });
    if (!signed) return;
    await this.repo.transitionApproval(pay.approval_id, "approved", { status: "used" });
    await this.repo.appendEvent(job.id, "payment", { status: "signed" });
    await this.sendPaymentStep(job, b, signed, prepared.interactionJson);
  }

  /**
   * Stripe rail (v5). Charges only when the agent asked to pay (pay_intent) and the guard passes:
   * exact approved quote and amount, approved + unexpired, under the cap, payee = the business that
   * quoted from a trusted sender. One `charging` row per approval is written BEFORE Stripe is called
   * (unique approval_id, so concurrent pays charge once); a crash or a retryable error leaves it
   * `charging` and the next advance resumes with the SAME idempotency key, so Stripe never charges
   * twice. Returns the refusal code when the guard said no (nothing was charged).
   */
  private async processStripePayment(jobId: string): Promise<{ refused?: StripeGuardCode }> {
    const stripe = this.d.stripe!;
    const job = await this.repo.getJob(jobId);
    if (!job || job.state !== "paying") return {};
    const approval = await this.repo.getLatestApproval(jobId);
    if (!approval) return {};
    let pay = await this.repo.getPaymentForJob(jobId);
    if (pay && pay.approval_id === approval.id && pay.status !== "charging") return {};
    // A `charging` row is resumed only after a recorded retryable failure, or when it is stale (a
    // crash between insert and result). A fresh one is in flight in another call: don't call Stripe
    // again (its idempotency key would dedupe, but we never rely on that alone).
    if (pay && pay.approval_id === approval.id && pay.status === "charging" && !pay.reason?.startsWith("retryable:") && Date.now() - Date.parse(pay.updated_at) < 60_000) return {};
    if (!pay || pay.approval_id !== approval.id) {
      if (!job.pay_intent) return {};
      const quote = await this.repo.getQuote(approval.quote_id);
      const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === approval.business_id);
      const verdict = checkStripePaymentAllowed({
        stripeConfigured: true,
        job: { id: job.id, state: job.state },
        approval: { id: approval.id, job_id: approval.job_id, quote_id: approval.quote_id, business_id: approval.business_id, quote_total_cents: approval.quote_total_cents, payment_cents: approval.payment_cents, status: approval.status, expires_at: approval.expires_at },
        quote: quote ? { id: quote.id, business_id: quote.business_id, total_cents: quote.total_cents, deposit_cents: quote.deposit_cents, status: quote.status } : null,
        payee: b && quote ? { business_id: b.business_id, on_job: true, quoted_from_trusted_sender: quote.sender_trusted && quote.business_id === b.business_id } : null,
        existingPayment: null,
        spendCapCents: Math.min(job.payment_cap_cents, this.d.config.globalPaymentCapCents, approval.cap_cents),
        now: this.now(),
      });
      if (!verdict.ok) {
        await this.repo.appendEvent(jobId, "payment_refused", { code: verdict.code, approval_id: approval.id });
        return { refused: verdict.code };
      }
      const inserted = await this.repo.insertPayment({
        id: newId("pay"), job_id: jobId, approval_id: approval.id, business_id: approval.business_id, status: "charging", rail: "stripe",
        amount_cents: approval.payment_cents, amount_base_units: String(approval.payment_cents), network: STRIPE_NETWORK,
        idempotency_key: `haggle-pay-${approval.id}`, stripe_payment_intent_id: null,
        challenge_json: null, challenge_step_id: null, challenge_message_id: null, challenge_trusted: false, challenge_thread_matched: false,
        pay_to: null, interaction_json: null, settle_tx: null, simulated: stripe.simulated, reason: null,
      });
      if (!inserted) return {}; // another pay() won the race; it charges
      await this.repo.appendEvent(jobId, "payment", { status: "charging", rail: "stripe", simulated: stripe.simulated });
      pay = inserted;
    }
    const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === pay!.business_id);
    const r = await stripe.charge({
      amountCents: pay.amount_cents, idempotencyKey: pay.idempotency_key!,
      description: `Haggle deposit to ${b?.name ?? "business"} (job HG-${job.short_code})${stripe.simulated ? " [DEMO]" : " [TEST MODE]"}`,
      metadata: { job_id: jobId, approval_id: pay.approval_id, quote_id: approval.quote_id, business_id: pay.business_id, business: b?.name ?? "" },
    });
    if (r.ok) {
      const done = await this.repo.transitionPayment(pay.id, ["charging"], { status: "settled", stripe_payment_intent_id: r.paymentIntentId, reason: null });
      if (done) {
        await this.repo.transitionApproval(pay.approval_id, "approved", { status: "used" });
        await this.repo.appendEvent(jobId, "payment", { status: "settled", rail: "stripe", payment_intent_id: r.paymentIntentId, simulated: done.simulated });
      }
    } else if (r.retryable) {
      // Stays `charging` and marked resumable; the next advance retries with the same key.
      await this.repo.transitionPayment(pay.id, ["charging"], { reason: `retryable:${r.reason}`.slice(0, 200), ...(r.paymentIntentId ? { stripe_payment_intent_id: r.paymentIntentId } : {}) });
      this.log("stripe_charge_retry", { job_id: jobId, reason: r.reason });
    } else {
      await this.repo.transitionPayment(pay.id, ["charging"], { status: "failed", reason: r.reason.slice(0, 200), ...(r.paymentIntentId ? { stripe_payment_intent_id: r.paymentIntentId } : {}) });
      await this.repo.appendEvent(jobId, "payment", { status: "failed", rail: "stripe", reason: r.reason.slice(0, 200) });
    }
    return {};
  }

  private async sendPaymentStep(job: JobRow, b: JobBusinessRow, pay: PaymentRow, bytes: Uint8Array) {
    try {
      await this.sendRecorded(job, b, "payment", sendKeys.payment(pay.challenge_step_id!), {
        to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true,
        bodyText: `Payment for the approved $${centsToUsd(pay.amount_cents).toFixed(2)} deposit is attached (x402, ${pay.network}).`,
        attachments: [{ filename: "interaction.json", contentType: "application/json", content: bytes }],
      });
      const sent = await this.repo.transitionPayment(pay.id, ["signed"], { status: "sent" });
      if (sent) await this.repo.appendEvent(job.id, "payment", { status: "sent" });
    } catch (err) {
      // Stays `signed`; the next advance resends the same bytes with the same key.
      this.log("payment_send_failed", { job_id: job.id, error: (err as Error).message });
    }
  }

  // ───────────────────────────── agent operations ─────────────────────────────

  async loadJob(jobId: string): Promise<JobRow> {
    const job = await this.repo.getJob(jobId);
    if (!job) throw new EngineError("job_not_found", `No job ${jobId}.`, "Check the job_id returned by deal.", "deal");
    return job;
  }

  async approvalById(approvalId: string): Promise<ApprovalRow | null> {
    return this.repo.getApproval(approvalId);
  }

  /** The engine scoped to one workspace (what the MCP tools use). */
  forWorkspace(workspaceId: string): WorkspaceEngine {
    return new WorkspaceEngine(this, workspaceId);
  }

  /** The workspace a credential belongs to, by SHA-256 hash of a bearer token or connector secret; null if unknown. */
  async workspaceByCredential(kind: "token" | "connector_secret", hash: string) {
    return kind === "token" ? this.repo.findWorkspaceByTokenHash(hash) : this.repo.findWorkspaceBySecretHash(hash);
  }

  /** Create a workspace (scripts/workspace-create.ts); credentials are stored only as hashes. */
  async createWorkspace(w: { id: string; name: string; tokenHash: string; connectorSecretHash: string; timezone?: string; settings?: Partial<Omit<SettingsRow, "updated_at">> }) {
    const row = await this.repo.insertWorkspace({ id: w.id, name: w.name, token_hash: w.tokenHash, connector_secret_hash: w.connectorSecretHash, timezone: w.timezone ?? "America/Los_Angeles" });
    if (w.settings) await this.updateSettings(w.settings, row.id);
    return row;
  }

  /** Advance every open job (POST /internal/tick, the live backup timer). Returns how many advanced and failed. */
  async advanceAllOpen(limit = 200): Promise<{ advanced: number; failed: number }> {
    let advanced = 0;
    let failed = 0;
    for (const job of (await this.repo.listOpenJobs()).slice(0, limit)) {
      try {
        await this.advanceJob(job.id);
        advanced++;
      } catch (err) {
        failed++;
        this.log("advance_failed", { job_id: job.id, error: (err as Error).message });
      }
    }
    return { advanced, failed };
  }

  /**
   * Long-poll. `until` (from haggle-testing wait_for_request): any_change (default) returns on the
   * next event; ready when quotes are final (or the job ends); approval_decided when no approval is
   * waiting on the human any more; done when the job is finished.
   */
  async waitForUpdate(jobId: string, cursor: number, timeoutMs: number, signal?: AbortSignal, until: WaitUntil = "any_change"): Promise<WaitResult> {
    await this.loadJob(jobId);
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 60_000); // wall-clock: a wait timeout is real time
    for (;;) {
      await this.d.onTick?.();
      await this.advanceJob(jobId);
      const events = await this.repo.listEvents(jobId, cursor);
      const job = (await this.repo.getJob(jobId))!;
      const done = TERMINAL.has(job.state);
      const met = until === "any_change" ? events.length > 0 : until === "ready" ? job.ready || job.state !== "collecting" && job.state !== "negotiating" && job.state !== "contacting" && job.state !== "created"
        : until === "approval_decided" ? job.state !== "awaiting_approval" : done;
      if (met || done || Date.now() >= deadline || signal?.aborted) {
        const updates = events.map(toUpdate).filter((u): u is JobUpdate => u !== null);
        const newCursor = events.length ? events[events.length - 1]!.seq : cursor;
        return { ok: true, mode: job.mode, job_id: jobId, state: job.state, cursor: String(newCursor), updates, timed_out: !met && !done, next: await this.nextHint(job) };
      }
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, deadline - Date.now()))));
    }
  }

  private async nextHint(job: JobRow): Promise<string> {
    const pending = (await this.repo.listQuestions(job.id)).filter((q) => q.status === "pending");
    if (TERMINAL.has(job.state)) return job.state === "paid" ? "Done. get_quotes shows the receipt." : job.state === "confirmed" ? "Done: the business was told to go ahead (nothing was paid)." : `Job ${job.state}${job.failure_reason ? ` (${job.failure_reason})` : ""}.`;
    if (pending.length) return `A business asked a question: answer with answer_business(job_id, question_id='${pending[0]!.id}', answer) or ask the user.`;
    if (job.state === "awaiting_approval") return "Waiting for the human to approve (a text reply YES <code>, an email reply APPROVE <code>, the approval card or form, whichever they got). Call wait_for_update.";
    if (job.state === "paying") return job.pay_intent ? "Payment in progress. Call wait_for_update." : "Approved. Call pay(job_id, quote_id) to pay the deposit.";
    if (job.ready) return "Quotes are final. Call get_quotes, then approve(job_id, quote_id) for the recommended quote.";
    return "Still collecting. Call wait_for_update again (cursor from this response).";
  }

  /**
   * The deal board read model (get_quotes / open_haggle): every contacted business with its channel,
   * live status and latest event; every current quote with eligibility and the reason it can't win;
   * negotiation history; open questions; approval and payment. Superset of the v3 QuotesResult.
   */
  async getQuotes(jobId: string): Promise<DealBoardData> {
    await this.advanceJob(jobId);
    const job = await this.loadJob(jobId);
    const businesses = await this.repo.getBusinesses(jobId);
    const byId = new Map(businesses.map((b) => [b.business_id, b]));
    const all = await this.repo.listQuotes(jobId);
    const { quotes, ranking } = await this.rankRows(job);
    const order = new Map(ranking.ranked.map((r, i) => [r.quoteId, i]));
    const rejectedBy = new Map(ranking.rejected.map((r) => [r.quoteId, r.reason]));
    const sorted = [...quotes].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || (a.total_cents ?? 1e12) - (b.total_cents ?? 1e12));
    const approval = await this.repo.getLatestApproval(jobId);
    const payment = await this.repo.getPaymentForJob(jobId);
    const events = await this.repo.listEvents(jobId);
    const out: BoardQuote[] = [];
    for (const q of sorted) {
      const b = byId.get(q.business_id)!;
      const prev = all.filter((x) => x.business_id === q.business_id && x.id !== q.id && x.total_cents !== null).sort((x, y) => y.round - x.round)[0];
      let price_check: Quote["price_check"];
      if (q.total_cents !== null) {
        try {
          const v = await this.d.brain.checkPrice({ business_id: q.business_id, request: { what: job.request.what, quantity: job.request.quantity, area: job.request.area, date: job.request.date }, total_usd: centsToUsd(q.total_cents) });
          if (v.verdict !== "unknown") price_check = v.verdict;
        } catch { /* brain optional */ }
      }
      const cq = toContractQuote(q, b, { budgetCents: job.budget_cents, ...(prev?.total_cents != null && prev.total_cents !== q.total_cents ? { negotiatedFromCents: prev.total_cents } : {}), ...(price_check ? { price_check } : {}) });
      const reason = rejectedBy.get(q.id);
      const { ask } = askInfo(job.request);
      const fields = ask.length ? Object.fromEntries(ask.map((f) => { const v = q.record.fields?.[f.key] ?? null; return [f.key, f.type === "money" && typeof v === "number" ? centsToUsd(v) : v]; })) : undefined;
      const missingFields = ask.filter((f) => f.required && (q.record.fields?.[f.key] ?? null) === null).map((f) => f.label);
      out.push({
        ...cq, total_usd: q.total_cents === null ? null : cq.total_usd, channel: b.channel, eligible: order.has(q.id),
        // "rejected" only for safety (or a business that declined); every other gap is "incomplete" (flagged, still approvable).
        verdict: order.has(q.id) ? (ranking.caveats.some((c) => c.quoteId === q.id) ? "incomplete" : "compliant") : this.approvability(job, q).hard && this.approvability(job, q).hard !== "no_total" ? "rejected" : "incomplete",
        ...(reason ? { excluded_reason: REJECT_TEXT[reason] } : {}),
        ...(fields ? { fields, missing_fields: missingFields } : {}),
      });
    }
    const questions = (await this.repo.listQuestions(jobId)).filter((q) => q.status === "pending");
    const lastEvent = new Map<string, string>();
    const transcripts = new Map<string, string>();
    for (const e of events) {
      const bid = typeof e.data.business_id === "string" ? e.data.business_id : null;
      if (!bid) continue;
      const summary = e.type === "quote" ? (e.data.total_usd == null ? "Replied without a total" : `Quoted $${Number(e.data.total_usd).toLocaleString("en-US")} (round ${e.data.round})`)
        : e.type === "question" ? `Asked: ${String(e.data.text).slice(0, 120)}` : e.type === "flag" ? `Flagged: ${String(e.data.flag).replace(/_/g, " ")}`
        : e.type === "reply" ? String(e.data.summary ?? "") : null;
      if (summary) lastEvent.set(bid, summary);
      if (typeof e.data.transcript_snippet === "string" && e.data.transcript_snippet) transcripts.set(bid, e.data.transcript_snippet);
    }
    const wonBusiness = approval && ["approved", "used"].includes(approval.status) ? approval.business_id : job.state === "paid" && payment ? payment.business_id : null;
    const board: BoardBusiness[] = businesses.map((b) => {
      const transcript = transcripts.get(b.business_id);
      return {
        id: b.business_id, business_id: b.business_id, name: b.name, business: b.name, channel: b.channel, status: this.boardStatus(b, job, wonBusiness, all), engine_status: b.status,
        simulated: b.simulated, last_event: lastEvent.get(b.business_id) ?? null, ...(transcript ? { transcript_snippet: transcript } : {}),
        ...(b.status === "unavailable" ? { unavailable_reason: this.route(b).reason } : {}),
      };
    });
    const negotiation: NegotiationStep[] = events.filter((e) => e.type === "counteroffer").map((e) => {
      const bid = String(e.data.business_id);
      const answer = all.filter((q) => q.business_id === bid && q.round >= Number(e.data.round)).sort((x, y) => x.round - y.round)[0];
      return { business_id: bid, business: byId.get(bid)?.name ?? bid, round: Number(e.data.round), target_total_usd: Number(e.data.target_total_usd), basis_quote_id: String(e.data.basis_quote_id), outcome_total_usd: answer?.total_cents == null ? null : centsToUsd(answer.total_cents) };
    });
    const openQuestions = questions.map((q) => ({ question_id: q.id, business_id: q.business_id, business: byId.get(q.business_id)?.name ?? q.business_id, text: q.text }));
    return {
      ok: true, mode: job.mode, job_id: jobId, state: job.state,
      job: { id: job.id, request: job.request, state: job.state, budget_usd: job.budget_cents === null ? null : centsToUsd(job.budget_cents), created_at: job.created_at, updated_at: job.updated_at },
      quotes: out,
      ...(ranking.recommendedQuoteId ? { recommended_quote_id: ranking.recommendedQuoteId } : {}),
      rejected: ranking.rejected.map((r) => ({ business_id: r.businessId, quote_id: r.quoteId, reason: rejectToFlag(r.reason), detail: REJECT_TEXT[r.reason] })),
      open_questions: openQuestions,
      pending_questions: openQuestions,
      negotiation,
      business_names: Object.fromEntries(businesses.map((b) => [b.business_id, b.name])),
      businesses: board,
      approval: approval ? approvalRecord(approval, job) : null,
      payment: payment ? paymentStatus(payment) : job.state === "awaiting_approval" ? this.noPayment() : null,
      ready: job.ready, inbox: job.inbox, request: job.request, budget_usd: job.budget_cents === null ? null : centsToUsd(job.budget_cents),
      next: await this.nextHint(job),
    };
  }

  private boardStatus(b: JobBusinessRow, job: JobRow, wonBusiness: string | null, quotes: QuoteRow[]): BoardStatus {
    if (wonBusiness === b.business_id) return "won";
    switch (b.status) {
      case "ringing": return "ringing";
      case "quoted": {
        const latest = Math.max(0, ...quotes.filter((q) => q.business_id === b.business_id).map((q) => q.round));
        return job.state === "negotiating" && b.countered_round > 0 && latest < b.countered_round ? "negotiating" : "quoted";
      }
      case "declined": case "bounced": return "declined";
      case "silent": case "no_reply": return "no_reply";
      case "unavailable": return "unavailable";
      default: return "contacted"; // pending (sending now), contacted, replied, question
    }
  }

  async answerSeller(jobId: string, questionId: string, answer: string) {
    const job = await this.loadJob(jobId);
    if (TERMINAL.has(job.state)) throw new EngineError("job_closed", `Job is ${job.state}.`, "Start a new deal.", "deal");
    const q = await this.repo.getQuestion(questionId);
    if (!q || q.job_id !== jobId) throw new EngineError("question_not_found", "No such pending question on this job.", "Use a question_id from wait_for_update or get_quotes.", "get_quotes");
    if (q.status !== "pending") throw new EngineError("already_answered", "That question was already answered.", "Nothing to do; wait for the business's quote.", "wait_for_update");
    const text = answer.trim().slice(0, 2000);
    if (!text) throw new EngineError("empty_answer", "Answer is empty.", "Pass the answer text.", "answer_business");
    const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === q.business_id)!;
    // The answer goes on the channel the business was first contacted on (and asked on).
    if (!this.canReach(b)) throw new EngineError("no_contact_method", `${b.name} can't be reached by ${b.channel} here any more.`, "Send the answer with send_message and an explicit channel the business has (see get_quotes).", "send_message");
    const textSuffix = ` Could you send your full total and deposit? Ref HG-${job.short_code}`;
    await this.guardText(job, b, text, b.channel === "imessage" ? (this.d.imessage ? 159 : SMS_LIMIT) - textSuffix.length : MESSAGE_LIMIT[b.channel]);
    // The key covers the answer text: a retry of the same answer is idempotent, a corrected answer
    // (after a refused send) is a new message rather than a reused key.
    const key = `${sendKeys.answer(q.id)}:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
    let m: MessageRow | null;
    let scheduledFor: string | undefined;
    try {
      if (b.channel === "imessage") m = await this.sendIMessageToBusiness(job, b, "answer", key, `${text}${textSuffix}`, null);
      else if (b.channel === "phone") {
        const c = await this.callBusiness(job, b, { key, kind: "answer", reason: this.taskBrief(job, b, "answer", text), body: text });
        m = c.placed;
        scheduledFor = c.scheduledFor;
      } else if (b.channel === "a2a") m = await this.sendA2aMessage(job, b, "answer", key, `Thanks for asking. ${text}\n\nCould you send your full quote (total, deposit, delivery) when ready?`);
      else m = await this.sendRecorded(job, b, "answer", key, { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true, bodyText: `Hi ${b.name},\n\nThanks for asking. ${text}\n\nCould you send your full quote (total, deposit, delivery) when ready?\n\n${this.signOff(job)}` });
      if (!m && !scheduledFor) throw new EngineError("send_refused", `The answer to ${b.name} wasn't sent (${b.channel} unavailable).`, "Try again shortly, or send it with send_message and an explicit channel.", "answer_business");
    } catch (err) {
      if (err instanceof EngineError) throw err;
      const detail = (err as Error).message;
      if (/conversation_unhealthy|identical body/i.test(detail)) throw new EngineError("send_limited", `Inkbox held this message: ${b.name} already got the same text without replying.`, "Reword the answer (it must differ from what you sent), or wait for the business to reply.", "answer_business");
      if (/\b(403|409|429)\b/.test(detail)) throw new EngineError("send_refused", `The message to ${b.name} wasn't sent (${detail.slice(0, 120)}).`, "Wait a minute and answer again with the same question_id.", "answer_business");
      throw err;
    }
    if (!(await this.repo.answerQuestion(q.id, text))) throw new EngineError("already_answered", "That question was already answered.", "Wait for the business's quote.", "wait_for_update");
    // The same business asking again (a resent email) is covered by this one answer.
    for (const other of await this.repo.listQuestions(jobId)) if (other.status === "pending" && other.business_id === q.business_id) await this.repo.answerQuestion(other.id, text);
    await this.repo.updateBusiness(jobId, b.business_id, { status: b.channel === "phone" && m ? "ringing" : "contacted" });
    await this.repo.appendEvent(jobId, "reply", { business_id: b.business_id, summary: `Answered ${b.name}'s question (${b.channel === "phone" ? (scheduledFor ? "call, scheduled" : "call") : b.channel === "imessage" ? "text" : b.channel})`, channel: b.channel });
    await this.repo.touchJob(jobId);
    return {
      ok: true as const, mode: job.mode, question_id: q.id, sent: !scheduledFor, ...(scheduledFor ? { scheduled_for: scheduledFor } : {}), ...(m?.id ? { message_id: m.id } : {}),
      next: scheduledFor ? `The answer goes to ${b.name} on a call at ${scheduledFor} (call hours or a recent call). Call wait_for_update.` : "Call wait_for_update for their quote.",
    };
  }

  /**
   * The message guard for agent-written text (answer_business, send_message): amounts must come from
   * this request or a stored quote, other businesses are never named, no commitment phrases, and
   * the channel's length limit. Throws an EngineError with the guard's code.
   */
  private async guardText(job: JobRow, b: JobBusinessRow, text: string, limit: number) {
    const verified = new Set<number>();
    for (const q of await this.repo.listQuotes(job.id)) {
      for (const c of [q.total_cents, q.deposit_cents, q.record.price_per_head_cents, q.record.subtotal_cents, q.record.delivery_fee_cents, q.record.tax_cents]) if (c !== null) verified.add(c);
      for (const v of Object.values(q.record.fields ?? {})) if (typeof v === "number") verified.add(v);
    }
    for (const d of job.request.details ?? []) for (const c of findDollarAmounts(d.value)) verified.add(c);
    const others = (await this.repo.getBusinesses(job.id)).filter((x) => x.business_id !== b.business_id).map((x) => x.name);
    const g = checkMessage({ text, limit, verifiedCents: verified, otherBusinessNames: others });
    if (g.ok) return;
    const fix = {
      UNVERIFIED_AMOUNT: "Only cite amounts from get_quotes or the request; never invent a competing offer.",
      MENTIONS_OTHER_BUSINESS: "Don't name other businesses; say 'another quote' instead (or use negotiate).",
      MESSAGE_TOO_LONG: "Shorten the message.",
      COMMITMENT_NEEDS_APPROVAL: "To commit, use approve: the human approves and Haggle confirms with the business.",
    }[g.code];
    throw new EngineError(g.code.toLowerCase(), g.message, fix, g.code === "COMMITMENT_NEEDS_APPROVAL" ? "approve" : "send_message");
  }

  /**
   * The agent's own message to one business on the deal (send_message), or `askMissing` to ask for
   * exactly what its quote still lacks. It goes on the channel the business was first contacted on
   * (its email thread, a text, a short Voice AI call with call hours and cooldown, or its A2A task
   * context) unless the agent passes another channel explicitly. Free text passes the message guard.
   */
  async sendMessage(jobId: string, businessId: string, opts: { text?: string; askMissing?: boolean; channel?: Channel }): Promise<{ ok: true; mode: JobRow["mode"]; business_id: string; channel: Channel; sent: boolean; scheduled_for?: string; message_id?: string; next: string }> {
    const job = await this.loadJob(jobId);
    if (TERMINAL.has(job.state)) throw new EngineError("job_closed", `Job is ${job.state}.`, "Start a new deal.", "deal");
    const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === businessId);
    if (!b) throw new EngineError("business_not_found", "No such business on this deal.", "Use a business_id from get_quotes.", "get_quotes");
    if (!opts.text === !opts.askMissing) throw new EngineError("bad_message", "Pass exactly one of text or ask_missing.", "Send free text, or ask_missing=true to ask for what the quote lacks.", "send_message");
    // Default: the channel it was first contacted on. Another channel only when the agent asks for it.
    const channel: Channel = opts.channel ?? b.channel;
    const reachable = channel === "email" ? !!b.email : channel === "phone" ? !!(b.phone && this.d.phone) : channel === "imessage" ? !!(b.phone && (this.d.imessage || this.d.sms)) : !!(this.d.a2a && b.a2a_card_url && b.thread_id);
    if (!reachable) throw new EngineError("no_contact_method", `${b.name} can't be reached by ${channel} here.`, opts.channel ? "Pick a channel the business has (see get_quotes), or omit channel." : "Its own channel isn't available here; pass channel explicitly with one the business has (see get_quotes).", "get_quotes");
    const ref = `Ref HG-${job.short_code}`;
    const textLimit = (this.d.imessage ? 159 : SMS_LIMIT) - ref.length - 1;
    let text: string;
    if (opts.askMissing) {
      const q = (await this.repo.listQuotes(jobId)).find((x) => x.business_id === businessId && x.status === "current");
      const missing = q ? this.missingLabels(job, q) : (job.request.ask?.length ? job.request.ask.filter((f) => f.required).map((f) => f.label) : ["the all-in total", "any deposit"]);
      if (missing.length === 0) throw new EngineError("nothing_missing", `${b.name}'s quote isn't missing anything required.`, "Compare quotes with get_quotes.", "get_quotes");
      text = channel === "phone" ? missing.join("; ") : channel === "imessage" ? `Thanks! Could you also confirm: ${missing.join("; ")}?` : `Thanks for your reply! Could you also tell us:\n${missing.map((m) => `- ${m}`).join("\n")}`;
    } else {
      text = opts.text!.trim();
      await this.guardText(job, b, text, channel === "imessage" ? textLimit : MESSAGE_LIMIT[channel]);
    }
    const key = `msg:${randomUUID()}`;
    let messageId: string | undefined;
    if (channel === "email") {
      const m = await this.sendRecorded(job, b, opts.askMissing ? "followup" : "message", key, { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, bodyText: `Hi ${b.name},\n\n${text}\n\n${this.signOff(job)}`, inThread: true });
      messageId = m?.id;
    } else if (channel === "imessage") {
      const m = await this.sendIMessageToBusiness(job, b, opts.askMissing ? "followup" : "message", key, `${text} ${ref}`, null);
      if (!m) throw new EngineError("send_refused", `The text to ${b.name} wasn't sent.`, "Try again shortly, or pass another channel the business has.", "send_message");
      messageId = m.id;
    } else if (channel === "a2a") {
      const t = await this.d.a2a!.send({ cardUrl: b.a2a_card_url!, text, data: { haggle: "message/1", protocol: "haggle.v0", type: "message", job_id: job.id }, messageId: `haggle-${key.replace(/:/g, "-")}`, contextId: b.thread_id! });
      messageId = (await this.recordA2aOutbound(job, b, "message", key, t.taskId, text, job.round))?.id;
    } else {
      const blocked = await this.callBlockedUntil(job, b.phone!);
      if (blocked) return { ok: true, mode: job.mode, business_id: b.business_id, channel, sent: false, scheduled_for: blocked.toISOString(), next: `Calls to ${b.name} are paused until ${blocked.toISOString()} (call hours or a recent call). Try again then, or email if it has an address.` };
      const { callId } = await this.d.phone!.placeCall({ jobId: job.id, businessId: b.business_id, toNumber: b.phone!, reason: this.taskBrief(job, b, opts.askMissing ? "followup" : "message", text), idempotencyKey: key });
      messageId = (await this.repo.insertMessage({
        job_id: job.id, business_id: b.business_id, approval_id: null, direction: "out", kind: "call", channel: "phone", provider_email_id: callId, idempotency_key: key,
        rfc_message_id: null, thread_id: null, from_address: job.inbox, to_address: b.phone, subject: null, body_text: text, attachments: [], attachments_download_url: null,
        sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: null, simulated: job.mode === "mock",
      }))?.id;
    }
    if (!["quoted", "declined"].includes(b.status)) await this.repo.updateBusiness(jobId, b.business_id, { status: channel === "phone" ? "ringing" : "contacted" });
    await this.repo.appendEvent(jobId, "reply", { business_id: b.business_id, summary: `${opts.askMissing ? "Asked" : "Messaged"} ${b.name} by ${channel === "phone" ? "call" : channel === "imessage" ? "text" : channel}`, channel });
    await this.repo.touchJob(jobId);
    return { ok: true, mode: job.mode, business_id: b.business_id, channel, sent: true, ...(messageId ? { message_id: messageId } : {}), next: "Call wait_for_update for their reply." };
  }

  /**
   * A manual counteroffer round (negotiate tool): only once quotes are final, citing the best real
   * quote to every eligible business priced above it (or only `businessIds`). One round past
   * max_rounds at most; money comparisons only.
   */
  async negotiate(jobId: string, businessIds?: string[]): Promise<{ ok: true; mode: JobRow["mode"]; job_id: string; round: number; asked: { business_id: string; business: string; their_total_usd: number; cited_total_usd: number }[]; next: string }> {
    await this.advanceJob(jobId);
    const job = await this.loadJob(jobId);
    if (!["collecting", "negotiating"].includes(job.state) || !job.ready) throw new EngineError("not_ready", job.ready ? `Job is ${job.state}.` : "Quotes are still coming in; Haggle negotiates automatically while collecting.", "Call wait_for_update until quotes are final, then negotiate.", "wait_for_update");
    const before = new Map((await this.repo.listQuotes(jobId)).filter((q) => q.status === "current").map((q) => [q.business_id, q.total_cents]));
    const r = await this.fire(jobId, { type: "negotiation_requested", ...(businessIds?.length ? { businessIds } : {}) });
    if (!r.ok) throw new EngineError("not_comparable", r.reason ?? "conflict", "Negotiation needs two eligible priced quotes and a business above the best one (money comparisons only).", "get_quotes");
    const fresh = await this.loadJob(jobId);
    const byId = new Map((await this.repo.getBusinesses(jobId)).map((b) => [b.business_id, b]));
    const asked = (await this.repo.listEvents(jobId)).filter((e) => e.type === "counteroffer" && Number(e.data.round) === fresh.round).map((e) => {
      const bid = String(e.data.business_id);
      const theirs = before.get(bid);
      return { business_id: bid, business: byId.get(bid)?.name ?? bid, their_total_usd: theirs == null ? 0 : centsToUsd(theirs), cited_total_usd: Number(e.data.target_total_usd) };
    });
    return { ok: true, mode: fresh.mode, job_id: jobId, round: fresh.round, asked, next: asked.length ? "Call wait_for_update for their answers." : "Nobody could be countered on its own channel; call get_quotes." };
  }

  /**
   * One business's conversation on a deal, oldest first: every message (in and out, any channel)
   * and every call with its transcript. Business text is untrusted data, clipped for the model.
   */
  async getConversation(jobId: string, businessId: string, limit = 20): Promise<{ ok: true; mode: JobRow["mode"]; job_id: string; business_id: string; business: string; channel: Channel; entries: ConversationEntry[]; next: string }> {
    await this.advanceJob(jobId);
    const job = await this.loadJob(jobId);
    const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === businessId);
    if (!b) throw new EngineError("business_not_found", "No such business on this deal.", "Use a business_id from get_quotes.", "get_quotes");
    const entries: ConversationEntry[] = (await this.repo.listMessages(jobId))
      .filter((m) => m.business_id === businessId)
      .map((m) => ({
        message_id: m.id, direction: m.direction, channel: m.channel, kind: m.kind, at: m.created_at,
        ...(m.subject ? { subject: m.subject } : {}),
        text: (m.direction === "in" && m.channel === "email" ? cleanEmailBody(m.body_text ?? "") : m.body_text ?? "").slice(0, 800),
        attachments: m.attachments.map((a) => a.filename ?? "attachment"),
        ...(m.direction === "in" ? { sender_verified: m.sender_trusted === true } : {}),
        ...(m.kind === "quarantine" ? { quarantined: true } : {}),
      }))
      .slice(-Math.min(Math.max(limit, 1), 50));
    return { ok: true, mode: job.mode, job_id: jobId, business_id: b.business_id, business: b.name, channel: b.channel, entries, next: "Reply with send_message(job_id, business_id, text) if needed." };
  }

  /** Who Haggle is to businesses, which channels work, and who approves (get_identity). */
  async identity(workspaceId: string = DEFAULT_WORKSPACE_ID) {
    const s = await this.getSettings(workspaceId);
    const ws = await this.repo.getWorkspace(workspaceId);
    const id = this.d.config.identity;
    return {
      ok: true as const, mode: this.d.config.mode,
      identity_name: id?.name ?? "Haggle", email: this.d.config.sharedInbox ?? `haggle@${this.d.config.inboxDomain}`, phone: id?.phone ?? null,
      channels: { email: "ready" as const, phone: this.d.phone ? ("ready" as const) : ("off" as const), a2a: this.d.a2a ? ("ready" as const) : ("off" as const), imessage_approvals: this.d.imessage ? ("ready" as const) : ("off" as const) },
      approver: { phone: s.approver_phone ? maskHandle(s.approver_phone) : null, email: s.approver_email ? maskHandle(s.approver_email) : null },
      spend_cap_usd: centsToUsd(s.spending_cap_cents), workspace: { id: workspaceId, name: ws?.name ?? workspaceId, timezone: ws?.timezone ?? "America/Los_Angeles" },
      call_hours: this.d.config.callHours ?? null,
      next: "Start a deal with deal(...), or set the approver and cap in settings.",
    };
  }

  /**
   * Keep the Voice AI answering instructions in sync with the open requests (fire and forget), so
   * a business calling back is matched to its request. A no-op without a voice port.
   */
  syncVoiceContext() {
    if (!this.d.voice) return;
    void (async () => {
      const jobs = (await this.repo.listOpenJobs()).slice(-20).reverse();
      const voiceJobs = await Promise.all(jobs.map(async (j) => ({ shortCode: j.short_code, request: j.request, businesses: (await this.repo.getBusinesses(j.id)).map((b) => ({ name: b.name, phone: b.phone })) })));
      await this.d.voice!.setInstructions(buildVoiceInstructions(customerOf({}, this.d.config.customerName), voiceJobs));
    })().catch((err) => this.log("voice_sync_failed", { error: (err as Error).message }));
  }

  /**
   * Start an approval for one exact quote. The decision comes from a human channel, never from this
   * call. `action`: confirm (tell the business to go ahead; nothing is paid), pay (the deposit or
   * payable_field amount), or confirm_and_pay (both). Default: confirm_and_pay when there is an
   * amount to pay now, else confirm. Ported from haggle-testing request_approval.
   */
  async requestApproval(jobId: string, quoteId: string, channel: ApprovalRow["channel"], action?: ApprovalAction, offer?: ApprovalOffer): Promise<ApprovalRow> {
    await this.advanceJob(jobId);
    const job = await this.loadJob(jobId);
    if (job.state !== "collecting" && job.state !== "negotiating") {
      const latest = await this.repo.getLatestApproval(jobId);
      if (job.state === "awaiting_approval" && latest?.status === "pending" && latest.quote_id === quoteId && (!action || latest.action === action)) return latest;
      throw new EngineError("not_approvable", `Job is ${job.state}.`, job.state === "paying" ? "Already approved; call pay." : job.state === "awaiting_approval" ? "An approval is already waiting for the human; wait for it or let it expire." : "Wait until quotes are in.", job.state === "paying" ? "pay" : "wait_for_update");
    }
    const q = await this.repo.getQuote(quoteId);
    if (!q || q.job_id !== jobId) throw new EngineError("quote_not_found", "No such quote on this job.", "Use a quote_id from get_quotes.", "get_quotes");
    // Only safety (or no amount for a paying approval) refuses; everything else is a caveat on the approval.
    const { hard } = this.approvability(job, q);
    // Pay the deposit; with no deposit stated, the full total (the approval says so). Confirm-only pays nothing.
    const payNow = q.deposit_cents && q.deposit_cents > 0 ? q.deposit_cents : q.total_cents;
    const act: ApprovalAction = action ?? (payNow ? "confirm_and_pay" : "confirm");
    const pays = act !== "confirm";
    const reason = hard === "no_total" && !pays ? null : hard;
    if (reason) {
      const fix = reason === "no_total" ? "Ask the business for its total (answer_business, or wait for the follow-up Haggle sent), or approve with action 'confirm' (nothing paid)." : "Pick another quote from get_quotes.";
      throw new EngineError("quote_not_eligible", `That quote can't be approved: ${reason}.`, fix, "get_quotes");
    }
    if (pays && !payNow) throw new EngineError("no_deposit", "This quote has no amount to pay now.", "Approve with action 'confirm' (no payment), or ask the business for its price first.", "get_quotes");
    const payment = pays ? payNow! : 0;
    // The operator's per-payment ceiling is the one hard money limit (CLAUDE.md §7: amount ≤ approved ≤ cap).
    const cap = this.d.config.globalPaymentCapCents;
    if (payment > cap) throw new EngineError("over_cap", `The $${centsToUsd(payment).toFixed(2)} payment is over this server's $${centsToUsd(cap).toFixed(2)} per-payment safety ceiling.`, "Ask the business for a smaller deposit, or ask the operator to raise HAGGLE_GLOBAL_PAYMENT_CAP_CENTS.", "get_quotes");
    // Every human channel can be offered at once (form/card + text + email); the first human decision wins.
    const settings = await this.getSettings(job.workspace_id);
    const approverEmail = job.approver_email ?? (settings.approver_email ? normalizeAddress(settings.approver_email) : null);
    const iMessageApprover = Boolean(this.d.imessage && settings.approver_phone);
    const textTo = await this.notifyTarget(job);
    if (channel === "email" && !approverEmail) throw new EngineError("no_approver", "No approver email for this job.", "Set the approver email in settings (settings.update approver_email), or approve on the approval card or by text.", "settings");
    if (channel === "imessage" && !iMessageApprover && !textTo) throw new EngineError("no_imessage_approver", "Text approval isn't available: no number to text (the operator's notify number or the settings approver phone), or texting is off.", "Set the approver phone in settings (and enable SMS or iMessage on the server), or approve on the approval card.", "settings");
    const emailIt = channel === "email" || Boolean(offer?.email && approverEmail);
    // The settings approver email (set after the deal started) becomes this job's verified approver.
    const sendJob = emailIt && approverEmail && !job.approver_email ? { ...job, approver_email: approverEmail } : job;
    if (sendJob !== job) await this.repo.touchJob(jobId, { approver_email: approverEmail });
    const approval = await this.repo.insertApproval({
      id: newId("ap"), job_id: jobId, quote_id: q.id, business_id: q.business_id, quote_total_cents: q.total_cents ?? 0, payment_cents: payment, cap_cents: cap,
      approver: channel === "email" ? sendJob.approver_email : null, channel, status: "pending", action: act, attempts: 0, code: newApprovalCode(),
      expires_at: new Date(this.now().getTime() + this.d.config.approvalTtlMs).toISOString(), decided_at: null, outbound_message_id: null, thread_id: null,
    });
    if (!approval) throw new EngineError("approval_pending", "An approval is already pending for this job.", "Wait for the human, or let it expire.", "wait_for_update");
    const fired = await this.fire(jobId, { type: "approval_requested" });
    if (!fired.ok) {
      await this.repo.transitionApproval(approval.id, "pending", { status: "expired" });
      throw new EngineError("not_approvable", fired.reason ?? "conflict", "Call get_quotes and try again.", "get_quotes");
    }
    await this.repo.appendEvent(jobId, "approval_requested", { approval_id: approval.id, quote_id: q.id, channel });
    if (channel === "email") await this.sendApprovalEmail(sendJob, approval);
    else if (emailIt) {
      try {
        await this.sendApprovalEmail(sendJob, approval);
      } catch (err) {
        await this.repo.appendEvent(jobId, "approval_email_failed", { approval_id: approval.id, error: (err as Error).name });
        this.log("approval_email_failed", { job_id: jobId, error: (err as Error).message });
      }
    }
    // Text: by SMS when asked, or as the "imessage" (text) channel when iMessage itself is off.
    if ((offer?.text || (channel === "imessage" && !iMessageApprover)) && textTo) {
      const r = await this.sendApprovalSms(job, approval).catch((err: Error) => ({ ok: false as const, reason: err.name }));
      if (!r.ok) await this.repo.appendEvent(jobId, "approval_text_failed", { approval_id: approval.id, reason: r.reason });
    }
    if (channel === "imessage" && iMessageApprover) {
      try {
        await this.sendApprovalIMessage(job, approval);
      } catch (err) {
        // Not sent (e.g. the approver hasn't texted `connect @haggle`): the approval card still works.
        await this.repo.appendEvent(jobId, "approval_imessage_failed", { approval_id: approval.id, error: (err as Error).name });
        this.log("imessage_failed", { job_id: jobId, error: (err as Error).message });
      }
    }
    return (await this.repo.getApproval(approval.id))!;
  }

  private async sendApprovalEmail(job: JobRow, a: ApprovalRow) {
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === a.business_id)!;
    const ask = HaggleEngine.approvalAsk(b.name, job.request.what, a.quote_total_cents, a.payment_cents);
    const text = [
      "Your agent picked a quote and needs your OK before anything is confirmed or paid.", "",
      `- Business: ${b.name}`, `- For: ${job.request.what}`, `- Quote total: ${usdText(a.quote_total_cents)}`,
      a.payment_cents > 0
        ? `- Pay now: ${usdText(a.payment_cents)}${a.payment_cents < a.quote_total_cents ? " deposit" : ""}${this.d.stripe ? " (Stripe test mode, no real money)" : ""}`
        : "- Pay now: nothing (this confirms the order only)",
      `- Expires: ${a.expires_at}`, "", `To approve, reply with: APPROVE ${a.code}`, `To decline, reply with: NO ${a.code}`, "",
      "Only a reply from this address with that code counts. You can also approve by text or on the approval card; the first answer wins.",
    ].join("\n");
    const m = await this.sendRecorded(job, null, "approval_request", sendKeys.approvalRequest(a.id), { to: job.approver_email!, subject: `[HG-${job.short_code}] ${ask}?`, bodyText: text, approvalId: a.id });
    await this.repo.updateApproval(a.id, { outbound_message_id: m?.rfc_message_id ?? null });
  }

  /** "Approve $250 deposit to Mission Eats for dinner catering (total $1,760)" (no trailing "?"). */
  static approvalAsk(business: string, what: string, quoteTotalCents: number, paymentCents: number): string {
    const name = business.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 40) || "the business";
    const w = what.replace(/\s+/g, " ").trim().slice(0, 60);
    if (paymentCents <= 0) return `Confirm the order with ${name} for ${w} (total ${usdText(quoteTotalCents)}, nothing paid now)`;
    if (paymentCents < quoteTotalCents) return `Approve ${usdText(paymentCents)} deposit to ${name} for ${w} (total ${usdText(quoteTotalCents)})`;
    return `Approve paying ${usdText(paymentCents)} to ${name} for ${w} (the full total)`;
  }

  /** The approval text: "Haggle: Approve $250 deposit to … (total $1,760)? Reply YES 1234 or NO 1234. (HG-…)". */
  static approvalSmsText(business: string, what: string, quoteTotalCents: number, paymentCents: number, code: string, shortCode: string): string {
    return `Haggle: ${HaggleEngine.approvalAsk(business, what, quoteTotalCents, paymentCents)}? Reply YES ${code} or NO ${code}. (HG-${shortCode})`.slice(0, SMS_LIMIT);
  }

  /**
   * Text the approval to the human's number by SMS (the notify number, else the settings approver).
   * Recorded with an idempotency key, which is also what lets their "YES <code>" reply decide it.
   * Held (and re-sent when they text back) while Inkbox pauses texts to that number.
   */
  private async sendApprovalSms(job: JobRow, a: ApprovalRow, attempt?: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const to = await this.notifyTarget(job);
    if (!to) return { ok: false, reason: "no_text_number" };
    const key = `sms:${sendKeys.approvalRequest(a.id)}`;
    if (await this.repo.findMessageByIdempotencyKey(key)) return { ok: true };
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === a.business_id)!;
    const text = HaggleEngine.approvalSmsText(b.name, job.request.what, a.quote_total_cents, a.payment_cents, a.code, job.short_code);
    const sent = await this.textHuman(job, to, { key, text, approvalId: a.id, ...(attempt ? { attempt } : {}) });
    if (!sent.ok) return sent;
    await this.repo.insertMessage({
      job_id: job.id, business_id: null, approval_id: a.id, direction: "out", kind: "approval_request", channel: "imessage", provider_email_id: `sms:${sent.messageId}`, idempotency_key: key,
      rfc_message_id: null, thread_id: null, from_address: job.inbox, to_address: to, subject: null, body_text: text, attachments: [], attachments_download_url: null,
      sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: null, simulated: job.mode === "mock",
    });
    await this.repo.appendEvent(job.id, "approval_text_sent", { approval_id: a.id });
    return { ok: true };
  }

  /** Which human channels this approval actually went out on (the approve tool tells the agent). */
  async approvalOffers(approvalId: string): Promise<{ email: boolean; text: boolean; imessage: boolean }> {
    const k = sendKeys.approvalRequest(approvalId);
    const [email, text, imessage] = await Promise.all([k, `sms:${k}`, `imsg:${k}`].map((x) => this.repo.findMessageByIdempotencyKey(x)));
    return { email: email !== null, text: text !== null, imessage: imessage !== null };
  }

  /** Can an approval for this job reach the human by text (SMS) or email (approver email set)? */
  async approvalReach(jobId: string): Promise<{ text: boolean; email: boolean }> {
    const job = await this.loadJob(jobId);
    const settings = await this.getSettings(job.workspace_id);
    return { text: Boolean(await this.notifyTarget(job)), email: Boolean(job.approver_email ?? settings.approver_email) };
  }

  /**
   * "Approve $5.00 deposit to Bay Catering (quote $995.00)? Reply YES 4821 or NO 4821". Inkbox's
   * pre-reply rules: ≤ 159 chars, no links, no phone numbers (digit runs are stripped from names).
   */
  static approvalIMessageText(business: string, quoteTotalCents: number, paymentCents: number, code: string): string {
    const name = business.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/\+?\d[\d\s().-]{6,}\d/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "the business";
    const usdS = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    // Confirm-only approvals pay nothing: ask to confirm the order instead.
    const what = paymentCents > 0 ? `approve ${usdS(paymentCents)} deposit to ${name}` : `confirm the order with ${name}`;
    return `Haggle: ${what} (quote ${usdS(quoteTotalCents)})? Reply YES ${code} or NO ${code}`.slice(0, 159);
  }

  private async sendApprovalIMessage(job: JobRow, a: ApprovalRow) {
    const to = (await this.getSettings(job.workspace_id)).approver_phone;
    if (!this.d.imessage || !to) throw new EngineError("no_imessage_approver", "No iMessage approver configured.", "Set the approver phone in settings and enable iMessage.", "settings");
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === a.business_id)!;
    const key = `imsg:${sendKeys.approvalRequest(a.id)}`;
    if (await this.repo.findMessageByIdempotencyKey(key)) return;
    const text = HaggleEngine.approvalIMessageText(b.name, a.quote_total_cents, a.payment_cents, a.code);
    const sent = await this.d.imessage.send({ to, text, idempotencyKey: key });
    await this.repo.insertMessage({
      job_id: job.id, business_id: null, approval_id: a.id, direction: "out", kind: "approval_request", channel: "imessage", provider_email_id: `imsg:${sent.messageId}`, idempotency_key: key,
      rfc_message_id: null, thread_id: null, from_address: job.inbox, to_address: to, subject: null, body_text: text, attachments: [], attachments_download_url: null,
      sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: null, simulated: job.mode === "mock",
    });
    await this.repo.appendEvent(job.id, "approval_imessage_sent", { approval_id: a.id });
  }

  /**
   * An iMessage reply (`imessage.received`). Only the settings approver's number counts, never a
   * group; "YES <code>" approves and "NO <code>" declines that exact pending iMessage approval. A
   * bare "NO" declines only when exactly one is pending. Anything else is ignored. Idempotent.
   */
  async ingestIMessage(m: { messageId: string; from: string; text: string; isGroup: boolean; inbound?: boolean }): Promise<{ jobId: string | null; outcome: string }> {
    if (m.inbound === false) return { jobId: null, outcome: "outbound" };
    const from = m.from.replace(/[\s().-]/g, "");
    if (m.isGroup) return { jobId: null, outcome: "group_ignored" };
    const seen = await this.repo.findMessageByProviderId(`imsg-in:${m.messageId}`);
    if (seen) return { jobId: seen.job_id, outcome: "duplicate" }; // webhook redelivery
    // Only pending iMessage approvals whose workspace approver is this number count.
    const pending: ApprovalRow[] = [];
    for (const a of await this.repo.listPendingApprovalsByChannel("imessage")) {
      const job = await this.repo.getJob(a.job_id);
      if (job && (await this.getSettings(job.workspace_id)).approver_phone === from) pending.push(a);
    }
    if (pending.length === 0) {
      // Not an approver with a pending approval: maybe a business on the iMessage channel texting back.
      const vendor = await this.ingestBusinessIMessage({ messageId: m.messageId, from, text: m.text });
      return vendor.outcome === "unknown_sender" ? { jobId: null, outcome: "not_approver" } : vendor;
    }
    return this.decideByText(pending, { providerId: `imsg-in:${m.messageId}`, from, text: m.text, trustReason: "imessage-from-settings-approver" });
  }

  /**
   * A texted decision (iMessage or SMS) from the human's own number on their pending approvals:
   * "YES <code>" approves and "NO <code>" declines that exact approval; a bare "NO" declines only
   * when exactly one is pending. A wrong code on the only pending approval counts toward the
   * lockout. Recorded once per provider message id.
   */
  private async decideByText(pending: ApprovalRow[], m: { providerId: string; from: string; text: string; trustReason: string }): Promise<{ jobId: string | null; outcome: string }> {
    const from = m.from;
    // The "text" approval channel (iMessage, or SMS when iMessage is off); the DB allows imessage.
    const approver = from;
    const parsed = m.text.trim().match(TEXT_DECISION);
    if (!parsed) return { jobId: null, outcome: "not_a_decision" };
    const yes = /^(yes|y|approve|approved)$/i.test(parsed[1]!);
    const code = parsed[2];
    const target = code ? pending.find((a) => a.code === code) : !yes && pending.length === 1 ? pending[0] : undefined;
    if (!target && code && yes && pending.length === 1) {
      // A wrong code against the approver's only pending approval counts toward the lockout.
      const only = pending[0]!;
      const w = await this.repo.recordWrongApprovalCode(only.id, this.d.config.maxApprovalAttempts ?? DEFAULT_MAX_APPROVAL_ATTEMPTS);
      if (w?.locked) {
        await this.repo.appendEvent(only.job_id, "approval_locked", { approval_id: only.id, attempts: w.attempts });
        await this.advanceJob(only.job_id);
      }
      return { jobId: only.job_id, outcome: w?.locked ? "approval_locked" : "wrong_code" };
    }
    if (!target) return { jobId: null, outcome: code ? "no_matching_approval" : yes ? "code_required" : "ambiguous" };
    const stored = await this.repo.insertMessage({
      job_id: target.job_id, business_id: null, approval_id: target.id, direction: "in", kind: "approval_reply", channel: "imessage", provider_email_id: m.providerId, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 500), attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: m.trustReason, matched_via: "approval_code", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
    });
    if (!stored) return { jobId: target.job_id, outcome: "duplicate" };
    const ok = await this.decideApproval(target.id, yes ? "approve" : "decline", "imessage", approver);
    return { jobId: target.job_id, outcome: ok ? (yes ? "approved" : "declined") : "approval_not_pending" };
  }

  /** Record a human decision from a verified channel (email verifier, MCP elicitation, or mock-mode simulation). */
  async decideApproval(approvalId: string, decision: "approve" | "decline", channel: ApprovalRow["channel"], approver: string | null) {
    const a = await this.repo.getApproval(approvalId);
    if (!a) return false;
    if (channel === "simulated" && this.d.config.mode !== "mock") throw new EngineError("simulation_disabled", "Simulated approval is only available in mock mode.", "Approve through the form or by email.", "approve");
    if (this.now().getTime() > Date.parse(a.expires_at)) {
      await this.repo.transitionApproval(a.id, "pending", { status: "expired", decided_at: this.now().toISOString() });
      await this.advanceJob(a.job_id);
      return false;
    }
    const ok = await this.repo.transitionApproval(a.id, "pending", { status: decision === "approve" ? "approved" : "declined", decided_at: this.now().toISOString(), channel, approver });
    if (ok) {
      await this.repo.appendEvent(a.job_id, decision === "approve" ? "approval_verified" : "approval_declined", { approval_id: a.id, channel });
      await this.advanceJob(a.job_id);
      // Decided outside the chat (a text or an email): nobody may be there to call pay, so pay now.
      // On the card or the client's form the agent is in the conversation and calls pay itself.
      if (decision === "approve" && (channel === "imessage" || channel === "email") && a.action !== "confirm" && a.payment_cents > 0 && this.d.stripe) await this.payApproved(a);
    }
    return ok;
  }

  /**
   * The human approved paying this exact amount: charge it now instead of waiting for the agent to
   * call pay (the chat may be idle). pay() re-checks every guard; a refusal is told to the human.
   */
  private async payApproved(a: ApprovalRow) {
    const job = await this.repo.getJob(a.job_id);
    if (!job) return;
    const name = (await this.repo.getBusinesses(a.job_id)).find((b) => b.business_id === a.business_id)?.name ?? "the business";
    try {
      const p = await this.pay(a.job_id, a.quote_id);
      if (p.status === "settled") await this.notifyHuman(job, `paid:${a.id}`, `Paid ${usdText(a.payment_cents)} to ${name} (Stripe test mode). The receipt is on the deal board.`);
    } catch (err) {
      const reason = err instanceof EngineError ? err.message : (err as Error).message;
      this.log("auto_pay_failed", { job_id: a.job_id, approval_id: a.id, error: reason });
      await this.notifyHuman(job, `pay-failed:${a.id}`, `approved, but the ${usdText(a.payment_cents)} payment to ${name} didn't go through: ${reason.slice(0, 120)}`);
    }
  }

  async pay(jobId: string, quoteId: string): Promise<EnginePaymentStatus> {
    await this.advanceJob(jobId);
    const job = await this.loadJob(jobId);
    const approval = await this.repo.getLatestApproval(jobId);
    if (!approval || approval.quote_id !== quoteId) throw new EngineError("no_approval", "There's no human approval for that quote.", "Call approve(job_id, quote_id) first; the human must confirm.", "approve");
    if (approval.status === "pending") return { ...this.noPayment(), reason: "the human hasn't approved yet" };
    if (approval.status === "declined" || approval.status === "expired" || approval.status === "locked") throw new EngineError("approval_" + approval.status, `The approval was ${approval.status}.`, "Request a new approval.", "approve");
    if (approval.action === "confirm") throw new EngineError("confirm_only", "The human approved confirming this order, not a payment: nothing to pay.", "Done: the business was told to go ahead. Call approve with action 'pay' for a payment.", "get_quotes");
    if (job.state !== "paying" && job.state !== "paid") throw new EngineError("not_payable", `Job is ${job.state}.`, "Wait for approval.", "wait_for_update");
    if (!job.pay_intent) await this.repo.touchJob(jobId, { pay_intent: true });
    if (this.d.stripe) {
      const { refused } = await this.processStripePayment(jobId);
      if (refused) throw stripeRefusal(refused);
      await this.advanceJob(jobId); // a settled charge moves the job to paid
      const p = await this.repo.getPaymentForJob(jobId);
      if (!p) throw new EngineError("payment_not_started", "The payment didn't start.", "Call get_quotes to check the job, then pay again.", "get_quotes");
      return paymentStatus(p);
    }
    const p0 = await this.repo.getPaymentForJob(jobId);
    if (p0?.status === "expired") {
      // The invoice expired before payment: ask once more for a fresh one (bounded by the idempotency key).
      const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === p0.business_id)!;
      const again = await this.repo.transitionPayment(p0.id, ["expired"], { status: "awaiting_invoice", challenge_json: null, challenge_step_id: null });
      if (again) await this.sendRecorded(job, b, "accept", `reissue:${p0.id}`, { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true, bodyText: `Hi ${b.name},\n\nThe payment request expired before we could pay it. Could you send a fresh one in this thread?` });
    }
    await this.d.onTick?.();
    await this.advanceJob(jobId);
    const p = await this.repo.getPaymentForJob(jobId);
    return p ? paymentStatus(p) : { status: "awaiting_invoice", rail: "x402", network: "base-sepolia", simulated: this.d.payer.simulated };
  }

  // ───────────────────────────── brain-backed (Partner's brain via the contract) ─────────────────────────────

  /** Payment status before any payment row exists (rail-aware). */
  private noPayment(): EnginePaymentStatus {
    return this.d.stripe
      ? { status: "awaiting_approval", rail: "stripe", network: STRIPE_NETWORK, simulated: this.d.stripe.simulated }
      : { status: "awaiting_approval", rail: "x402", network: "base-sepolia", simulated: this.d.payer.simulated };
  }

  /** True when a payment rail can actually charge (Stripe configured, or a signing x402 payer). */
  get paymentsEnabled(): boolean {
    return this.d.stripe !== undefined || !this.d.payer.disabledReason;
  }

  get brainIsStub(): boolean {
    return (this.d.brain as { stub?: boolean }).stub === true;
  }
  async ask(req: Request) {
    const estimates = await this.d.brain.estimate(req);
    return { estimates, note: "estimates, not quotes" as const, brain: this.brainIsStub ? "stub (not learning yet)" : "connected" };
  }
  async discover(category: string, area: string, count: number) {
    return this.d.brain.discover(category, area, Math.min(Math.max(count, 1), 12));
  }
  async checkPrice(input: Parameters<import("../contract.ts").Brain["checkPrice"]>[0]) {
    return this.d.brain.checkPrice(input);
  }
  async quoteForCheck(jobId: string, quoteId: string) {
    const job = await this.loadJob(jobId);
    const q = await this.repo.getQuote(quoteId);
    if (!q || q.job_id !== jobId || q.total_cents === null) throw new EngineError("quote_not_found", "No priced quote with that id on this job.", "Use a quote_id from get_quotes.", "get_quotes");
    return { business_id: q.business_id, request: { what: job.request.what, quantity: job.request.quantity, area: job.request.area, date: job.request.date }, total_usd: centsToUsd(q.total_cents) };
  }
  get mode() {
    return this.d.config.mode;
  }

  /** True when a Voice AI phone port is configured (mock: simulated calls). */
  /** Whether the iMessage approval request for this approval was actually sent. */
  async approvalIMessageSent(approvalId: string): Promise<boolean> {
    return (await this.repo.findMessageByIdempotencyKey(`imsg:${sendKeys.approvalRequest(approvalId)}`)) !== null;
  }

  /** True when Haggle can text (SMS from the buyer's number: updates and text approvals). */
  get smsEnabled(): boolean {
    return this.d.sms !== undefined;
  }

  /** True when iMessage approval requests can be sent (live: HAGGLE_ENABLE_IMESSAGE). */
  get imessageEnabled(): boolean {
    return this.d.imessage !== undefined;
  }

  /** True when A2A tasks can be sent to agent-ready businesses. */
  get a2aEnabled(): boolean {
    return this.d.a2a !== undefined;
  }

  get phoneEnabled(): boolean {
    return this.d.phone !== undefined;
  }

  /**
   * Learned profile for a business (id, slug or name). The frozen Brain contract has no read
   * method yet, so this uses an optional `getProfile` on the brain when present (proposed for
   * contracts.ts); otherwise null = not learned.
   */
  async businessProfile(ref: string, workspaceId?: string): Promise<{ profile: Profile | null; business: Business | null }> {
    const needle = ref.trim().toLowerCase();
    const known = await this.knownBusinesses("", 50, workspaceId);
    const business = known.find((b) => b.business_id === needle || b.slug === needle || b.name.toLowerCase() === needle || b.email === needle) ?? null;
    const reader = this.d.brain as Partial<ProfileReader>;
    if (typeof reader.getProfile !== "function") return { profile: null, business };
    const profile = await reader.getProfile(business?.business_id ?? needle);
    return { profile, business };
  }

  /** Businesses the brain knows (for @-mentions); empty when the brain has none. */
  async knownBusinesses(query: string, limit = 8, workspaceId?: string): Promise<Business[]> {
    const q = query.trim().toLowerCase();
    // Businesses from this workspace's own deals; plus the stub's demo fleet (never a real brain's
    // discover(), which may search the web).
    const seen = new Map<string, Business>();
    for (const job of await this.repo.listRecentJobs(50, workspaceId)) {
      for (const b of await this.repo.getBusinesses(job.id)) {
        if (!seen.has(b.business_id)) seen.set(b.business_id, { business_id: b.business_id, slug: slugify(b.name), name: b.name, email: b.email ?? "", source: b.source, simulated: b.simulated });
      }
    }
    if (this.brainIsStub) for (const b of await this.d.brain.discover("", "", 12).catch(() => [] as Business[])) if (!seen.has(b.business_id)) seen.set(b.business_id, b);
    const known = [...seen.values()];
    return known.filter((b) => !q || b.name.toLowerCase().includes(q) || b.slug.includes(q)).slice(0, limit);
  }

  // ───────────────────────────── launcher + settings ─────────────────────────────

  /** Most relevant job for the launcher: newest open job, else the newest job (in one workspace when given). */
  async latestJob(workspaceId?: string): Promise<JobRow | null> {
    const recent = await this.repo.listRecentJobs(20, workspaceId);
    return recent.find((j) => !TERMINAL.has(j.state)) ?? recent[0] ?? null;
  }

  async getSettings(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<SettingsRow> {
    return (await this.repo.getSettings(workspaceId)) ?? {
      spending_cap_cents: this.d.config.defaultSpendingCapCents ?? 150_000, approver_phone: null, approver_email: null, default_area: null, updated_at: new Date(0).toISOString(),
    };
  }

  /** Settings change only through this call (settings tools / native settings UI), never from business mail. */
  async updateSettings(patch: Partial<Omit<SettingsRow, "updated_at">>, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<SettingsRow> {
    const cur = await this.getSettings(workspaceId);
    const next = { ...cur, ...patch };
    const ceiling = this.d.config.spendingCapCeilingCents ?? 500_000;
    if (!Number.isInteger(next.spending_cap_cents) || next.spending_cap_cents <= 0) throw new EngineError("bad_cap", "The spending cap must be a positive amount.", "Pass a positive spending cap.", "settings");
    if (next.spending_cap_cents > ceiling) throw new EngineError("cap_above_ceiling", `The spending cap can't exceed $${centsToUsd(ceiling).toFixed(2)} on this server.`, "Pick a lower cap; the operator sets the ceiling.", "settings");
    if (next.approver_phone && !E164_RE.test(next.approver_phone)) throw new EngineError("bad_phone", "Approver phone must be E.164, e.g. +14155550123.", "Fix the approver phone.", "settings");
    if (next.approver_email && !EMAIL_RE.test(next.approver_email)) throw new EngineError("bad_email", "Approver email is not an email address.", "Fix the approver email.", "settings");
    const { updated_at: _u, ...row } = next;
    return this.repo.saveSettings({ ...row, approver_email: row.approver_email ? normalizeAddress(row.approver_email) : null }, workspaceId);
  }

  /**
   * Approve from the approval view: the human taps Approve, and the view sends back the code it
   * received in the tool result's view-only `_meta` (never in model-visible content). Only an app
   * tool calls this; the model never sees the code.
   */
  async approveWithViewCode(approvalId: string, code: string): Promise<{ status: ApprovalRow["status"]; approval: ApprovalRow }> {
    const a = await this.repo.getApproval(approvalId);
    // The approval card works for card approvals and as the fallback for iMessage approvals.
    if (!a || (a.channel !== "view" && a.channel !== "imessage")) throw new EngineError("approval_not_found", "No approval waiting on the approval view.", "Call approve(job_id, quote_id) to start one.", "approve");
    if (a.status !== "pending") return { status: a.status, approval: a };
    const okCode = code.length === a.code.length && timingSafeEqual(Buffer.from(code), Buffer.from(a.code));
    if (!okCode) {
      // Wrong codes count; after maxApprovalAttempts the approval locks and can't be approved.
      const max = this.d.config.maxApprovalAttempts ?? DEFAULT_MAX_APPROVAL_ATTEMPTS;
      const w = await this.repo.recordWrongApprovalCode(a.id, max);
      if (w?.locked) {
        await this.repo.appendEvent(a.job_id, "approval_locked", { approval_id: a.id, attempts: w.attempts });
        await this.advanceJob(a.job_id);
        throw new EngineError("approval_locked", "Too many wrong approval codes: this approval is locked.", "Start a fresh approval with approve(job_id, quote_id).", "approve");
      }
      throw new EngineError("bad_code", `That approval code doesn't match (${Math.max(0, max - (w?.attempts ?? 0))} attempts left).`, "Approve from the approval card shown to the human.", "approve");
    }
    await this.decideApproval(a.id, "approve", "view", "human (approval view)");
    const after = (await this.repo.getApproval(a.id))!;
    return { status: after.status, approval: after };
  }

  async cancel(jobId: string) {
    const job = await this.loadJob(jobId);
    if (job.state === "cancelled") return { ok: true as const, state: job.state };
    const r = await this.fire(jobId, { type: "cancelled" });
    if (!r.ok) throw new EngineError("cannot_cancel", r.reason ?? "conflict", job.state === "paid" ? "Settled payments can't be reversed." : "Wait for the payment to resolve.", "wait_for_update");
    return { ok: true as const, state: "cancelled" as JobState };
  }
}

export class RetryLater extends Error {
  override name = "RetryLater";
}

/**
 * The engine as one workspace sees it: every job, approval and setting is scoped to the workspace
 * the MCP connection authenticated as. Another workspace's job_id or approval_id reads as "not
 * found" (never "forbidden"), so ids can't be probed. The MCP tools only ever use this view.
 */
export class WorkspaceEngine {
  readonly engine: HaggleEngine;
  readonly workspaceId: string;
  constructor(engine: HaggleEngine, workspaceId: string) {
    this.engine = engine;
    this.workspaceId = workspaceId;
  }

  private async own(jobId: string): Promise<JobRow> {
    const job = await this.engine.loadJob(jobId);
    if (job.workspace_id !== this.workspaceId) throw new EngineError("job_not_found", `No job ${jobId}.`, "Check the job_id returned by deal.", "deal");
    return job;
  }
  private async ownApproval(approvalId: string) {
    const a = await this.engine.approvalById(approvalId);
    if (!a || (await this.engine.loadJob(a.job_id).catch(() => null))?.workspace_id !== this.workspaceId) throw new EngineError("approval_not_found", "No such approval.", "Call approve(job_id, quote_id) to start one.", "approve");
    return a;
  }

  get mode() { return this.engine.mode; }
  get imessageEnabled() { return this.engine.imessageEnabled; }
  get smsEnabled() { return this.engine.smsEnabled; }
  get a2aEnabled() { return this.engine.a2aEnabled; }
  get phoneEnabled() { return this.engine.phoneEnabled; }
  get paymentsEnabled() { return this.engine.paymentsEnabled; }
  get brainIsStub() { return this.engine.brainIsStub; }

  deal(input: DealInput) { return this.engine.deal({ ...input, workspace_id: this.workspaceId }); }
  async loadJob(jobId: string) { return this.own(jobId); }
  async waitForUpdate(jobId: string, cursor: number, timeoutMs: number, signal?: AbortSignal, until?: WaitUntil) { await this.own(jobId); return this.engine.waitForUpdate(jobId, cursor, timeoutMs, signal, until); }
  async getQuotes(jobId: string) { await this.own(jobId); return this.engine.getQuotes(jobId); }
  async answerSeller(jobId: string, questionId: string, answer: string) { await this.own(jobId); return this.engine.answerSeller(jobId, questionId, answer); }
  async sendMessage(jobId: string, businessId: string, opts: Parameters<HaggleEngine["sendMessage"]>[2]) { await this.own(jobId); return this.engine.sendMessage(jobId, businessId, opts); }
  async negotiate(jobId: string, businessIds?: string[]) { await this.own(jobId); return this.engine.negotiate(jobId, businessIds); }
  async getConversation(jobId: string, businessId: string, limit?: number) { await this.own(jobId); return this.engine.getConversation(jobId, businessId, limit); }
  async requestApproval(jobId: string, quoteId: string, channel: ApprovalRow["channel"], action?: ApprovalAction, offer?: ApprovalOffer) { await this.own(jobId); return this.engine.requestApproval(jobId, quoteId, channel, action, offer); }
  async approvalReach(jobId: string) { await this.own(jobId); return this.engine.approvalReach(jobId); }
  async approvalOffers(approvalId: string) { await this.ownApproval(approvalId); return this.engine.approvalOffers(approvalId); }
  async decideApproval(approvalId: string, decision: "approve" | "decline", channel: ApprovalRow["channel"], approver: string | null) { await this.ownApproval(approvalId); return this.engine.decideApproval(approvalId, decision, channel, approver); }
  async approveWithViewCode(approvalId: string, code: string) { await this.ownApproval(approvalId); return this.engine.approveWithViewCode(approvalId, code); }
  async approvalIMessageSent(approvalId: string) { await this.ownApproval(approvalId); return this.engine.approvalIMessageSent(approvalId); }
  async pay(jobId: string, quoteId: string) { await this.own(jobId); return this.engine.pay(jobId, quoteId); }
  async cancel(jobId: string) { await this.own(jobId); return this.engine.cancel(jobId); }
  async quoteForCheck(jobId: string, quoteId: string) { await this.own(jobId); return this.engine.quoteForCheck(jobId, quoteId); }
  async approvalCaveats(jobId: string, quoteId: string) { await this.own(jobId); return this.engine.approvalCaveats(jobId, quoteId); }
  canContact(b: Parameters<HaggleEngine["canContact"]>[0]) { return this.engine.canContact(b); }
  latestJob() { return this.engine.latestJob(this.workspaceId); }
  getSettings() { return this.engine.getSettings(this.workspaceId); }
  updateSettings(patch: Parameters<HaggleEngine["updateSettings"]>[0]) { return this.engine.updateSettings(patch, this.workspaceId); }
  knownBusinesses(query: string, limit?: number) { return this.engine.knownBusinesses(query, limit, this.workspaceId); }
  businessProfile(ref: string) { return this.engine.businessProfile(ref, this.workspaceId); }
  identity() { return this.engine.identity(this.workspaceId); }
  ask(req: Request) { return this.engine.ask(req); }
  discover(category: string, area: string, count: number) { return this.engine.discover(category, area, count); }
  checkPrice(input: Parameters<HaggleEngine["checkPrice"]>[0]) { return this.engine.checkPrice(input); }
}

const STRIPE_REFUSALS: Record<StripeGuardCode, [string, string, string]> = {
  PAYMENT_DISABLED: ["Payments aren't enabled on this server (Stripe test mode is not configured). Nothing was charged.", "Ask the operator to enable Stripe test mode.", "get_quotes"],
  APPROVAL_NOT_FOUND: ["There's no human approval for this payment.", "Call approve(job_id, quote_id); the human must confirm.", "approve"],
  PAYMENT_IN_FLIGHT: ["A payment for this approval is already in progress.", "Call wait_for_update until it settles.", "wait_for_update"],
  APPROVAL_PENDING: ["The human hasn't approved yet.", "Call wait_for_update, then pay again.", "wait_for_update"],
  APPROVAL_DECLINED: ["The human declined this quote.", "Pick another quote.", "get_quotes"],
  APPROVAL_EXPIRED: ["The approval expired or was already used.", "Call approve again for a fresh approval.", "approve"],
  QUOTE_CHANGED: ["The quote changed after the human approved it.", "Call get_quotes, then approve the current quote.", "get_quotes"],
  AMOUNT_MISMATCH: ["The amount no longer matches what the human approved.", "Call get_quotes, then approve again.", "get_quotes"],
  OVER_SPEND_CAP: ["The deposit is over the spending cap.", "Lower the deposit with the business, or raise the cap in settings.", "get_quotes"],
  JOB_NOT_READY: ["The job is not ready to pay.", "Call get_quotes to see its state.", "get_quotes"],
  PAYEE_NOT_QUOTED: ["The payee isn't a business that quoted on this job from a verified sender.", "Pick a compliant quote from get_quotes.", "get_quotes"],
};

function stripeRefusal(code: StripeGuardCode): EngineError {
  const [message, fix, next] = STRIPE_REFUSALS[code];
  return new EngineError(`payment_refused_${code.toLowerCase()}`, message, fix, next);
}

function rejectToFlag(r: string) {
  const m: Record<string, import("../contract.ts").QuoteFlag> = {
    unavailable: "requirement_unmet", unverified_sender: "unverified_sender", external_payment_link: "external_payment_link", prompt_injection: "prompt_injection",
    requirement_unmet: "requirement_unmet", missing_info: "requirement_unknown", no_total: "vague_price", over_budget: "over_budget", not_current: "expired",
  };
  return m[r] ?? "low_confidence";
}

/** Contract ApprovalRecord, except `channel` reports the real human channel (incl. v5 view / iMessage). */
export type EngineApprovalRecord = Omit<ApprovalRecord, "channel"> & { channel: ApprovalRow["channel"]; status: ApprovalRow["status"]; action: ApprovalRow["action"]; attempts: number };

function approvalRecord(a: ApprovalRow, job: JobRow): EngineApprovalRecord {
  return {
    approval_id: a.id, job_id: a.job_id, quote_id: a.quote_id, quote_total_usd: centsToUsd(a.quote_total_cents), payment_usd: centsToUsd(a.payment_cents),
    cap_usd: centsToUsd(a.cap_cents), approver: a.approver ?? (a.channel === "simulated" ? "DEMO simulated human" : job.approver_email ?? "unknown"),
    channel: a.channel, status: a.status, approved_at: a.decided_at ?? "", expires_at: a.expires_at, action: a.action, attempts: a.attempts,
  };
}

/**
 * Contract PaymentStatus widened for the v5 Stripe rail (shared contracts stay untouched):
 * rail + network "stripe-test", status "charging", the PaymentIntent and a test-dashboard receipt.
 */
export type EnginePaymentStatus = Omit<PaymentStatus, "status" | "network"> & {
  status: PaymentStatus["status"] | "charging";
  rail: PaymentRow["rail"];
  network: PaymentRow["network"];
  payment_intent_id?: string;
  receipt_url?: string;
};

export function paymentStatus(p: PaymentRow): EnginePaymentStatus {
  if (p.rail === "stripe") {
    const s: EnginePaymentStatus = { status: p.status === "charging" ? "charging" : (p.status as PaymentStatus["status"]), rail: "stripe", network: "stripe-test", amount_usd: centsToUsd(p.amount_cents), simulated: p.simulated };
    if (p.stripe_payment_intent_id) {
      s.payment_intent_id = p.stripe_payment_intent_id;
      if (p.status === "settled" && !p.simulated) s.receipt_url = `https://dashboard.stripe.com/test/payments/${p.stripe_payment_intent_id}`;
    }
    if (p.reason) s.reason = p.reason;
    return s;
  }
  const s: EnginePaymentStatus = { status: p.status as PaymentStatus["status"], rail: "x402", amount_usd: centsToUsd(p.amount_cents), amount_usdc_base_units: p.amount_base_units, network: p.network, simulated: p.simulated };
  if (p.settle_tx) {
    s.settle_tx = p.settle_tx;
    if (!p.simulated && /^0x[0-9a-f]{64}$/i.test(p.settle_tx)) s.explorer_url = `https://sepolia.basescan.org/tx/${p.settle_tx}`;
  }
  if (p.reason) s.reason = p.reason;
  return s;
}

function toUpdate(e: { type: string; data: Record<string, unknown> }): JobUpdate | null {
  const d = e.data;
  switch (e.type) {
    case "reply":
      return { type: "reply", business_id: String(d.business_id ?? ""), summary: String(d.summary ?? "") };
    case "quote":
      return d.total_usd === null ? null : { type: "quote", quote_id: String(d.quote_id), business_id: String(d.business_id), total_usd: Number(d.total_usd), round: Number(d.round) };
    case "question":
      return { type: "question", question_id: String(d.question_id), business_id: String(d.business_id), text: String(d.text) };
    case "flag":
      return { type: "flag", business_id: String(d.business_id ?? ""), flag: d.flag as import("../contract.ts").QuoteFlag };
    case "state":
      return d.from ? { type: "state", from: d.from as JobState, to: d.to as JobState } : null;
    case "payment":
      return typeof d.status === "string" && ["awaiting_approval", "awaiting_invoice", "invoice_received", "signed", "sent", "settled", "rejected", "expired", "failed"].includes(d.status) ? { type: "payment", status: d.status as PaymentStatus["status"] } : null;
    default:
      return null;
  }
}
