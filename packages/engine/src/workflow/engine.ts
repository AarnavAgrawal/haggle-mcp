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
import { timingSafeEqual } from "node:crypto";
import type {
  ApprovalRecord, Business, DealResult, JobState, JobUpdate, PaymentStatus, Profile, Quote, QuotesResult, Request, WaitResult,
} from "../contract.ts";
import { businessIdForContact, newApprovalCode, newId, newShortCode, slugify } from "../ids.ts";
import { matchInbound, jobInboxAddress, jobInboxCode, normalizeAddress, subjectShortCode } from "../inbound/matching.ts";
import type { InboundMessage, TrustVerdict } from "../inbound/primitive.ts";
import { centsToUsd, usdToCents, centsToUsdcBaseUnits } from "../money.ts";
import { planCounteroffers } from "../negotiation/counteroffer.ts";
import { buildRfqEmail } from "../outbound/rfq.ts";
import { sendKeys, type OutboundAttachment } from "../outbound/primitiveSender.ts";
import { evaluateRequirements, meetsHardRequirements, type EngineRequirement } from "../parsing/requirements.ts";
import { validateQuote } from "../parsing/validate.ts";
import { verifyApproval } from "../approvals/verifyApproval.ts";
import { parseChallengePart, preparePayment } from "../payments/x402Challenge.ts";
import { rankQuotes, rejectReason, type RankableQuote } from "../ranking/rank.ts";
import type { ApprovalRow, Channel, JobBusinessRow, JobRow, MessageRow, PaymentRow, QuoteRow, Repository, SettingsRow } from "../store/types.ts";
import { quotePartToExtraction } from "./quotePart.ts";
import { toContractQuote, toEngineRequirement, toParsedReply } from "./mapping.ts";
import { start, TERMINAL, transition, type Effect, type JobEvent, type MachineState } from "./stateMachine.ts";
import type { EngineDeps } from "./ports.ts";

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
  payment: PaymentStatus | null;
  ready: boolean;
  inbox: string;
  request: Request;
  budget_usd: number | null;
};

const REJECT_TEXT: Record<import("../ranking/rank.ts").RejectReason, string> = {
  not_current: "superseded by a newer quote", unavailable: "the business declined", unverified_sender: "sender could not be verified",
  external_payment_link: "asked for payment through an external link (blocked)", prompt_injection: "contained instructions aimed at the agent (ignored)",
  requirement_unmet: "does not meet every hard requirement", no_total: "no exact total yet", over_budget: "over the budget",
};

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const jsonPart = (filename: string, o: unknown): OutboundAttachment => ({ filename, contentType: "application/json", content: enc(o) });

export class HaggleEngine {
  private readonly d: EngineDeps;
  constructor(d: EngineDeps) {
    this.d = d;
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
    if (input.client_request_id) {
      const existing = await this.repo.findJobByClientRequestId(input.client_request_id);
      if (existing) return this.dealResult(existing);
    }
    if (input.businesses.length === 0) throw new EngineError("no_businesses", "No businesses to contact.", "Pass businesses[] (name + email or phone), or call discover first.", "discover");
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
      const blocked = [email, phone].find((c) => c !== null && !this.allowedRecipient(c));
      if (blocked) throw new EngineError("recipient_not_allowed", `${b.name} (${blocked}) isn't on this server's list of businesses it may contact.`, "Use the simulated demo businesses from discover, or ask the operator to add it to HAGGLE_ALLOWED_RECIPIENTS.", "discover");
      for (const key of [email, phone].filter((k): k is string => k !== null)) {
        if (seen.has(key)) throw new EngineError("duplicate_business", `Listed twice: ${key}`, "Remove the duplicate.", "deal");
        seen.add(key);
      }
      return { b, email, phone, card, ...this.route({ email, phone, card }) };
    });
    if (!planned.some((p) => p.reachable)) {
      throw new EngineError("no_usable_channel", "None of these businesses can be reached: phone and A2A outreach aren't enabled in this deployment.", "Give at least one business an email address.", "deal");
    }
    const budgetCents = input.budget_usd === undefined ? null : usdToCents(input.budget_usd);
    if (budgetCents !== null && budgetCents <= 0) throw new EngineError("bad_budget", "budget_usd must be positive.", "Pass a positive budget_usd or omit it.", "deal");
    const replyBy = input.reply_by ? new Date(input.reply_by) : new Date(this.now().getTime() + this.d.config.collectionWindowMs);
    if (Number.isNaN(replyBy.getTime()) || replyBy <= this.now()) throw new EngineError("bad_deadline", "reply_by must be a future ISO time.", "Pass a future reply_by or omit it.", "deal");

    let job: JobRow | null = null;
    for (let i = 0; i < 5 && !job; i++) {
      const code = newShortCode();
      const at = this.now().toISOString();
      try {
        job = await this.repo.insertJob({
          id: newId("job"), short_code: code, state: "created", mode, request: input.request, budget_cents: budgetCents,
          payment_cap_cents: this.d.config.globalPaymentCapCents, approver_email: input.approver_email ? normalizeAddress(input.approver_email) : null,
          inbox: this.d.config.sharedInbox ?? jobInboxAddress(code, this.d.config.inboxDomain), round: 1, max_rounds: Math.min(input.max_rounds ?? this.d.config.maxRounds, 2),
          collect_until: replyBy.toISOString(), ready: false, pay_intent: false, failure_reason: null,
          client_request_id: input.client_request_id ?? null, version: 0, created_at: at, updated_at: at,
        });
      } catch (e) {
        if (input.client_request_id && String(e).includes("client_request_id")) {
          const existing = await this.repo.findJobByClientRequestId(input.client_request_id);
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
    })));
    await this.repo.appendEvent(job.id, "state", { from: null, to: "created" });
    for (const p of planned.filter((x) => !x.reachable)) {
      await this.repo.appendEvent(job.id, "reply", { business_id: businessIdForContact({ email: p.email, phone: p.phone, a2a_card_url: p.card }), summary: `${p.b.name} not contacted: ${p.reason}` });
    }
    const started = start(this.machine(job));
    if (started.ok) await this.commit(job, started.next, started.effects, "deal");
    // RFQs are sent by the effect (synchronously here, like quote-broker); the job is returned at once.
    return this.dealResult((await this.repo.getJob(job.id))!);
  }

  private async dealResult(job: JobRow): Promise<EngineDealResult> {
    const businesses = await this.repo.getBusinesses(job.id);
    return {
      ok: true, mode: job.mode, job_id: job.id, inbox: job.inbox, state: job.state,
      contacted: businesses.filter((b) => b.contacted_at).map((b) => ({ business_id: b.business_id, business: b.name, simulated: b.simulated, channel: b.channel })),
      not_contacted: businesses.filter((b) => !b.contacted_at).map((b) => ({ business_id: b.business_id, business: b.name, channel: b.channel, reason: b.status === "unavailable" ? this.route(b).reason : b.status === "bounced" ? "send failed" : "pending" })),
      eta: `replies usually within minutes; collecting until ${job.collect_until}`,
      next: "Call wait_for_update with this job_id (timeout_s up to 60). Don't email the businesses yourself.",
    };
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
  private route(c: { email: string | null; phone: string | null; card?: string | null; a2a_card_url?: string | null }): { channel: Channel; reachable: boolean; reason: string } {
    const card = c.card ?? c.a2a_card_url ?? null;
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
    const rankable = quotes.map((q): RankableQuote => ({
      quoteId: q.id, businessId: q.business_id, totalCents: q.total_cents, available: q.record.available, compliant: q.compliant,
      senderTrusted: q.sender_trusted, status: q.status, confidence: q.record.confidence, flags: q.record.flags,
    }));
    return { quotes, rankable, ranking: rankQuotes(rankable, job.budget_cents) };
  }

  private async context(job: JobRow) {
    const { rankable, ranking } = await this.rankRows(job);
    const businesses = await this.repo.getBusinesses(job.id);
    const plan = this.counterPlan(job, rankable, businesses);
    const payment = await this.repo.getPaymentForJob(job.id);
    return {
      now: this.now(), eligibleQuotes: ranking.ranked.length, counterable: plan.length > 0,
      negotiationWindowMs: this.d.config.negotiationWindowMs, paymentInFlight: payment !== null && ["signed", "sent"].includes(payment.status),
    };
  }

  /**
   * Honest counteroffers. Every eligible quote (any channel) can be the cited basis, but only
   * businesses reachable by email get a counter: there is no in-call negotiation yet.
   */
  private counterPlan(job: JobRow, rankable: RankableQuote[], businesses: JobBusinessRow[]) {
    const byId = new Map(businesses.map((b) => [b.business_id, b]));
    return planCounteroffers(
      rankable.map((r) => ({ ...r, businessName: byId.get(r.businessId)?.name ?? "there", round: this.quoteRound(r.quoteId) })),
      new Date(job.collect_until), job.max_rounds, job.budget_cents,
    ).filter((c) => byId.get(c.businessId)?.email);
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
    if (updated.ready && !job.ready) await this.repo.appendEvent(job.id, "ready", { round: updated.round });
    for (const e of effects) await this.runEffect(updated, e);
    return updated;
  }

  async fire(jobId: string, event: JobEvent, cause = event.type): Promise<{ ok: boolean; reason?: string; job?: JobRow }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const job = await this.repo.getJob(jobId);
      if (!job) return { ok: false, reason: "job not found" };
      await this.refreshRounds(job);
      const r = transition(this.machine(job), event, await this.context(job));
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
    else if (e.type === "send_counteroffers") await this.sendCounteroffers(job, e.round);
    else if (e.type === "send_accept") await this.sendAccept(job);
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
    const reqs = job.request.requirements.filter((r) => r.hard).map((r) => r.text);
    for (const b of await this.repo.getBusinesses(job.id)) {
      if (b.status !== "pending") continue;
      if (b.channel === "phone") {
        await this.placeRfqCall(job, b);
        continue;
      }
      if (!b.email) continue;
      const email = buildRfqEmail({
        shortCode: job.short_code, businessName: b.name, what: job.request.what, quantity: job.request.quantity, date: job.request.date,
        location: job.request.area, requirements: reqs, replyBy: new Date(job.collect_until),
      });
      const rfq = {
        haggle: "rfq/1", job_id: job.id, what: job.request.what, quantity: job.request.quantity, ...(job.request.unit ? { unit: job.request.unit } : {}),
        date: job.request.date, location: job.request.area,
        requirements: job.request.requirements.map((r) => ({ id: r.id, text: r.text, hard: r.hard, ...(r.min_count !== undefined ? { min_count: r.min_count } : {}) })),
        reply_by: job.collect_until, reply_to: job.inbox,
      };
      try {
        const m = await this.sendRecorded(job, b, "rfq", sendKeys.rfq(job.id, b.business_id), { to: b.email, ...email, attachments: [jsonPart("rfq.json", rfq)] });
        await this.repo.updateBusiness(job.id, b.business_id, { status: "contacted", contacted_at: this.now().toISOString(), rfq_message_id: m?.rfc_message_id ?? null, references: m?.rfc_message_id ? [m.rfc_message_id] : [] });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `RFQ sent to ${b.name}` });
      } catch (err) {
        await this.repo.updateBusiness(job.id, b.business_id, { status: "bounced" });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `RFQ to ${b.name} failed: ${(err as Error).name}` });
        this.log("rfq_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
      }
    }
    await this.fire(job.id, { type: "rfqs_sent" });
  }

  /** Voice AI call to a phone-only business. Recorded once (idempotency key) like an RFQ email. */
  private async placeRfqCall(job: JobRow, b: JobBusinessRow) {
    const key = `call:${job.id}:${b.business_id}`;
    if (!this.d.phone || !b.phone) {
      await this.repo.updateBusiness(job.id, b.business_id, { status: "unavailable" });
      return;
    }
    if (await this.repo.findMessageByIdempotencyKey(key)) return;
    const reqs = job.request.requirements.filter((r) => r.hard).map((r) => r.text);
    const reason = [
      `You are an AI assistant calling on behalf of a customer to request a price quote. Say you are an AI assistant at the start of the call.`,
      `Ask ${b.name} for a quote for: ${job.request.what}, ${job.request.quantity} ${job.request.unit ?? "people"}, on ${job.request.date}, in ${job.request.area}.`,
      reqs.length ? `Requirements: ${reqs.join("; ")}.` : "",
      `Ask for the all-in total, any deposit, and what is included. Do not agree to buy or pay anything, and do not share payment details. Reference code HG-${job.short_code}.`,
    ].filter(Boolean).join(" ").slice(0, 2000);
    try {
      const { callId } = await this.d.phone.placeCall({ jobId: job.id, businessId: b.business_id, toNumber: b.phone, reason, idempotencyKey: key });
      await this.repo.insertMessage({
        job_id: job.id, business_id: b.business_id, approval_id: null, direction: "out", kind: "call", channel: "phone", provider_email_id: callId, idempotency_key: key,
        rfc_message_id: null, thread_id: null, from_address: job.inbox, to_address: b.phone, subject: null, body_text: reason, attachments: [], attachments_download_url: null,
        sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: 1, simulated: job.mode === "mock",
      });
      await this.repo.updateBusiness(job.id, b.business_id, { status: "ringing", contacted_at: this.now().toISOString() });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Calling ${b.name} (Voice AI)` });
    } catch (err) {
      await this.repo.updateBusiness(job.id, b.business_id, { status: "bounced" });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call to ${b.name} failed: ${(err as Error).name}` });
      this.log("call_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
    }
  }

  /**
   * One call-ended result (Inkbox `call.ended`, or the simulated fleet). Matched by the call id we
   * recorded when placing the call, so only calls Haggle placed to the pinned number count. The
   * transcript is untrusted data, parsed like an email body. Idempotent per call id.
   */
  async ingestCall(call: { callId: string; outcome: "completed" | "no_answer" | "declined" | "failed"; transcript: string; endedAt?: string; simulated?: boolean }): Promise<{ jobId: string | null; outcome: string }> {
    const placed = await this.repo.findMessageByProviderId(call.callId);
    if (!placed || placed.kind !== "call" || placed.direction !== "out" || !placed.job_id || !placed.business_id) return { jobId: null, outcome: "unknown_call" };
    const job = await this.repo.getJob(placed.job_id);
    const b = (await this.repo.getBusinesses(placed.job_id)).find((x) => x.business_id === placed.business_id);
    if (!job || !b) return { jobId: null, outcome: "unknown_call" };
    const transcript = call.transcript.trim().slice(0, 20_000);
    const completed = call.outcome === "completed" && transcript.length > 0;
    const stored = await this.repo.insertMessage({
      job_id: job.id, business_id: b.business_id, approval_id: null, direction: "in", kind: "reply", channel: "phone", provider_email_id: `call-ended:${call.callId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: b.phone, to_address: job.inbox, subject: null, body_text: transcript || null, attachments: [], attachments_download_url: null,
      // Trusted: Haggle placed this call to the business's pinned number (not caller ID on an inbound call).
      sender_trusted: true, trust_reason: "outbound-call-to-pinned-number", matched_via: "call_id", parse_status: completed ? "pending" : "none", quarantine_reason: null,
      round: null, simulated: call.simulated ?? false,
    });
    if (!stored) return { jobId: job.id, outcome: "duplicate" };
    if (TERMINAL.has(job.state)) return { jobId: job.id, outcome: "job_closed" };
    await this.repo.updateBusiness(job.id, b.business_id, completed ? { status: "replied", last_reply_at: this.now().toISOString() } : { status: call.outcome === "declined" ? "declined" : "no_reply" });
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call with ${b.name} ended: ${call.outcome}`, channel: "phone", transcript_snippet: transcript.slice(0, 160) });
    await this.repo.touchJob(job.id);
    return { jobId: job.id, outcome: completed ? "stored" : `call:${call.outcome}` };
  }



  private async sendCounteroffers(job: JobRow, round: number) {
    await this.refreshRounds(job);
    const { rankable } = await this.rankRows(job);
    const businesses = await this.repo.getBusinesses(job.id);
    const byId = new Map(businesses.map((b) => [b.business_id, b]));
    const plan = this.counterPlan(job, rankable, businesses);
    let sent = 0;
    for (const c of plan) {
      const b = byId.get(c.businessId);
      if (!b) continue;
      const counter = { haggle: "counter/1", job_id: job.id, round: c.round, target_total_usd: centsToUsd(c.targetTotalCents), basis: "competing_quote", basis_quote_total_usd: centsToUsd(c.targetTotalCents) };
      try {
        await this.sendRecorded(job, b, "counter", sendKeys.counter(job.id, b.business_id, c.round), {
          to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, bodyText: c.text, attachments: [jsonPart("counter.json", counter)], inThread: true, round: c.round,
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
    const quote = await this.repo.getQuote(approval.quote_id);
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === approval.business_id);
    if (!quote || !b) return;
    await this.repo.insertPayment({
      id: newId("pay"), job_id: job.id, approval_id: approval.id, business_id: b.business_id, status: "awaiting_invoice",
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

  private async notifyCancelled(job: JobRow) {
    const pending = await this.repo.getLatestApproval(job.id);
    if (pending?.status === "pending") await this.repo.transitionApproval(pending.id, "pending", { status: "expired", decided_at: this.now().toISOString() });
    for (const b of await this.repo.getBusinesses(job.id)) {
      if (!["replied", "quoted", "question", "declined"].includes(b.status) || !b.last_inbound_message_id) continue;
      try {
        await this.sendRecorded(job, b, "cancel", sendKeys.cancel(job.id, b.business_id), {
          to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true,
          bodyText: `Hi ${b.name},\n\nThank you for your quote. The client has cancelled this request, so we won't be moving forward. Thanks for your time.`,
        });
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
      const stored = await this.repo.insertMessage({ ...base, job_id: job.id, business_id: null, approval_id: approval.id, kind: "approval_reply", sender_trusted: trust.trusted, trust_reason: trust.reason, matched_via: match.via, parse_status: "none", quarantine_reason: null });
      if (!stored) return { jobId: job.id, outcome: "duplicate" };
      if (!approval.thread_id && msg.threadId) await this.repo.updateApproval(approval.id, { thread_id: msg.threadId });
      const v = verifyApproval({ ...approval, approver_email: job.approver_email }, { from: msg.from, senderTrusted: trust.trusted, threadMatched: true, bodyText: msg.bodyText }, this.now());
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
      ...(b.status === "contacted" || b.status === "question" ? { status: "replied" as const } : {}),
    });
    await this.repo.appendEvent(b.job_id, "reply", { business_id: b.business_id, summary: `Email from ${b.name}${trust.trusted ? "" : " (sender NOT verified)"}` });
    await this.repo.touchJob(b.job_id);
    return { jobId: b.job_id, outcome: "stored" };
  }

  // ───────────────────────────── advance ─────────────────────────────

  async advanceJob(jobId: string): Promise<void> {
    const first = await this.repo.getJob(jobId);
    if (!first || TERMINAL.has(first.state)) return;
    await this.parsePending(first);
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
        const waiting = businesses.filter((b) => b.status === "contacted" || b.status === "replied" || b.status === "question" || b.status === "ringing");
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
      if (!a || a.status === "declined" || a.status === "expired") return { type: "approval_void" };
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
        extraction ??= await this.d.extractor.extract({
          request: { what: job.request.what, date: job.request.date, headcount: job.request.quantity, location: job.request.area,
            dietary: reqs.filter((r) => r.kind === "dietary" && r.need).map((r) => ({ need: r.need!, count: r.min_count ?? 0 })), requirements: job.request.requirements.map((r) => r.text) },
          bodyText: msg.body_text ?? "", pdfs: files.filter((f): f is typeof f & { kind: "pdf" } => f.kind === "pdf"), message: msg,
        });
        await this.storeExtraction(job, b, msg, extraction, qj ? "quote.json" : files.some((f) => f.kind === "pdf") ? "pdf" : "email body");
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
    const record = validateQuote(x, job.request.quantity);
    const results = evaluateRequirements(record, reqs, job.request.quantity);
    const compliant = meetsHardRequirements(results, reqs);
    const prior = (await this.repo.listQuotes(job.id)).filter((q) => q.business_id === b.business_id);
    const priorCurrent = prior.find((q) => q.status === "current");
    const questionIds: string[] = [];
    for (const text of record.questions) {
      const q = await this.repo.insertQuestion({ job_id: job.id, business_id: b.business_id, message_id: msg.id, text });
      questionIds.push(q.id);
      await this.repo.appendEvent(job.id, "question", { question_id: q.id, business_id: b.business_id, text });
    }
    let quoteRow: QuoteRow | null = null;
    if (record.total_cents !== null || !record.available) {
      const source = record.sources.total?.source ?? (kind === "quote.json" ? "quote.json" : kind);
      quoteRow = await this.repo.insertCurrentQuote({
        job_id: job.id, business_id: b.business_id, message_id: msg.id, round: prior.length + 1, record, total_cents: record.total_cents,
        deposit_cents: record.deposit_cents, compliant, requirement_results: results, sender_trusted: msg.sender_trusted === true, source,
      });
      if (quoteRow) {
        this.roundCache.set(quoteRow.id, quoteRow.round);
        await this.repo.appendEvent(job.id, "quote", { quote_id: quoteRow.id, business_id: b.business_id, total_usd: record.total_cents === null ? null : centsToUsd(record.total_cents), round: quoteRow.round });
        for (const f of record.flags) await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: f });
        if (!compliant) await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "requirement_unmet" });
        if (priorCurrent) await this.onRevision(job, priorCurrent);
      }
    } else if (record.questions.length === 0) {
      for (const f of record.flags) await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: f });
      // Vague reply ("~900ish"): ask once for an itemised total instead of guessing a number.
      if (record.available && b.followups_sent < 1 && b.email) {
        try {
          await this.sendRecorded(job, b, "followup", sendKeys.followUp(job.id, b.business_id, 1), {
            to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true,
            bodyText: `Hi ${b.name},\n\nThanks! Could you confirm an exact total for ${job.request.quantity} people, including delivery, and any deposit? We can't compare estimates.`,
          });
          await this.repo.updateBusiness(job.id, b.business_id, { followups_sent: b.followups_sent + 1 });
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Asked ${b.name} for an exact total` });
        } catch (err) {
          this.log("followup_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
        }
      }
    }
    const status = !record.available ? "declined" : quoteRow ? "quoted" : record.questions.length ? "question" : b.followups_sent >= 1 ? "silent" : "replied";
    await this.repo.updateBusiness(job.id, b.business_id, { status });
    // Partner's brain learns from every parsed reply; a brain failure never blocks the deal.
    try {
      const contractQuote = quoteRow ? toContractQuote(quoteRow, b, { budgetCents: job.budget_cents }) : null;
      await this.d.brain.learnFromReply(b.business_id, toParsedReply(x, contractQuote, questionIds), {
        job_id: job.id, business_id: b.business_id, business_email: b.email ?? `tel:${b.phone ?? ""}`, message_id: msg.id, thread_id: msg.thread_id ?? "",
        received_at: msg.created_at, rfq_sent_at: b.contacted_at ?? job.created_at, channel: kind === "quote.json" ? "quote.json" : kind === "pdf" ? "pdf" : "text",
        sender_trusted: msg.sender_trusted === true, sender_trust_reason: msg.trust_reason ?? "unknown", request: job.request, simulated: b.simulated,
      });
    } catch (err) {
      this.log("brain_learn_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
    }
    await this.repo.touchJob(job.id);
  }

  /** A business revised its quote: any approval for the old revision is void. */
  private async onRevision(job: JobRow, old: QuoteRow) {
    const a = await this.repo.getLatestApproval(job.id);
    if (a && a.quote_id === old.id && (a.status === "pending" || a.status === "approved")) {
      const pay = await this.repo.getPaymentForJob(job.id);
      if (pay && ["signed", "sent", "settled"].includes(pay.status)) return; // money already moving; guard protects anyway
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

  async waitForUpdate(jobId: string, cursor: number, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    await this.loadJob(jobId);
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 60_000); // wall-clock: a wait timeout is real time
    for (;;) {
      await this.d.onTick?.();
      await this.advanceJob(jobId);
      const events = await this.repo.listEvents(jobId, cursor);
      const job = (await this.repo.getJob(jobId))!;
      const done = TERMINAL.has(job.state);
      if (events.length > 0 || done || Date.now() >= deadline || signal?.aborted) {
        const updates = events.map(toUpdate).filter((u): u is JobUpdate => u !== null);
        const newCursor = events.length ? events[events.length - 1]!.seq : cursor;
        return { ok: true, mode: job.mode, job_id: jobId, state: job.state, cursor: String(newCursor), updates, timed_out: events.length === 0 && !done, next: await this.nextHint(job) };
      }
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, deadline - Date.now()))));
    }
  }

  private async nextHint(job: JobRow): Promise<string> {
    const pending = (await this.repo.listQuestions(job.id)).filter((q) => q.status === "pending");
    if (TERMINAL.has(job.state)) return job.state === "paid" ? "Done. get_quotes shows the receipt." : `Job ${job.state}${job.failure_reason ? ` (${job.failure_reason})` : ""}.`;
    if (pending.length) return `A business asked a question: answer with answer_business(job_id, question_id='${pending[0]!.id}', answer) or ask the user.`;
    if (job.state === "awaiting_approval") return "Waiting for the human to approve. Call wait_for_update.";
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
      const incomplete = reason === "no_total" || (q.total_cents === null) || cq.requirement_results.some((r) => r.met === null);
      out.push({
        ...cq, total_usd: q.total_cents === null ? null : cq.total_usd, channel: b.channel, eligible: order.has(q.id),
        verdict: order.has(q.id) ? "compliant" : incomplete && reason !== "external_payment_link" && reason !== "prompt_injection" && reason !== "unverified_sender" ? "incomplete" : "rejected",
        ...(reason ? { excluded_reason: REJECT_TEXT[reason] } : {}),
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
      payment: payment ? paymentStatus(payment) : job.state === "awaiting_approval" ? { status: "awaiting_approval", network: "base-sepolia", simulated: this.d.payer.simulated } : null,
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
    const m = await this.sendRecorded(job, b, "answer", sendKeys.answer(q.id), { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true, bodyText: `Hi ${b.name},\n\nThanks for asking. ${text}\n\nCould you send your full quote (total, deposit, delivery) when ready?` });
    if (!(await this.repo.answerQuestion(q.id, text))) throw new EngineError("already_answered", "That question was already answered.", "Wait for the business's quote.", "wait_for_update");
    await this.repo.updateBusiness(jobId, b.business_id, { status: "contacted" });
    await this.repo.appendEvent(jobId, "reply", { business_id: b.business_id, summary: `Answered ${b.name}'s question` });
    await this.repo.touchJob(jobId);
    return { ok: true as const, mode: job.mode, question_id: q.id, sent: true, ...(m?.id ? { message_id: m.id } : {}), next: "Call wait_for_update for their quote." };
  }

  /** Start an approval for one exact quote. The decision comes from a human channel, never from this call. */
  async requestApproval(jobId: string, quoteId: string, channel: ApprovalRow["channel"]): Promise<ApprovalRow> {
    await this.advanceJob(jobId);
    const job = await this.loadJob(jobId);
    if (job.state !== "collecting" && job.state !== "negotiating") {
      const latest = await this.repo.getLatestApproval(jobId);
      if (job.state === "awaiting_approval" && latest?.status === "pending" && latest.quote_id === quoteId) return latest;
      throw new EngineError("not_approvable", `Job is ${job.state}.`, job.state === "paying" ? "Already approved; call pay." : "Wait until quotes are in.", job.state === "paying" ? "pay" : "wait_for_update");
    }
    const q = await this.repo.getQuote(quoteId);
    if (!q || q.job_id !== jobId) throw new EngineError("quote_not_found", "No such quote on this job.", "Use a quote_id from get_quotes.", "get_quotes");
    const reason = rejectReason({ quoteId: q.id, businessId: q.business_id, totalCents: q.total_cents, available: q.record.available, compliant: q.compliant, senderTrusted: q.sender_trusted, status: q.status, confidence: q.record.confidence, flags: q.record.flags }, job.budget_cents);
    if (reason) throw new EngineError("quote_not_eligible", `That quote can't be approved: ${reason}.`, reason === "over_budget" ? "Raise budget_usd or pick another quote." : "Pick a compliant quote from get_quotes.", "get_quotes");
    if (!q.deposit_cents || q.deposit_cents <= 0) throw new EngineError("no_deposit", "This quote has no deposit to pay now.", "Ask the business for deposit terms first.", "get_quotes");
    const cap = Math.min(job.payment_cap_cents, this.d.config.globalPaymentCapCents);
    if (q.deposit_cents > cap) throw new EngineError("over_cap", `Deposit $${centsToUsd(q.deposit_cents).toFixed(2)} is over the $${centsToUsd(cap).toFixed(2)} payment cap.`, "Lower the deposit with the business or raise the cap.", "get_quotes");
    if (channel === "email" && !job.approver_email) throw new EngineError("no_approver", "No approver_email on this job.", "Use a client that supports approval forms, or start the deal with approver_email.", "deal");
    const approval = await this.repo.insertApproval({
      id: newId("ap"), job_id: jobId, quote_id: q.id, business_id: q.business_id, quote_total_cents: q.total_cents!, payment_cents: q.deposit_cents, cap_cents: cap,
      approver: channel === "email" ? job.approver_email : null, channel, status: "pending", code: newApprovalCode(),
      expires_at: new Date(this.now().getTime() + this.d.config.approvalTtlMs).toISOString(), decided_at: null, outbound_message_id: null, thread_id: null,
    });
    if (!approval) throw new EngineError("approval_pending", "An approval is already pending for this job.", "Wait for the human, or let it expire.", "wait_for_update");
    const fired = await this.fire(jobId, { type: "approval_requested" });
    if (!fired.ok) {
      await this.repo.transitionApproval(approval.id, "pending", { status: "expired" });
      throw new EngineError("not_approvable", fired.reason ?? "conflict", "Call get_quotes and try again.", "get_quotes");
    }
    await this.repo.appendEvent(jobId, "approval_requested", { approval_id: approval.id, quote_id: q.id, channel });
    if (channel === "email") await this.sendApprovalEmail(job, approval);
    return (await this.repo.getApproval(approval.id))!;
  }

  private async sendApprovalEmail(job: JobRow, a: ApprovalRow) {
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === a.business_id)!;
    const text = [
      "Your agent picked a quote and needs your OK before paying anything.", "",
      `- Business: ${b.name} (${b.email})`, `- Quote total: $${centsToUsd(a.quote_total_cents).toFixed(2)}`, `- Pay now (deposit): $${centsToUsd(a.payment_cents).toFixed(2)} in test USDC on base-sepolia`,
      `- Expires: ${a.expires_at}`, "", `To approve, reply with: APPROVE ${a.code}`, "To decline, reply with: NO",
    ].join("\n");
    const m = await this.sendRecorded(job, null, "approval_request", sendKeys.approvalRequest(a.id), { to: job.approver_email!, subject: `[HG-${job.short_code}] Approve $${centsToUsd(a.payment_cents).toFixed(2)} deposit to ${b.name}?`, bodyText: text, approvalId: a.id });
    await this.repo.updateApproval(a.id, { outbound_message_id: m?.rfc_message_id ?? null });
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
    }
    return ok;
  }

  async pay(jobId: string, quoteId: string): Promise<PaymentStatus> {
    await this.advanceJob(jobId);
    const job = await this.loadJob(jobId);
    const approval = await this.repo.getLatestApproval(jobId);
    if (!approval || approval.quote_id !== quoteId) throw new EngineError("no_approval", "There's no human approval for that quote.", "Call approve(job_id, quote_id) first; the human must confirm.", "approve");
    if (approval.status === "pending") return { status: "awaiting_approval", network: "base-sepolia", simulated: this.d.payer.simulated, reason: "the human hasn't approved yet" };
    if (approval.status === "declined" || approval.status === "expired") throw new EngineError("approval_" + approval.status, `The approval was ${approval.status}.`, "Request a new approval.", "approve");
    if (job.state !== "paying" && job.state !== "paid") throw new EngineError("not_payable", `Job is ${job.state}.`, "Wait for approval.", "wait_for_update");
    if (!job.pay_intent) await this.repo.touchJob(jobId, { pay_intent: true });
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
    return p ? paymentStatus(p) : { status: "awaiting_invoice", network: "base-sepolia", simulated: this.d.payer.simulated };
  }

  // ───────────────────────────── brain-backed (Partner's brain via the contract) ─────────────────────────────

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
  get phoneEnabled(): boolean {
    return this.d.phone !== undefined;
  }

  /**
   * Learned profile for a business (id, slug or name). The frozen Brain contract has no read
   * method yet, so this uses an optional `getProfile` on the brain when present (proposed for
   * contracts.ts); otherwise null = not learned.
   */
  async businessProfile(ref: string): Promise<{ profile: Profile | null; business: Business | null }> {
    const needle = ref.trim().toLowerCase();
    const known = await this.knownBusinesses("", 50);
    const business = known.find((b) => b.business_id === needle || b.slug === needle || b.name.toLowerCase() === needle || b.email === needle) ?? null;
    const reader = this.d.brain as Partial<ProfileReader>;
    if (typeof reader.getProfile !== "function") return { profile: null, business };
    const profile = await reader.getProfile(business?.business_id ?? needle);
    return { profile, business };
  }

  /** Businesses the brain knows (for @-mentions); empty when the brain has none. */
  async knownBusinesses(query: string, limit = 8): Promise<Business[]> {
    const q = query.trim().toLowerCase();
    // Businesses from this server's own deals; plus the stub's demo fleet (never a real brain's
    // discover(), which may search the web).
    const seen = new Map<string, Business>();
    for (const job of await this.repo.listRecentJobs(50)) {
      for (const b of await this.repo.getBusinesses(job.id)) {
        if (!seen.has(b.business_id)) seen.set(b.business_id, { business_id: b.business_id, slug: slugify(b.name), name: b.name, email: b.email ?? "", source: b.source, simulated: b.simulated });
      }
    }
    if (this.brainIsStub) for (const b of await this.d.brain.discover("", "", 12).catch(() => [] as Business[])) if (!seen.has(b.business_id)) seen.set(b.business_id, b);
    const known = [...seen.values()];
    return known.filter((b) => !q || b.name.toLowerCase().includes(q) || b.slug.includes(q)).slice(0, limit);
  }

  // ───────────────────────────── launcher + settings ─────────────────────────────

  /** Most relevant job for the launcher: newest open job, else the newest job. */
  async latestJob(): Promise<JobRow | null> {
    const recent = await this.repo.listRecentJobs(20);
    return recent.find((j) => !TERMINAL.has(j.state)) ?? recent[0] ?? null;
  }

  async getSettings(): Promise<SettingsRow> {
    return (await this.repo.getSettings()) ?? {
      spending_cap_cents: this.d.config.defaultSpendingCapCents ?? 150_000, approver_phone: null, approver_email: null, default_area: null, updated_at: new Date(0).toISOString(),
    };
  }

  /** Settings change only through this call (settings tools / native settings UI), never from business mail. */
  async updateSettings(patch: Partial<Omit<SettingsRow, "updated_at">>): Promise<SettingsRow> {
    const cur = await this.getSettings();
    const next = { ...cur, ...patch };
    const ceiling = this.d.config.spendingCapCeilingCents ?? 500_000;
    if (!Number.isInteger(next.spending_cap_cents) || next.spending_cap_cents <= 0) throw new EngineError("bad_cap", "The spending cap must be a positive amount.", "Pass a positive spending cap.", "settings");
    if (next.spending_cap_cents > ceiling) throw new EngineError("cap_above_ceiling", `The spending cap can't exceed $${centsToUsd(ceiling).toFixed(2)} on this server.`, "Pick a lower cap; the operator sets the ceiling.", "settings");
    if (next.approver_phone && !E164_RE.test(next.approver_phone)) throw new EngineError("bad_phone", "Approver phone must be E.164, e.g. +14155550123.", "Fix the approver phone.", "settings");
    if (next.approver_email && !EMAIL_RE.test(next.approver_email)) throw new EngineError("bad_email", "Approver email is not an email address.", "Fix the approver email.", "settings");
    const { updated_at: _u, ...row } = next;
    return this.repo.saveSettings({ ...row, approver_email: row.approver_email ? normalizeAddress(row.approver_email) : null });
  }

  /**
   * Approve from the approval view: the human taps Approve, and the view sends back the code it
   * received in the tool result's view-only `_meta` (never in model-visible content). Only an app
   * tool calls this; the model never sees the code.
   */
  async approveWithViewCode(approvalId: string, code: string): Promise<{ status: ApprovalRow["status"]; approval: ApprovalRow }> {
    const a = await this.repo.getApproval(approvalId);
    if (!a || a.channel !== "view") throw new EngineError("approval_not_found", "No approval waiting on the approval view.", "Call approve(job_id, quote_id) to start one.", "approve");
    if (a.status !== "pending") return { status: a.status, approval: a };
    const okCode = code.length === a.code.length && timingSafeEqual(Buffer.from(code), Buffer.from(a.code));
    if (!okCode) throw new EngineError("bad_code", "That approval code doesn't match.", "Approve from the approval card shown to the human.", "approve");
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

function rejectToFlag(r: string) {
  const m: Record<string, import("../contract.ts").QuoteFlag> = {
    unavailable: "requirement_unmet", unverified_sender: "unverified_sender", external_payment_link: "external_payment_link", prompt_injection: "prompt_injection",
    requirement_unmet: "requirement_unmet", no_total: "vague_price", over_budget: "over_budget", not_current: "expired",
  };
  return m[r] ?? "low_confidence";
}

/** Contract ApprovalRecord, except `channel` reports the real human channel (incl. v5 view / iMessage). */
export type EngineApprovalRecord = Omit<ApprovalRecord, "channel"> & { channel: ApprovalRow["channel"]; status: ApprovalRow["status"] };

function approvalRecord(a: ApprovalRow, job: JobRow): EngineApprovalRecord {
  return {
    approval_id: a.id, job_id: a.job_id, quote_id: a.quote_id, quote_total_usd: centsToUsd(a.quote_total_cents), payment_usd: centsToUsd(a.payment_cents),
    cap_usd: centsToUsd(a.cap_cents), approver: a.approver ?? (a.channel === "simulated" ? "DEMO simulated human" : job.approver_email ?? "unknown"),
    channel: a.channel, status: a.status, approved_at: a.decided_at ?? "", expires_at: a.expires_at,
  };
}

export function paymentStatus(p: PaymentRow): PaymentStatus {
  const s: PaymentStatus = { status: p.status, amount_usd: centsToUsd(p.amount_cents), amount_usdc_base_units: p.amount_base_units, network: p.network, simulated: p.simulated };
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
