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
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ApprovalRecord, AskField, Business, DealResult, JobState, JobUpdate, PaymentStatus, Profile, Quote, QuotesResult, Request, WaitResult,
} from "../contract.ts";
import { businessIdForContact, newApprovalCode, newId, newShortCode, normalizeBusinessName, slugify } from "../ids.ts";
import { cleanEmailBody } from "../inbound/emailBody.ts";
import { applyDeliveryStatus, type DeliveryStatusInput } from "../inbound/deliveryStatus.ts";
import { CONTINUITY_ONLY_REASONS, CONTINUITY_ONLY_WARNING, provesSenderIdentity, senderIdentityOf, TEXT_OR_CALLER_ID_REASONS } from "../inbound/trustStrength.ts";
import { explainQuarantine, quarantineEventData } from "../inbound/quarantineReasons.ts";
import { matchInbound, jobInboxAddress, jobInboxCode, normalizeAddress, normalizeMessageId, subjectShortCode } from "../inbound/matching.ts";
import { isCarrierOptOut, isDsnSender, isOptOut, parseBounce, replyToken, verifyExternalReply } from "../inbound/senderAuth.ts";
import type { InboundMessage, TrustVerdict } from "../inbound/primitive.ts";
import { centsToUsd, usdToCents, centsToUsdcBaseUnits } from "../money.ts";
import { planCounteroffers, type PlannedCounter } from "../negotiation/counteroffer.ts";
import { applyStrategy, type StrategyContext } from "../negotiation/strategist.ts";
import { imessageFailureReason } from "../outbound/imessageErrors.ts";
import { amountsIn, checkMessage, citesCompetingOffer, findDollarAmounts } from "../negotiation/messageGuard.ts";
import { buildRfqEmail, eventPlace, eventWhen, humanTime, quantityText } from "../outbound/rfq.ts";
import { messageSnippet, transcriptSnippet } from "./transcriptSnippet.ts";
import { sendKeys, type OutboundAttachment } from "../outbound/primitiveSender.ts";
import type { FieldValue, QuoteRecord } from "../parsing/extraction.ts";
import { answeredSomething, dropAgentOnlyAmounts } from "../parsing/callSafety.ts";
import { evaluateRequirements, meetsHardRequirements, type EngineRequirement } from "../parsing/requirements.ts";
import { dropUnstatedDietaryRefusals, dropUnsupportedRequirementAnswers, validateQuote } from "../parsing/validate.ts";
import { APPROXIMATE_FLAG, confirmsFirm, isApproximateTotal } from "../parsing/approximate.ts";
import { pdfBodyTotalConflict } from "../parsing/pdfBody.ts";
import { termsMismatch } from "../parsing/termsCheck.ts";
import { isTransientParseError, MAX_PARSE_RETRIES, parseErrorKind, parseRetryDelayMs } from "../parsing/parseErrors.ts";
import type { ExtractionRequest } from "../parsing/parseReply.ts";
import { groundedAnswer } from "../parsing/answerQuestion.ts";
import { firstReplyLine, verifyApproval } from "../approvals/verifyApproval.ts";
import { isUnansweredLimitError, TextBudget } from "./textBudget.ts";
import { parseChallengePart, preparePayment } from "../payments/x402Challenge.ts";
import { checkStripePaymentAllowed, STRIPE_NETWORK, type StripeGuardCode } from "../payments/stripe.ts";
import { rankQuotes, rejectReason, softTierOf, type RankableQuote, type Ranking } from "../ranking/rank.ts";
import { assessCompliance, complianceSummary, type Compliance } from "../ranking/compliance.ts";
import { DEFAULT_QUOTE_VALIDITY_MS, quoteFreshness } from "../ranking/validity.ts";
import { selectionOf, type QuoteSelection } from "../ranking/selection.ts";
import { exclusionLine, exclusionOf, type ExclusionStatus } from "../ranking/exclusion.ts";
import { confirmsReceipt, readBookingReply, vendorOwnWords } from "../approvals/bookingReply.ts";
import { mustHaveLine, normalizeRequirements } from "./requestNormalize.ts";
import { purchasePaymentLine, purchaseView, type PurchaseStage, type PurchaseView } from "../payments/purchase.ts";
import { scoreQuotes, type ValueInput, type ValueRanking } from "../ranking/value.ts";
import { chooseChannel, learnContact, type ContactLearning } from "../routing/channelStats.ts";
import { DEFAULT_WORKSPACE_ID, type ApprovalRow, type BookingRow, type Channel, type JobBusinessRow, type JobEventRow, type JobRow, type MessageRow, type NewMessage, type PaymentHandoffRow, type PaymentRow, type QuestionRow, type QuoteRow, type Repository, type SettingsRow } from "../store/types.ts";
import { quotePartToExtraction } from "./quotePart.ts";
import { toContractQuote, toEngineRequirement, toParsedReply } from "./mapping.ts";
import { MAX_ROUND, start, TERMINAL, transition, type ApprovalAction, type Effect, type JobEvent, type MachineState } from "./stateMachine.ts";
import { ChannelSendError, type EngineDeps, type PhoneCallRequest } from "./ports.ts";
import { buildVoiceInstructions, isWithinCallHours, nextCallHoursStart } from "./callPolicy.ts";
import { decideTextScope, inTextScope, jobCodeIn, lastRoute, withoutJobCode, type TextScope } from "./textRouting.ts";
import { CALL_TEXT, CALLBACK_AUTH_TTL_MS, CANCEL_TEXT, callbackCodeHash, callbackConsent, codeMatches, MAX_CALLBACK_CODE_ATTEMPTS, newCallbackCode, pendingCallbackAuths, type CallbackConsent } from "./callbackAuth.ts";
import { closeSubject, decideChargeResume, decideClaim, holdSubject, redactError } from "./deadLetter.ts";
import { planRecovery, type StuckFinding } from "./recovery.ts";
import type { OperatorReviewRow, OutboxRow } from "../store/types.ts";
import { DEFAULT_CONTACT_TIMEZONE, decideFirstContact, decideFollowUp, localLabel } from "./contactWindow.ts";
import { contactStatusOf, type BusinessContactStatus } from "../inbound/contactStatus.ts";
/** Contact states the board lists per business (the rest are implied by its status). */
const NOTABLE_CONTACT = new Set<BusinessContactStatus["contact_status"]>(["bounced", "failed", "opted_out", "quarantined_reply", "scheduled"]);
import { listQuarantine, rejectQuarantined, releaseQuarantined } from "../inbound/quarantineReview.ts";
import { runOperatorRequests, workspaceSuspension } from "../ops/operator.ts";

/** Board text for a reply Haggle couldn't read (never the provider's raw error). */
export const UNREADABLE_REPLY = "Reply received; Haggle couldn't read a price";

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
/**
 * A counteroffer call right after the business quoted on a call: a shorter gap (it just spoke to us
 * and the deal is waiting on its answer), never under MIN_CALL_GAP_MS.
 */
const DEFAULT_COUNTER_CALL_GAP_MS = 60_000;
const MIN_CALL_GAP_MS = 30_000;
/** A scheduled call whose placement failed (e.g. 503 hosted_agent_at_capacity) is retried after this long, at most CALL_MAX_ATTEMPTS times. */
const CALL_RETRY_MS = 60_000;
const CALL_MAX_ATTEMPTS = 3;
/** A counteroffer call still on the line when the negotiation window ends may finish within this long. */
const COUNTER_CALL_GRACE_MS = 4 * 60_000;
/**
 * A negotiation round whose counteroffers were never recorded (the advance sending them died
 * mid-send) closes this long after its window ends; until then it waits for them (dueEvent).
 */
const COUNTERS_LOST_AFTER_MS = 4 * 60_000;
/** fire's refusal when the job is no longer in the state the event was decided for. */
const STALE_EVENT = "stale: the job changed since this event was decided";
/** A just-asked business holds the collection window at most this long by default (followUpHoldMs). */
const DEFAULT_FOLLOW_UP_HOLD_MS = 3 * 60_000;
/** The per-job advance queue, one per process (see advanceJob). */
const ADVANCING: Map<string, Promise<void>> = ((globalThis as { __haggleAdvancing?: Map<string, Promise<void>> }).__haggleAdvancing ??= new Map());
/** One id per process: engines in one process (a dev reload) share it; other processes hold their own job leases. */
const PROCESS_INSTANCE: string = ((globalThis as { __haggleInstance?: string }).__haggleInstance ??= `proc_${Math.random().toString(36).slice(2, 10)}`);
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
/** The jobs the current async call chain is advancing (see advanceJob: a re-entrant call must not queue behind itself). */
const ADVANCE_CTX: AsyncLocalStorage<ReadonlySet<string>> = ((globalThis as { __haggleAdvanceCtx?: AsyncLocalStorage<ReadonlySet<string>> }).__haggleAdvanceCtx ??= new AsyncLocalStorage());
/** A text from the human that is only a greeting or an acknowledgement. */
const PLEASANTRY_TEXT = /^\s*(hi+|hey+|hello+|yo|ok(ay)?|k|thanks?( you)?|thx|ty|cool|great|nice|got it|sounds good|👍)\s*[.!?]*\s*$/iu;
/** Business questions wait at most this long for others to be batched into one text to the human. */
const DEFAULT_QUESTION_BATCH_MS = 45_000;
const DEFAULT_MAX_APPROVAL_ATTEMPTS = 5;
/** True when a quote's figures come from the keyword fallback (heuristic.ts labels its sources "(heuristic)"). */
const heuristicReading = (r: QuoteRow["record"]) => Object.values(r.sources ?? {}).some((x) => /\(heuristic\)/.test(x?.source ?? ""));
/** A pending outbox claim older than this is a crashed send, not one in flight. */
const OUTBOX_STALE_MS = 2 * 60_000;
/** How long a job may sit in `created` / with unsent first contacts before an advance treats it as a crashed send. */
const STUCK_AFTER_MS = 2 * 60_000;
/** The backup tick's stuck-job sweep (recoverStuck) runs at most this often. */
const RECOVERY_SWEEP_MS = 2 * 60_000;

/** Approval channels a tool call can claim (form, card button, simulated human): not proof of a human. */
const IN_BAND_CHANNELS = new Set<ApprovalRow["channel"]>(["elicitation", "view", "simulated"]);
const needsHumanChannel = () => new EngineError("approval_needs_human_channel", "On this server only the approver's own reply approves: a coded text (YES <code>) from the workspace approver's phone.", "Ask the human to reply to Haggle's approval text; never ask them for the code.", "wait_for_update");
const approverChangeRefused = () => new EngineError("approver_change_requires_operator", "The approver can only be changed by the operator, never through a tool call.", "Ask the operator to change it (scripts/workspace-admin.ts set-approver).", "settings");
/** A placed call with no call-ended result after this long no longer blocks new calls. */
const CALL_IN_PROGRESS_MS = 15 * 60_000;
/** A read (get_quotes, a wait poll) reuses an advance this recent when nothing changed since (advanceForRead). */
const FRESH_ADVANCE_MS = 3_000;
/** Characters an agent-written message may have, per channel (the call brief has its own cap). */
const MESSAGE_LIMIT: Record<Channel, number> = { email: 5000, a2a: 5000, phone: 1500, imessage: 159 };
/** Two SMS segments: long enough for a quote update, short enough to read at a glance. */
const SMS_LIMIT = 320;
/** Payment details that arrived by text (SMS or iMessage): the From number can be spoofed, so the human checks them by phone. */
const SMS_PAYMENT_WARNING = "sent by text from the business's number, which can't prove who wrote it: confirm these payment details with the business by phone before paying";
const usdText = (cents: number) => `$${centsToUsd(cents).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
/** One line, at most n characters (an ellipsis when cut). */
/** The exact-total ask folded into a missing-info follow-up (one message, not two). */
const exactTotalAsk = (readCents: number | null) => `your exact all-in total, incl. delivery and tax, and any deposit${readCents !== null ? ` (we worked it out as ${usdText(readCents)})` : ""}`;
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1)).trimEnd()}…` : t;
};

/** Extra human channels an approval also goes out on (the first human decision wins). */
export type ApprovalOffer = { text?: boolean; email?: boolean };

/** A text to the human (update, question, approval request); kept while their number is paused. */
type HeldText = { key: string; text: string; questionId?: string; approvalId?: string };

/** A texted (SMS or iMessage) approval decision: "YES 4821", "no 4821", "approve". */
const TEXT_DECISION = /^(yes|y|approve|approved|no|n|decline|declined)\b[\s,.:!-]*(\d{4})?[\s.!]*$/i;
/** "PAY 4821": charge an approved payment by text (decision 48). */
const PAY_TEXT = /^pay\b[\s,.:!-]*(\d{4})?[\s.!]*$/i;
/** "PAID 4821": the human paid the business directly (manual handoff). */
const PAID_TEXT = /^paid\b[\s,.:!-]*(\d{4})?[\s.!]*$/i;
/** "BOOKED 4821": the approver accepts a booking the business confirmed from a sender Haggle can't verify. */
const BOOKED_TEXT = /^booked\b[\s,.:!-]*(\d{4})?[\s.!]*$/i;
/**
 * Trust that proves only continuity with Haggle's thread (the reply token; an operator release) or a
 * claimed phone number (a text from the business's number: decision H2), never who wrote it: enough to
 * read a quote, not to bind the booking or to verify a settlement on its own.
 */
function bindsTermsAlone(trustReason: string): boolean {
  return provesSenderIdentity({ sender_trusted: true, trust_reason: trustReason });
}
/** "thread_only" (reply token, operator release) or "text_only" (the business's number): who can't be proven. */
const weakIdentity = (trustReason: string) => (senderIdentityOf({ sender_trusted: true, trust_reason: trustReason }) === "text_only" ? "text_only" : "thread_only");
/** The business confirmed the booking in writing, or the approver attested it (BOOKED <code>): cancelling it needs the approver (H3). */
const isVendorConfirmed = (b: Pick<BookingRow, "status" | "human_attested_at">) => b.status === "confirmed" || (b.status === "not_in_writing" && !!b.human_attested_at);
const THREAD_ONLY_BOOKING_WARNING = "the business's confirmation came from its email thread, but Haggle can't verify the sender (anyone with access to that thread could send it): the human accepts the booking after checking with the business";
const TEXT_ONLY_BOOKING_WARNING = "the business's confirmation came by text from its number, which can't prove who sent it: the human accepts the booking after checking with the business";

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
/**
 * "1: drop-off is fine. 2) no dessert" -> [{n:1,text:"drop-off is fine."},{n:2,text:"no dessert"}]: the
 * human's answers to a numbered question list. Null unless the reply starts with a number in 1..count
 * followed by ":", ".", ")" or "-" (not "5:00" or "1.5"), numbers increasing.
 */
export function splitNumberedAnswers(text: string, count: number): { n: number; text: string }[] | null {
  const t = text.trim();
  const marks: { n: number; start: number; end: number }[] = [];
  for (const m of t.matchAll(/(^|[\s;,])(\d{1,2})\s*[:.)\]-](?!\d)\s*/g)) {
    const n = Number(m[2]);
    const start = m.index! + m[1]!.length;
    if (marks.length === 0 && start !== 0) return null;
    if (n < 1 || n > count || (marks.length && n <= marks.at(-1)!.n)) continue;
    marks.push({ n, start, end: m.index! + m[0].length });
  }
  if (!marks.length) return null;
  const out = marks.map((mk, i) => ({ n: mk.n, text: t.slice(mk.end, marks[i + 1]?.start ?? t.length).replace(/[\s;,]+$/, "").trim() }));
  return out.filter((p) => p.text).length ? out.filter((p) => p.text) : null;
}

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
/** Quote rounds a job can have: the first quotes plus one negotiation round. The jobs table stores
 *  1..2 (jobs_max_rounds_check); asking for more must clamp, never fail the insert. The manual
 *  negotiate round shares the cap (stateMachine MAX_ROUND, decision 14). */
export const MAX_ROUNDS = MAX_ROUND;

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
  /** The business hedged this total in its own words ("around $1,300"): show it as ≈, rank it, but it is not approvable until confirmed. */
  total_approximate?: true;
  /** Can the human approve (and pay) this quote right now? Caveats (over budget, unconfirmed requirement) don't block; see approval_block when false. */
  approvable: boolean;
  /** Why it can't be approved yet, in words for the board (code is an EngineError code, e.g. total_not_firm). */
  approval_block?: { code: string; reason: string };
  /** Custom ask answers by key (money in USD); only for requests with `ask`. */
  fields?: Record<string, number | string | boolean | null>;
  /** Labels of required ask answers still missing. */
  missing_fields?: string[];
  /** Does it meet every must (hard requirements, budget, pay-now within the cap)? Only "compliant" can be recommended. */
  compliance?: Compliance;
  /** Until when it can be approved as is; a stale quote is re-confirmed with the business before any approval. */
  freshness?: { stale: boolean; reason?: "expired" | "aged"; good_until: string; valid_until: string | null; reconfirmation?: "requested" };
  /** Why Haggle selected this quote or why it can't be selected (ranking/selection.ts). */
  selection?: QuoteSelection;
};

/** A justified, not-yet-placed negotiation callback to a phone vendor (needs a human's go-ahead). */
export interface CallbackProposal {
  business_id: string;
  business: string;
  their_quote_id: string;
  their_total_usd: number;
  basis_quote_id: string;
  basis_total_usd: number;
  basis_business: string;
  /** The cited competing total is itself an approximation (the brief says "about $X"). */
  basis_approximate?: boolean;
  round: number;
  why: string;
}

/** One business's place in the deal (finer than the shared board status). */
export interface BusinessStage {
  stage: "sending" | "waiting" | "calling" | "responded" | "reply_unreadable" | "asked_question" | "clarifying" | "quoted" | "countered" | "vendor_revised" | "held_firm" | "final" | "excluded" | "buyer_approved" | "paid" | "no_reply" | "unreachable" | "declined";
  /** none · countered (Haggle's counter, not a price) · vendor_revised (the business lowered its price) · held_firm */
  negotiation: "none" | "countered" | "vendor_revised" | "held_firm";
  first_total_usd?: number;
  current_total_usd?: number;
  quote_version?: number;
  saved_usd?: number;
}

export interface NegotiationStep {
  business_id: string;
  business: string;
  round: number;
  target_total_usd: number;
  basis_quote_id: string;
  /** The cited competing total was another business's estimate (said as "about $X"). */
  basis_approximate?: boolean;
  outcome_total_usd: number | null; // the business's answer, when it came back
  /** The business's channel: a phone business is called back, a text business texted. */
  channel?: Channel;
  /** A counteroffer call not placed yet (cooldown, call hours): when it will be (ISO). */
  scheduled_for?: string;
  /** Their total before this counteroffer. */
  from_total_usd?: number;
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
  /** Ceiling for any single payment on this job (operator ceiling ∩ job cap); separate from the order budget. */
  payment_ceiling_usd?: number;
  /** False when this server refuses every payment (live without Stripe test mode). */
  payments_enabled?: boolean;
  /** Best-value ranking of the eligible quotes: factors, weights, confidence and the why. */
  value?: ValueRanking;
  /** Negotiation callbacks the evidence justifies (each needs a human's go-ahead). */
  callbacks?: CallbackProposal[];
  /** The best-value quote when it differs from recommended_quote_id because it can't be approved (see its approval_block). */
  best_value_quote_id?: string;
  /** Why the recommendation isn't the best-value quote (or why nothing can be approved). */
  recommendation_note?: string;
  /** No quote meets every must: the closest approvable one (never the recommendation; the human may choose it knowingly). */
  best_available_quote_id?: string;
  /** After the human's approval: booking, payment handoff and cancellation, in honest words (see payments/purchase.ts). */
  purchase?: PurchaseView;
  /** Per business: stage, negotiation state, first vs current price, version, savings. */
  stages?: Record<string, BusinessStage>;
  /** Per business: observed reply performance by channel (all jobs) and any contact preference it stated. */
  contact_learning?: Record<string, ContactLearning>;
  /** Per current quote: extra fees (with inclusion) and commercial terms, as the business stated them. */
  terms?: Record<string, { fees?: { label: string; amount_usd?: number; included: boolean | null; excerpt: string }[]; deposit_terms?: string | null; cancellation?: string | null; exclusions?: string[] }>;
  /** Per business id: where Haggle stands with it (inbound/contactStatus.ts); `detail` only when it says more than the board status. */
  vendor_contact?: Record<string, { status: BusinessContactStatus["contact_status"] | ExclusionStatus; detail?: string }>;
};

const REJECT_TEXT: Record<import("../ranking/rank.ts").RejectReason, string> = {
  not_current: "superseded by a newer quote", unavailable: "the business declined", unverified_sender: "sender could not be verified",
  external_payment_link: "asked for payment through an external link (blocked)", prompt_injection: "contained instructions aimed at the agent (ignored)",
  requirement_unmet: "does not meet every hard requirement", missing_info: "a required answer is still missing", no_total: "no exact total yet", all_in_unknown: "all-in total not confirmed yet (delivery, tax or fees not stated)", over_budget: "over the budget",
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
    // An earlier tax amount belongs to the earlier total: not carried onto a new price.
    if (field === "tax" && out.total_cents !== prev.total_cents) continue;
    out[k] = prev[k];
    if (prev.sources[field]) out.sources[field] = prev.sources[field];
    out.missing_fields = out.missing_fields.filter((m) => m !== field);
    if (field === "deposit" && prev.flags.includes("hidden_deposit")) out.flags.push("hidden_deposit");
  }
  if (out.delivery_included === null) out.delivery_included = prev.delivery_included;
  // A tax decision the business stated earlier holds for the same total until it says something new
  // about tax (a new price was already worked out with it in validateQuote).
  if (prev.tax && prev.tax.status !== "not_mentioned" && (!out.tax || (out.tax.status === "not_mentioned" && out.total_cents === prev.total_cents))) {
    out.tax = { ...prev.tax, carried: true };
    out.tax_included = prev.tax.status === "included" ? true : false;
  }
  if (out.tax_included === null) out.tax_included = prev.tax_included;
  if (out.tax?.status === "included" || out.tax_cents !== null) out.flags = out.flags.filter((f) => f !== "tax_excluded");
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
  // A requirement the business settled earlier (on any channel) stays settled until it says otherwise.
  if (prev.requirement_checks) {
    const checks = { ...(out.requirement_checks ?? {}) };
    for (const [id, c] of Object.entries(prev.requirement_checks)) {
      if (c.met === null || (checks[id] && checks[id]!.met !== null)) continue;
      checks[id] = { ...c, carried: true };
    }
    out.requirement_checks = checks;
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
    if (d.config.externalSenders === "reply_token" && (d.config.replyTokenSecret ?? "").length < 16) throw new Error("externalSenders 'reply_token' needs replyTokenSecret (at least 16 characters)");
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
    // Every business is told the details: a competitor's price comes only from a stored quote (negotiate), never the request (S5-D F7).
    const cited = (input.request.details ?? []).find((d) => citesCompetingOffer(`${d.label}: ${d.value}`));
    if (cited) throw new EngineError("detail_cites_competitor", `The detail "${cited.label}" cites a competing offer; businesses are only ever told real, stored quotes.`, "Remove it; once quotes arrive Haggle's negotiate round cites the best real one.", "deal");
    // Requirements as the agent wrote them (plain words or coarse kinds): kind, dietary need and minimum count made checkable.
    input = { ...input, request: { ...input.request, requirements: normalizeRequirements(input.request.requirements ?? []) } };
    const approverPhone = (await this.getSettings(ws)).approver_phone;
    // Who this workspace may contact: the server's allowlist, plus the vendors the operator authorized
    // for this workspace (workspace_vendors, each with its recorded consent).
    const wsVendors = new Set((await this.repo.listWorkspaceVendors(ws)).map((v) => v.contact));
    // Opted out or hard-bounced anywhere: never contacted again.
    const contacts = input.businesses.flatMap((b) => [b.email ? normalizeAddress(b.email) : null, b.phone ? b.phone.replace(/[\s().-]/g, "") : null].filter((c): c is string => !!c));
    const suppressed = new Map((await this.repo.findSuppressions(contacts)).map((x) => [x.contact, x]));
    // What Haggle has learned about reaching each business (stated preference, observed replies).
    const learned = await Promise.all(input.businesses.map(async (b) => {
      const email = b.email ? normalizeAddress(b.email) : null;
      const phone = b.phone ? b.phone.replace(/[\s().-]/g, "") : null;
      if (!email && !phone && !b.a2a_card_url) return null;
      const id = businessIdForContact({ email, phone, a2a_card_url: b.a2a_card_url?.trim() || null }, b.name);
      return this.contactLearning(id, await this.businessAliases({ business_id: id, name: b.name, email, phone })).catch(() => null);
    }));
    const seen = new Set<string>();
    const planned = input.businesses.map((b, i) => {
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
      const blocked = [email, phone, card].find((c) => c !== null && !this.allowedRecipient(c) && !wsVendors.has(c.toLowerCase()));
      if (blocked) throw new EngineError("recipient_not_allowed", `${b.name} (${blocked}) isn't on this server's list of businesses it may contact.`, "Use the simulated demo businesses from discover, or ask the operator to add it to HAGGLE_ALLOWED_RECIPIENTS.", "discover");
      for (const key of [email, phone].filter((k): k is string => k !== null)) {
        if (seen.has(key)) throw new EngineError("duplicate_business", `Listed twice: ${key}`, "Remove the duplicate.", "deal");
        seen.add(key);
      }
      const base = this.route({ email, phone, card, prefer: b.channel });
      // Learned channel: only among channels that are authorized and enabled; iMessage only with a prior
      // two-way history (Inkbox reaches only connected people); an operator's explicit channel stands
      // unless the business itself asked otherwise.
      const L = learned[i] ?? null;
      const available: Channel[] = [
        ...(card && this.d.a2a ? ["a2a" as const] : []), ...(email ? ["email" as const] : []), ...(phone && this.d.phone ? ["phone" as const] : []),
        ...(phone && this.d.imessage && ((L?.channels.imessage?.replied_jobs ?? 0) > 0 || L?.stated_preference?.channel === "imessage") ? ["imessage" as const] : []),
      ];
      const pick = base.reachable && (!b.channel || L?.stated_preference) ? chooseChannel(available, base.channel, L) : { channel: base.channel, reason: null };
      const off = [email, phone].map((c) => (c ? suppressed.get(c) : undefined)).find((x) => x);
      if (off) return { b, email, phone, card, channel: base.channel, reachable: false, reason: off.reason === "opt_out" ? "asked not to be contacted" : "its address bounced" };
      return { b, email, phone, card, ...(pick.reason ? { channel: pick.channel, reachable: true, reason: pick.channel, learnedReason: pick.reason } : base) };
    });
    if (planned.length && planned.every((p) => !p.reachable && (p.reason === "asked not to be contacted" || p.reason === "its address bounced"))) {
      throw new EngineError("recipient_suppressed", `${planned.map((p) => `${p.b.name} ${p.reason}`).join("; ")}. Nothing was sent.`, "Haggle never contacts a business that opted out or whose address bounced; choose other businesses.", "deal");
    }
    if (!planned.some((p) => p.reachable)) {
      throw new EngineError("no_usable_channel", "None of these businesses can be reached: phone and A2A outreach aren't enabled in this deployment.", "Give at least one business an email address.", "deal");
    }
    const budgetCents = input.budget_usd === undefined ? null : usdToCents(input.budget_usd);
    if (budgetCents !== null && budgetCents <= 0) throw new EngineError("bad_budget", "budget_usd must be positive.", "Pass a positive budget_usd or omit it.", "deal");
    const replyBy = input.reply_by ? new Date(input.reply_by) : new Date(this.now().getTime() + this.d.config.collectionWindowMs);
    if (Number.isNaN(replyBy.getTime()) || replyBy <= this.now()) throw new EngineError("bad_deadline", "reply_by must be a future ISO time.", "Pass a future reply_by or omit it.", "deal");

    // The per-job payment cap: what Haggle may charge at most, the lower of the operator's per-payment
    // ceiling and the workspace spending cap. The budget stays a preference (a caveat, never a refusal).
    const paymentCapCents = Math.min(this.d.config.globalPaymentCapCents, (await this.getSettings(ws)).spending_cap_cents);
    let job: JobRow | null = null;
    for (let i = 0; i < 5 && !job; i++) {
      const code = newShortCode();
      const at = this.now().toISOString();
      try {
        job = await this.repo.insertJob({
          id: newId("job"), workspace_id: ws, short_code: code, state: "created", mode, request: input.request, budget_cents: budgetCents,
          payment_cap_cents: paymentCapCents, approver_email: input.approver_email ? normalizeAddress(input.approver_email) : null,
          inbox: this.d.config.sharedInbox ?? jobInboxAddress(code, this.d.config.inboxDomain), round: 1, max_rounds: Math.max(1, Math.min(input.max_rounds ?? this.d.config.maxRounds, MAX_ROUNDS)),
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
    for (const p of planned) if ("learnedReason" in p && p.learnedReason) this.log("channel_learned", { business: p.b.name, channel: p.channel, why: p.learnedReason });
    await this.repo.insertBusinesses(planned.map(({ b, email, phone, card, channel, reachable }): JobBusinessRow => ({
      job_id: job!.id, business_id: businessIdForContact({ email, phone, a2a_card_url: card }, b.name), name: b.name.slice(0, 120), email, phone, a2a_card_url: card, channel,
      source: b.source ?? "agent", simulated: b.simulated ?? mode === "mock", status: reachable ? "pending" : "unavailable", thread_id: null, rfq_message_id: null,
      last_inbound_message_id: null, references: [], contacted_at: null, last_reply_at: null, followups_sent: 0, countered_round: 0,
      send_attempts: 0, next_attempt_at: null, escalated_at: null,
    })));
    await this.repo.appendEvent(job.id, "state", { from: null, to: "created" });
    for (const p of planned.filter((x) => !x.reachable)) {
      await this.repo.appendEvent(job.id, "reply", { business_id: businessIdForContact({ email: p.email, phone: p.phone, a2a_card_url: p.card }, p.b.name), summary: `${p.b.name} not contacted: ${p.reason}` });
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
    // "@domain" covers email addresses at that domain only, never a URL that ends in it (an A2A card, S5-D F9).
    const isEmail = /^[^@\s/:?#]+@[^@\s/:?#]+$/.test(c);
    return list.some((e) => { const x = e.trim().toLowerCase(); return x === c || (x.startsWith("@") && isEmail && c.endsWith(x)); });
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

  /**
   * Best-value ranking inputs from stored evidence only: the quote's stated terms, public reputation
   * (real businesses, when a listing source is configured; non-blocking), and Haggle's own track
   * record with the business (real quotes on other jobs; seed samples excluded).
   */
  private async valueRanking(job: JobRow, eligible: QuoteRow[], all: QuoteRow[], byId: Map<string, JobBusinessRow>, caveats: Ranking["caveats"] = []): Promise<ValueRanking> {
    const tiers = new Map(caveats.map((c) => [c.quoteId, softTier(c.reasons)]));
    const dietary = this.requirements(job).filter((r) => r.kind === "dietary" && r.need);
    const inputs: ValueInput[] = [];
    // Haggle's track record with each business, read in parallel (the brain may be a remote store).
    const tracker = this.d.brain as { trackRecord?: (id: string, excludeJobId: string) => Promise<ValueInput["reliability"]> };
    const records = await Promise.all(eligible.map((q) => (typeof tracker.trackRecord === "function" ? tracker.trackRecord(byId.get(q.business_id)!.business_id, job.id).catch(() => null) : Promise.resolve(null))));
    for (const [i, q] of eligible.entries()) {
      const b = byId.get(q.business_id)!;
      const r = q.record;
      const prev = all.filter((x) => x.business_id === q.business_id && x.id !== q.id && x.total_cents !== null && !isApproximate(x.record)).sort((x, y) => y.round - x.round)[0];
      const rep = this.d.reputation?.peek({ business_id: b.business_id, name: b.name, phone: b.phone, area: job.request.area, simulated: b.simulated }) ?? { status: b.simulated ? "simulated" as const : "disabled" as const };
      const reliability: ValueInput["reliability"] = records[i] ?? null;
      inputs.push({
        quoteId: q.id, businessId: q.business_id, business: b.name, totalCents: q.total_cents!, depositCents: r.deposit_cents,
        deliveryIncluded: r.delivery_included === true || (r.delivery_fee_cents !== null && r.delivery_fee_cents >= 0 && r.delivery_included !== false) ? true : r.delivery_included,
        deliveryStated: r.delivery_included !== null || r.delivery_fee_cents !== null, taxStated: r.tax_included !== null || r.tax_cents !== null,
        dietaryStated: dietary.every((d) => r.dietary_coverage[(d.need ?? "").toLowerCase()]?.count_offered != null), itemsListed: r.menu_items.length > 0, confidence: r.confidence,
        ...(prev?.total_cents != null && prev.total_cents !== q.total_cents ? { negotiatedFromCents: prev.total_cents } : {}),
        reputationStatus: rep.status, ...(rep.evidence ? { reputation: rep.evidence } : {}), reliability, tier: tiers.get(q.id) ?? 0,
      });
    }
    return scoreQuotes(inputs, job.request.preferences?.weights ?? {});
  }

  /** A settled Stripe charge links Stripe's hosted receipt when the read-back returned one. */
  private async withReceipt(jobId: string, s: EnginePaymentStatus, events?: JobEventRow[]): Promise<EnginePaymentStatus> {
    if (s.rail !== "stripe" || s.status !== "settled" || s.simulated) return s;
    const e = (events ?? (await this.repo.listEvents(jobId))).filter((x) => x.type === "payment" && x.data.status === "settled" && typeof x.data.receipt_url === "string").at(-1);
    return e ? { ...s, receipt_url: String(e.data.receipt_url) } : s;
  }

  /** Does the buyer's request involve delivery (so an unstated delivery cost leaves the all-in total unknown)? */
  private needsDelivery(job: JobRow): boolean {
    return job.request.requirements.some((r) => r.kind === "delivery" || /\bdeliver|\ball[- ]?in\b/i.test(r.text));
  }

  /**
   * Every id this business has had in Haggle's own records: job rows on the same email or phone whose
   * business name is the same (normalized). Ids changed when identity started including the name
   * (0f1835f); a different business on a shared phone or mailbox never matches (its name differs).
   */
  async businessAliases(b: { business_id: string; name: string; email?: string | null; phone?: string | null }): Promise<string[]> {
    const key = normalizeBusinessName(b.name);
    const rows = await this.repo.listJobBusinessesByContact({ email: b.email ? normalizeAddress(b.email) : null, phone: b.phone ?? null }).catch(() => []);
    return [...new Set([b.business_id, ...rows.filter((r) => normalizeBusinessName(r.name) === key).map((r) => r.business_id)])];
  }

  /**
   * What Haggle observed about reaching this business across all its jobs (and its older ids).
   * `workspaceId`: only that workspace's deals (what an agent may see: a reply quoted from another
   * tenant's deal is never shown to it).
   */
  async contactLearning(businessId: string, aliases: string[] = [], workspaceId?: string): Promise<ContactLearning> {
    const ids = [...new Set([businessId, ...aliases])];
    const [messages, quotes] = await Promise.all([Promise.all(ids.map((id) => this.repo.listMessagesForBusiness(id))), Promise.all(ids.map((id) => this.repo.listQuotesForBusiness(id)))]);
    if (workspaceId === undefined) return learnContact(messages.flat(), quotes.flat());
    const own = await this.jobsInWorkspace([...messages.flat().map((m) => m.job_id), ...quotes.flat().map((q) => q.job_id)], workspaceId);
    return learnContact(messages.flat().filter((m) => m.job_id !== null && own.has(m.job_id)), quotes.flat().filter((q) => own.has(q.job_id)));
  }

  /** The ids among these that are jobs of this workspace. */
  async jobsInWorkspace(jobIds: (string | null)[], workspaceId: string): Promise<Set<string>> {
    const ids = [...new Set(jobIds.filter((x): x is string => !!x))];
    const jobs = await Promise.all(ids.map((id) => this.repo.getJob(id)));
    return new Set(jobs.filter((j): j is JobRow => j !== null && j.workspace_id === workspaceId).map((j) => j.id));
  }

  /** The vendors the operator authorized for this workspace (deal by name resolves against them). */
  async workspaceVendors(workspaceId: string) {
    return this.repo.listWorkspaceVendors(workspaceId);
  }

  /** An authorized absolute ceiling (budget_kind "limit"), else null. */
  private hardLimitCents(job: JobRow): number | null {
    return job.request.budget_kind === "limit" ? job.budget_cents : null;
  }
  /** The buyer's target (the default meaning of a budget), else null. */
  private targetCents(job: JobRow): number | null {
    return job.request.budget_kind === "limit" ? null : job.budget_cents;
  }

  /** `all`: the job's quotes when the caller already read them (one read per board). */
  private async rankRows(job: JobRow, all?: QuoteRow[]) {
    const quotes = (all ?? (await this.repo.listQuotes(job.id))).filter((q) => q.status === "current");
    const capCents = await this.spendCapCents(job);
    const { compare, moneyCompare, required } = askInfo(job.request);
    const hardIds = new Set(this.requirements(job).filter((r) => r.hard).map((r) => r.id));
    const rankable = quotes.map((q): RankableQuote => ({
      quoteId: q.id, businessId: q.business_id, totalCents: q.total_cents, available: q.record.available,
      // A no-total row is stored not-compliant (DB check); judge it by its requirement results so it ranks as "no total", not "requirement unmet".
      compliant: q.total_cents === null ? meetsHardRequirements(q.requirement_results, this.requirements(job)) : q.compliant,
      unmet: q.requirement_results.some((r) => hardIds.has(r.requirement_id) && r.met === false),
      senderTrusted: q.sender_trusted, status: q.status, confidence: q.record.confidence, flags: q.record.flags, allInKnown: allInKnown(q.record, this.needsDelivery(job)),
      // Custom requests: rank on compare_by (a non-money field needs no total), and a quote missing a required answer can't win.
      ...(compare && !moneyCompare ? { sortValue: sortable(compare, q.record.fields?.[compare.key] ?? null), needsTotal: false } : {}),
      ...(compare ? { direction: job.request.compare_by!.direction } : {}),
      ...(required.length ? { missingRequired: required.some((k) => (q.record.fields?.[k] ?? null) === null) } : {}),
      // What approval would pay now can't be approved over the cap: it ranks with the stated misses.
      ...(capCents !== null && payNowCents(q) !== null && payNowCents(q)! > capCents ? { overCap: true } : {}),
    }));
    // Any budget (a target or a "limit") is soft: over it ranks lower with a caveat (decisions 1, 33);
    // over a limit ranks with the stated misses, and only a quote that misses nothing wins by default.
    return { quotes, rankable, ranking: rankQuotes(rankable, job.budget_cents, this.hardLimitCents(job)), capCents };
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
      // Not the order asked for, or not clearly from the business contacted (parsing/termsCheck.ts).
      : q.record.flags.includes("identity_mismatch") ? "identity_mismatch" : q.record.flags.includes("date_mismatch") ? "date_mismatch" : q.record.flags.includes("delivery_window_mismatch") ? "delivery_window_mismatch"
      // A request ranked on a non-money answer (e.g. earliest date) needs that answer first...
      : nonMoneyCompare(job.request) && (q.record.fields?.[job.request.compare_by!.field] ?? null) === null ? "missing_info"
      // ...and every approval, of any request and confirm-only too, needs a firm, positive, all-in total
      // (decisions 19, 34).
      // A reading by the keyword fallback (Claude couldn't read the reply) is shown, never approved.
      : heuristicReading(q.record) ? "unreliable_extraction"
      : q.total_cents === null ? "no_total"
      // A $0 total is never an amount to approve or charge (approvals require > 0).
      : q.total_cents <= 0 ? "zero_total"
      // "around $1,300" is a price to compare, never an amount to approve or charge.
      : isApproximate(q.record) ? "total_not_firm"
      // Over a budget (a target or a "limit") is a caveat, never a block (decision 33).
      : !allInKnown(q.record, this.needsDelivery(job)) ? "all_in_unknown" : null;
    const caveats: string[] = [];
    const dollars = (c: number) => `$${centsToUsd(c).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const unanswered = (job.request.ask ?? []).filter((f) => f.required && (q.record.fields?.[f.key] ?? null) === null).map((f) => f.label);
    if (unanswered.length) caveats.push(`Didn't answer: ${unanswered.join(", ")}`);
    if (q.total_cents !== null) {
      if (job.budget_cents !== null && q.total_cents > job.budget_cents) caveats.push(`${dollars(q.total_cents - job.budget_cents)} over the ${dollars(job.budget_cents)} ${job.request.budget_kind === "limit" ? "limit" : "budget"}`);
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
      fees_unclear: "Some fees may not be in the total",
    };
    for (const f of q.record.flags) if (FLAG_TEXT[f]) caveats.push(FLAG_TEXT[f]!);
    if (q.total_cents !== null && !(q.deposit_cents && q.deposit_cents > 0)) caveats.push(this.manualPayments ? `No deposit stated: the full ${dollars(q.total_cents)} is due up front (the human pays the business directly)` : `No deposit stated: the full ${dollars(q.total_cents)} is charged now`);
    return { hard, caveats };
  }

  /** What the human is knowingly accepting by approving this quote (empty for a clean quote). */
  async approvalCaveats(jobId: string, quoteId: string): Promise<string[]> {
    const job = await this.loadJob(jobId);
    const q = await this.repo.getQuote(quoteId);
    return q && q.job_id === jobId ? this.approvability(job, q, (await this.getSettings(job.workspace_id)).spending_cap_cents).caveats : [];
  }

  /** The lowest cap any payment on this job must fit: the job's, the server's and the workspace's current one. */
  private async spendCapCents(job: JobRow): Promise<number> {
    return Math.min(job.payment_cap_cents, this.d.config.globalPaymentCapCents, (await this.getSettings(job.workspace_id)).spending_cap_cents);
  }

  /** Does this quote meet every must (hard requirements, budget, pay-now within the cap)? Only "compliant" may win on its own. */
  private complianceOf(job: JobRow, q: QuoteRow, capCents: number | null): Compliance {
    return assessCompliance({
      requirements: this.requirements(job), results: q.requirement_results, totalCents: q.total_cents, payNowCents: payNowCents(q),
      budgetCents: job.budget_cents, budgetKind: job.request.budget_kind === "limit" ? "limit" : "target", capCents,
    });
  }

  /** Why the board can't offer Approve on this quote (null = approvable; caveats never block). */
  private approvalBlock(job: JobRow, q: QuoteRow, b: JobBusinessRow | undefined, askedFirm: boolean): { code: string; reason: string } | null {
    const hard = this.approvability(job, q).hard;
    const name = b?.name ?? "The business";
    if (!hard) {
      // The operator's per-payment ceiling (requestApproval's over_cap): the same rule, said up front.
      const deposit = q.deposit_cents !== null && q.deposit_cents > 0;
      const payment = deposit ? q.deposit_cents! : q.total_cents!;
      const cap = this.d.config.globalPaymentCapCents;
      if (payment <= cap) return null;
      const usdS = (c: number) => `$${centsToUsd(c).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
      return { code: "over_cap", reason: `Needs ${usdS(payment)} up front (${deposit ? "the deposit" : "no deposit stated, so the full total"}), above the ${usdS(cap)} per-payment ceiling: ask ${name} for a smaller deposit, or ask the operator to raise the ceiling.` };
    }
    const approx = q.total_cents === null ? "" : `≈ $${centsToUsd(q.total_cents).toLocaleString("en-US")}`;
    if (hard === "total_not_firm") {
      return {
        code: "total_not_firm",
        reason: b?.channel === "phone"
          ? `Approximate total from the call (${approx}). A firm figure needs a callback to ${name}, which only you can authorize; it can't be approved until then.`
          : askedFirm ? `Approximate total (${approx}). Haggle asked ${name} once for a firm all-in total; it can be approved when they confirm.`
          : `Approximate total (${approx}). ${name} must confirm a firm all-in total before it can be approved.`,
      };
    }
    const TEXT: Record<string, string> = {
      not_current: "Superseded by a newer quote.", unavailable: `${name} declined.`, unverified_sender: "The sender couldn't be verified.",
      external_payment_link: "It asked for payment through an external link (blocked).", prompt_injection: "It contained instructions aimed at the agent (ignored).",
      unreliable_extraction: "Haggle couldn't read this reply reliably (the figures are a keyword reading); ask the business to confirm its total.",
      identity_mismatch: `The reply is written as a different business than ${name}${q.record.terms_mismatch?.signed_as ? ` ("${q.record.terms_mismatch.signed_as}")` : ""}; confirm who is quoting before approving.`,
      date_mismatch: `${name} quoted for ${q.record.terms_mismatch?.offered_date ?? "another date"}, not the requested date; agree the date with them first.`,
      delivery_window_mismatch: `${name} can only deliver ${q.record.terms_mismatch?.delivery_window ?? "at another time"}, which misses the requested time; agree the timing with them first.`,
      no_total: "No total yet.", zero_total: "The stated total is $0; nothing to approve.", all_in_unknown: "The all-in total (delivery, tax or fees) isn't confirmed yet.",
      missing_info: `${name} hasn't answered ${job.request.compare_by ? `"${job.request.compare_by.field}"` : "a required question"} yet.`,
    };
    return { code: hard === "no_total" || hard === "zero_total" || hard === "missing_info" || hard === "unreliable_extraction" || hard === "identity_mismatch" || hard === "date_mismatch" || hard === "delivery_window_mismatch" ? hard : "quote_not_eligible", reason: TEXT[hard] ?? hard };
  }

  private async context(job: JobRow, event?: JobEvent) {
    const { quotes, rankable, ranking } = await this.rankRows(job);
    const businesses = await this.repo.getBusinesses(job.id);
    const manual = event?.type === "negotiation_requested" ? { businessIds: event.businessIds } : undefined;
    const plan = this.counterPlan(job, rankable, businesses, quotes, manual);
    const payment = await this.repo.getPaymentForJob(job.id);
    const approval = event?.type === "approval_verified" || event?.type === "booking_confirmed" ? await this.repo.getLatestApproval(job.id) : null;
    return {
      // An approximate total counts: it becomes approvable once the business confirms a firm figure.
      now: this.now(), eligibleQuotes: ranking.ranked.length, approvableQuotes: quotes.filter((q) => { const h = this.approvability(job, q).hard; return h === null || h === "total_not_firm"; }).length, counterable: plan.length > 0,
      negotiationWindowMs: this.d.config.negotiationWindowMs, paymentInFlight: payment !== null && ["signed", "sent", "charging"].includes(payment.status),
      ...(approval ? { approvalAction: approval.action } : {}), ...(this.d.config.manualPaymentHandoff ? { bookingFirst: true } : {}),
    };
  }

  /**
   * Honest counteroffers. Every eligible quote (any channel) can be the cited basis; each business
   * priced above it is countered on its own channel (email thread, text, a short Voice AI call, or
   * its open A2A context) when that channel can still reach it.
   * Only money comparisons where lower is better are negotiated. A manual round (negotiate tool)
   * can be limited to some businesses and never goes past round MAX_ROUND (2).
   */
  private counterPlan(job: JobRow, rankable: RankableQuote[], businesses: JobBusinessRow[], quotes: QuoteRow[] = [], manual?: { businessIds?: string[] | undefined }) {
    const { compare, moneyCompare } = askInfo(job.request);
    if (compare && (!moneyCompare || job.request.compare_by?.direction === "max")) return [];
    const byId = new Map(businesses.map((b) => [b.business_id, b]));
    const rows = new Map(quotes.map((q) => [q.id, q]));
    const only = manual?.businessIds?.length ? new Set(manual.businessIds) : null;
    return planCounteroffers(
      // A business's negotiation round is how far it has been countered (1 = not yet), never how many
      // replies it sent: a confirm-once revision (a firm total, a confirmed requirement) is still round 1.
      // A keyword-fallback reading is neither cited to other businesses nor countered: its figures aren't reliable.
      rankable.filter((r) => { const row = rows.get(r.quoteId); return !row || !heuristicReading(row.record); }).map((r) => ({
        ...r, businessName: byId.get(r.businessId)?.name ?? "there", round: Math.max(1, byId.get(r.businessId)?.countered_round ?? 0),
        deliveryFeeCents: rows.get(r.quoteId)?.record.delivery_fee_cents ?? null, depositCents: rows.get(r.quoteId)?.deposit_cents ?? null, approximate: isApproximate(rows.get(r.quoteId)?.record),
      })),
      // A manual round (negotiate) gets its own window and the same cap (MAX_ROUND = MAX_ROUNDS = 2).
      new Date(manual ? this.now().getTime() + this.d.config.negotiationWindowMs : job.collect_until), manual ? MAX_ROUND : job.max_rounds, this.hardLimitCents(job), this.targetCents(job),
    // Every channel the business was first contacted on, phone included: a counter round may place an
    // automatic counter call (decision 13); the FIRST call never cites a price (placeRfqCall).
    ).filter((c) => { const b = byId.get(c.businessId); return (!only || only.has(c.businessId)) && !!b && this.canReach(b); });
  }

  /** CAS-commit a transition, record it, then run its effects. Returns the committed row or null on conflict. */
  private async commit(job: JobRow, next: MachineState, effects: Effect[], cause: string): Promise<JobRow | null> {
    const updated = await this.repo.casJob(job.id, job.version, {
      state: next.state, round: next.round, collect_until: next.collect_until, ready: next.ready, failure_reason: next.failure_reason,
    });
    if (!updated) return null;
    if (updated.state !== job.state) await this.repo.appendEvent(job.id, "state", { from: job.state, to: updated.state, cause, ...(updated.failure_reason ? { reason: updated.failure_reason } : {}) });
    // Quotes are final: the "all quotes are in" text (with a pending approval for the recommended
    // quote) goes from advanceJobOnce once this transition settles (offerReady).
    if (updated.ready && !job.ready) await this.repo.appendEvent(job.id, "ready", { round: updated.round });
    const pay = updated.state !== job.state && (updated.state === "paid" || updated.failure_reason === "payment_failed") ? await this.repo.getPaymentForJob(job.id) : null;
    if (updated.state === "paid" && job.state !== "paid" && pay) {
      // However the charge settled (at approval, the agent's pay, a later retry): tell the human once.
      const rail = pay.simulated ? "simulated, DEMO: no money moved" : pay.rail === "stripe" ? "Stripe test mode" : `x402, ${pay.network}`;
      await this.notifyHuman(updated, `paid:${pay.approval_id}`, `Paid ${usdText(pay.amount_cents)} to ${await this.businessName(job.id, pay.business_id)} (${rail}). The receipt is on the deal board.`);
    } else if (updated.state === "paid" && job.state !== "paid" && this.d.config.manualPaymentHandoff) {
      const a = await this.repo.getLatestApproval(job.id);
      if (a) await this.notifyHuman(updated, `paid:${a.id}`, `recorded that you report paying ${usdText(a.payment_cents)} to ${await this.businessName(job.id, a.business_id)} directly (Haggle can't see the money). They were asked to confirm they received it.`);
    } else if (updated.state === "failed" && job.state !== "failed" && pay) {
      await this.notifyPayFailed(updated, { id: pay.approval_id, business_id: pay.business_id, payment_cents: pay.amount_cents }, pay.reason ?? pay.status);
    } else if (updated.state === "failed" && job.state !== "failed") await this.notifyHuman(updated, "failed", `the deal for ${updated.request.what} ended without a usable quote${updated.failure_reason ? ` (${updated.failure_reason})` : ""}.`);
    for (const e of effects) await this.runEffect(updated, e);
    if (TERMINAL.has(updated.state) && !TERMINAL.has(job.state)) this.syncVoiceContext();
    return updated;
  }

  /**
   * `seen`: the job as the caller saw it when it decided on this event (advanceJobOnce's dueEvent).
   * The event is applied only to that same state, round and ready flag, never to whatever the job
   * moved to meanwhile: live HG-YUFU, a "collection closed" decided by one advance landed, through
   * the CAS retry, on the negotiation round another advance had just opened (round 2 = max_rounds),
   * so it closed that round as "ready" before a single counteroffer went out.
   */
  async fire(jobId: string, event: JobEvent, cause = event.type, seen?: Pick<JobRow, "state" | "round" | "ready">): Promise<{ ok: boolean; reason?: string; job?: JobRow }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const job = await this.repo.getJob(jobId);
      if (!job) return { ok: false, reason: "job not found" };
      if (seen && (job.state !== seen.state || job.round !== seen.round || job.ready !== seen.ready)) return { ok: false, reason: STALE_EVENT, job };
      const r = transition(this.machine(job), event, await this.context(job, event));
      if (!r.ok) return { ok: false, reason: r.reason };
      const committed = await this.commit(job, r.next, r.effects, cause);
      if (committed) return { ok: true, job: committed };
    }
    return { ok: false, reason: "conflict" };
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
  private async sendRecorded(job: JobRow, b: JobBusinessRow | null, kind: MessageRow["kind"], key: string, raw: { to: string | null; subject: string; bodyText: string; attachments?: OutboundAttachment[]; inThread?: boolean; round?: number; approvalId?: string; threadOn?: string | null }) {
    const prior = await this.repo.findMessageByIdempotencyKey(key);
    if (prior) return prior;
    if (!raw.to) throw new EngineError("no_email", `${b?.name ?? "This recipient"} has no email address.`, "Reach this business on its own channel.", "get_quotes");
    const to = raw.to;
    if (b) await this.refuseSuppressed(to);
    const msg = this.withoutForeignTokens(job, b && normalizeAddress(to) === normalizeAddress(b.email ?? "") ? this.withReplyToken(job, b, raw) : raw, b);
    await this.claimSend(key, job.id, "email");
    const thread = msg.inThread && b?.last_inbound_message_id ? { inReplyTo: b.last_inbound_message_id, references: b.references.slice(-10) } : raw.threadOn ? { inReplyTo: raw.threadOn, references: [raw.threadOn] } : undefined;
    let out;
    try {
      out = await this.d.email.send({ from: job.inbox, to, subject: msg.subject, bodyText: msg.bodyText, idempotencyKey: key, ...(thread ? { thread } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}) });
    } catch (err) {
      // Email carries the provider idempotency key, so a later retry under the same key is safe;
      // unless the provider says it may have acted (an idempotency conflict): never re-sent then.
      await this.outboxFailed(key, job.id, "email", err instanceof ChannelSendError && err.ambiguous ? "unknown" : "not_sent", err);
      throw err;
    }
    let row: MessageRow | null;
    try {
      row = await this.repo.insertMessage({
        job_id: job.id, business_id: b?.business_id ?? null, approval_id: msg.approvalId ?? null, direction: "out", kind,
        provider_email_id: out.providerId, idempotency_key: key, rfc_message_id: out.messageId, thread_id: b?.thread_id ?? null,
        from_address: job.inbox, to_address: to, subject: msg.subject, body_text: msg.bodyText,
        attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, content_type: a.contentType, size_bytes: a.content.byteLength, tar_path: null })),
        attachments_download_url: null, sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null,
        round: msg.round ?? null, simulated: job.mode === "mock",
      });
      await this.repo.finishOutbox(key, "sent", out.providerId, this.now().toISOString());
    } catch (err) {
      // Sent, but the database couldn't record it (an outage): never a bounce. The claim stays
      // pending; once stale it is re-sent under the same provider key, which replays the original
      // send instead of delivering it twice, and recorded then.
      this.log("send_record_failed", { job_id: job.id, key, error: redactError(err) });
      throw new ChannelSendError("provider_error", true, OUTBOX_STALE_MS, "sent, but not recorded (database unavailable); re-recorded under the same provider key");
    }
    return row ?? (await this.repo.findMessageByIdempotencyKey(key));
  }

  /**
   * Claim an outbound action in the outbox before calling the provider. A claim another instance
   * made moments ago means it is sending right now: retry later. A stale claim (a crash between the
   * claim and the result) is re-claimed for idempotent kinds (same provider key); a call never is.
   */
  private async claimSend(key: string, jobId: string | null, kind: "email" | "text" | "call" | "a2a") {
    // A stale lease holder (its advance outlived the lease and another instance took the job) sends nothing.
    await this.fence(jobId);
    const now = this.now();
    const c = await this.repo.claimOutbox({ key, job_id: jobId, kind }, now.toISOString());
    if (c.fresh) return;
    // A call (no provider idempotency key) is re-attempted only after a definite "not placed"; an
    // obligation never while its outcome is unknown; anything else a bounded number of times
    // (workflow/deadLetter.ts). What may not be attempted again goes to operator review.
    const d = decideClaim({ kind, key, row: c.row, nowMs: now.getTime(), staleMs: OUTBOX_STALE_MS, underReview: c.row.status !== "sent" && !!(await this.repo.findOpenReview("outbox", key)) });
    if (d.action === "send") {
      if (!d.reclaim) return; // already sent: the same provider key dedupes the resend
      if (await this.repo.reclaimOutbox(key, ["pending", "not_sent", "unknown"], now.toISOString())) return;
      throw new ChannelSendError("provider_error", false, 0, "this action can't be attempted again", true);
    }
    if (d.action === "defer") throw new ChannelSendError("provider_error", true, d.retryAfterMs, d.reason);
    if (d.action === "review") await this.deadLetter({ kind: "outbox", subject: key, job_id: jobId, reason: d.reason, attempts: c.row.attempts });
    throw new ChannelSendError("provider_error", false, 0, kind === "call" ? `${d.reason}; not dialed again` : d.reason, true);
  }

  /** Opted out or hard-bounced: never contacted again (vendor_suppressions). */
  private async refuseSuppressed(contact: string) {
    const [hit] = await this.repo.findSuppressions([contact.toLowerCase()]);
    if (hit) throw new ChannelSendError(hit.reason === "opt_out" ? "opted_out" : "invalid_address", false, 0, hit.reason === "opt_out" ? "this business asked not to be contacted" : "this address bounced");
  }

  /** The business's reply token in the subject and the body of every email to it (externalSenders "reply_token"). */
  private withReplyToken<T extends { subject: string; bodyText: string }>(job: JobRow, b: JobBusinessRow, msg: T): T {
    if (this.d.config.externalSenders !== "reply_token") return msg;
    const token = replyToken(this.d.config.replyTokenSecret!, job.id, b.business_id);
    return {
      ...msg,
      subject: msg.subject.includes(token) ? msg.subject : `${msg.subject} (ref ${token})`,
      bodyText: msg.bodyText.includes(token) ? msg.bodyText : `${msg.bodyText}\n\nReference: ${token} (please keep it when you reply)`,
    };
  }

  /**
   * A reply token is a bearer secret for one conversation (job + business): it may appear only in
   * mail to that business's own address. Any other token in an outgoing email (a vendor's quoted
   * text passed on, a forwarded snippet) is masked, so mail never hands one business's token to
   * another recipient.
   */
  private withoutForeignTokens<T extends { subject: string; bodyText: string }>(job: JobRow, msg: T, b: JobBusinessRow | null): T {
    const own = b && this.d.config.externalSenders === "reply_token" && this.d.config.replyTokenSecret ? replyToken(this.d.config.replyTokenSecret, job.id, b.business_id) : null;
    const mask = (s: string) => s.replace(/HGR-[A-HJ-NP-Z2-9]{10}/gi, (t) => (own && t.toUpperCase() === own && msg.subject.includes(own) ? t : "HGR-…"));
    return { ...msg, subject: mask(msg.subject), bodyText: mask(msg.bodyText) };
  }

  private async sendRfqs(job: JobRow) {
    for (const b of await this.repo.getBusinesses(job.id)) {
      if (b.status !== "pending") continue;
      if (b.channel === "phone") {
        if ((this.d.config.callDelayMs ?? 0) > 0 && this.d.phone && b.phone) {
          // Scheduled: the call goes out after callDelayMs (advanceJob); a first call never cites a price.
          await this.repo.updateBusiness(job.id, b.business_id, { status: "contacted" });
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call to ${b.name} scheduled (Voice AI)`, channel: "phone" });
          continue;
        }
        await this.placeRfqCall(job, b);
        continue;
      }
      if (await this.deferFirstContact(job, b)) continue;
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

  /** The timezone contact hours are counted in: the configured one, else the workspace's. */
  private async contactTimezone(job: JobRow): Promise<string> {
    return this.d.config.contactWindow?.timezone ?? (await this.repo.getWorkspace(job.workspace_id))?.timezone ?? DEFAULT_CONTACT_TIMEZONE;
  }

  /**
   * Outside contact hours (config.contactWindow) a first email or iMessage to a business waits for
   * the next opening (next_attempt_at; runDueContacts sends it), unless that would leave it too little
   * time before the reply-by: then it goes now and the reason is recorded. True = deferred.
   */
  private async deferFirstContact(job: JobRow, b: JobBusinessRow): Promise<boolean> {
    const cfg = this.d.config.contactWindow;
    if (!cfg || (b.channel !== "email" && b.channel !== "imessage")) return false;
    const tz = await this.contactTimezone(job);
    const d = decideFirstContact(this.now(), new Date(job.collect_until), cfg, tz);
    if (d.send) {
      if (d.reason === "deadline") {
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, contact_window: "sent_outside_window", why: d.note, summary: `RFQ to ${b.name} sent outside contact hours: the reply-by doesn't leave time to wait` });
        this.log("contact_outside_window", { job_id: job.id, business_id: b.business_id, why: d.note });
      }
      return false;
    }
    const at = d.until.toISOString();
    if (b.next_attempt_at !== at) {
      await this.repo.updateBusiness(job.id, b.business_id, { next_attempt_at: at }, { ifStatus: ["pending"] });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, contact_window: "deferred", at, summary: `RFQ to ${b.name} scheduled for ${localLabel(d.until, tz)} (outside contact hours)` });
    }
    return true;
  }

  /**
   * Reminders to an email business that hasn't answered the RFQ (config.contactWindow): inside
   * contact hours, the first no sooner than its business-hours spacing after the last email, at most
   * `maxFollowUps`, and never after anything came back from it (even a held reply), a bounce, a
   * failure, an opt-out or the reply-by. Threaded on the RFQ, carrying its reply token.
   */
  private async sendDueReminders(job: JobRow) {
    const cfg = this.d.config.contactWindow;
    if (!cfg || job.state !== "collecting") return;
    const tz = await this.contactTimezone(job);
    const msgs = await this.repo.listMessages(job.id);
    const events = await this.repo.listEvents(job.id);
    for (const b of await this.repo.getBusinesses(job.id)) {
      if (b.channel !== "email" || !b.email || b.status !== "contacted" || b.last_reply_at || !b.contacted_at) continue;
      const mine = msgs.filter((m) => m.business_id === b.business_id);
      const outs = mine.filter((m) => m.direction === "out" && m.channel === "email");
      const rfq = outs.find((m) => m.kind === "rfq");
      if (!rfq || mine.some((m) => m.direction === "in") || outs.some((m) => m.delivery_status)) continue;
      const prefix = `reminder:${job.id}:${b.business_id}:`;
      const sent = outs.filter((m) => m.idempotency_key?.startsWith(prefix)).length;
      // Spacing on the engine's clock: the RFQ's contacted_at, then each reminder's sent_at.
      const last = Math.max(Date.parse(b.contacted_at), ...events.filter((e) => e.data.contact_window === "reminder" && e.data.business_id === b.business_id).map((e) => Date.parse(String(e.data.sent_at))).filter(Number.isFinite));
      const [sup] = await this.repo.findSuppressions([normalizeAddress(b.email)]);
      const d = decideFollowUp({ now: this.now(), lastSentAt: new Date(last), followUpsSent: sent, suppressed: sup?.reason === "bounce", optedOut: sup?.reason === "opt_out", jobOpen: !TERMINAL.has(job.state), replied: false, deadline: new Date(job.collect_until) }, cfg, tz);
      if (!d.send) continue;
      const qty = quantityText(job.request.quantity, job.request.unit);
      const what = `${job.request.what}${qty ? ` for ${qty}` : ""}${job.request.date ? ` on ${eventWhen(job.request.date, job.request.time, job.request.date_until)}` : ""}`;
      try {
        await this.sendRecorded(job, b, "followup", `${prefix}${sent + 1}`, {
          to: b.email, subject: rfq.subject ?? `[HG-${job.short_code}] Quote request: ${job.request.what}`, threadOn: rfq.rfc_message_id,
          bodyText: `Hi ${b.name},\n\nJust following up on the request below for ${what}. If you can quote it, please reply to this email by ${localLabel(new Date(job.collect_until), tz)}. If you can't take it on, a quick "no thanks" helps too. If you'd rather not get requests like this, reply STOP and we won't contact you again.\n\n${this.signOff(job)}`,
        });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, contact_window: "reminder", sent_at: this.now().toISOString(), summary: `Reminder ${sent + 1} of ${cfg.maxFollowUps} sent to ${b.name} (no reply yet)` });
      } catch (err) {
        this.log("reminder_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
      }
    }
  }

  /** First contact on the business's routed channel (also used for retries that come due). */
  private async contactBusiness(job: JobRow, b: JobBusinessRow) {
    // Authorization is re-checked at the moment of first contact, not only at deal(): a vendor the
    // operator removed (consent withdrawn) while its RFQ waited for contact hours is never contacted (S5-D F13).
    if (!b.contacted_at && !b.simulated) {
      const ws = new Set((await this.repo.listWorkspaceVendors(job.workspace_id)).map((v) => v.contact.toLowerCase()));
      const blocked = [b.email ? normalizeAddress(b.email) : null, b.phone, b.a2a_card_url].find((c) => !!c && !this.allowedRecipient(c) && !ws.has(c.toLowerCase()));
      if (blocked) {
        await this.repo.updateBusiness(job.id, b.business_id, { status: "unavailable", next_attempt_at: null }, { ifStatus: ["pending"] });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${b.name} wasn't contacted: it is no longer authorized for this workspace` });
        return;
      }
    }
    if (await this.deferFirstContact(job, b)) return;
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
      // Main's exact event details (a flexible range, the local time, the venue) on every send, retries too.
      ...(r.date ? { date: r.date } : {}), ...(r.date_until ? { date_until: r.date_until } : {}), ...(r.time ? { time: r.time } : {}),
      location: r.area, ...(r.venue ? { venue: r.venue } : {}), requirements: r.requirements.filter((x) => x.hard).map((x) => x.text), replyBy: new Date(job.collect_until),
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
    // Fenced out: another instance owns the job now; this stale holder writes nothing more for it.
    if (err instanceof LeaseLostError) return;
    this.log("send_failed", { job_id: job.id, business_id: b.business_id, what, reason: f?.reason ?? "error", error: (err as Error).message });
    if (f?.ambiguous) {
      // The business may have it (an outcome the provider can't confirm, or an action under operator
      // review): contacted, never bounced and never escalated to a call (that would contact it twice).
      await this.repo.updateBusiness(job.id, b.business_id, { status: "contacted", contacted_at: b.contacted_at ?? this.now().toISOString(), next_attempt_at: null }, { ifStatus: ["pending"] });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${what} to ${b.name}: outcome unknown; not re-sent (an operator reviews it)` });
      return;
    }
    if (f?.retryable && b.send_attempts + 1 < MAX_SEND_ATTEMPTS) {
      const at = new Date(this.now().getTime() + Math.max(f.retryAfterMs, 1_000)).toISOString();
      await this.repo.updateBusiness(job.id, b.business_id, { send_attempts: b.send_attempts + 1, next_attempt_at: at });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${what} to ${b.name} delayed (${f.reason.replace(/_/g, " ")}); retrying` });
      return;
    }
    if (f?.reason === "opted_out") {
      // Asked not to be contacted (our suppression list or the provider's): declined here, and never
      // escalated to a call or a text instead (S5-D F10).
      await this.repo.updateBusiness(job.id, b.business_id, { status: "declined", next_attempt_at: null });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, opt_out: "send_refused_opted_out", summary: `${what} to ${b.name} not sent: it asked not to be contacted; Haggle won't contact it on this deal` });
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
      ...(job.request.date ? { date: job.request.date } : {}), ...(job.request.date_until ? { date_until: job.request.date_until } : {}), ...(job.request.time ? { time: job.request.time } : {}), location: eventPlace(job.request.area, job.request.venue),
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
      const t = await this.a2aSend(job.id, key, { cardUrl: b.a2a_card_url, text: email.bodyText, data: this.rfqPart(job), messageId: `haggle-rfq-${job.id}-${b.business_id}` });
      await this.repo.updateBusiness(job.id, b.business_id, { status: "contacted", contacted_at: this.now().toISOString(), thread_id: t.contextId, rfq_message_id: t.taskId });
      await this.recordA2aOutbound(job, { ...b, thread_id: t.contextId }, "rfq", key, t.taskId, email.bodyText, 1);
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `RFQ sent to ${b.name} (A2A task)`, channel: "a2a" });
    } catch (err) {
      // Claimed by another instance right now (or a retryable outage): tried again later, not given up.
      if (err instanceof ChannelSendError && (err.retryable || err.ambiguous)) return this.onSendFailure(job, b, err, "A2A task");
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
    const short = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    // No (or an unparseable) date: leave it out rather than print "Invalid Date".
    const date = r.date && !Number.isNaN(new Date(`${r.date}T12:00:00Z`).getTime())
      ? (r.date_until && r.date_until > r.date ? `${short(r.date)}-${short(r.date_until)} (flexible)` : short(r.date)) + (r.time ? ` ${humanTime(r.time).replace(":00", "").replace(" ", "").toLowerCase()}` : "")
      : "";
    const needs = [veg ? `${veg.min_count}+ ${/veg/i.test(veg.text) ? "veg" : "special"}` : "", delivery ? "delivered" : ""].filter(Boolean).join(", ");
    // Main's content (units, a count of 1, the venue) in live-demo's persona and shorten-to-fit loop.
    const qty = r.quantity === undefined || (r.quantity === 1 && r.unit && r.unit !== "people") ? "" : ` for ${r.quantity}${r.unit && r.unit !== "people" ? ` ${clean(r.unit, 10)}` : ""}`;
    const place = (n: number) => (!n ? "" : r.venue ? ` at ${clean(r.venue.split(",")[0]!, n + 4)}` : r.area ? ` in ${clean(r.area.split(",")[0]!, n)}` : "");
    const build = (whatN: number, placeN: number, refWord: boolean) =>
      `Hi ${clean(business, 24)}, I'm an AI assistant for ${who}. Quote for ${clean(r.what, whatN)}${qty}${date ? ` on ${date}` : ""}${place(placeN)}${needs ? `: ${needs}` : ""}. Total + deposit? ${refWord ? "Ref " : ""}HG-${job.short_code}`;
    const tries: [number, number, boolean][] = [[24, 18, true], [24, 12, true], [24, 18, false], [24, 12, false], [20, 0, true], [14, 0, true]];
    for (const [w, a, ref] of tries) {
      const t = build(w, a, ref);
      if (t.length <= 159) return t;
    }
    return fitText(build(14, 0, true), 159);
  }

  /**
   * The one confirm-once text ("Thanks! Can you confirm: …? HG-CODE") within Inkbox's limits: ≤ 159
   * chars, no links or phone numbers; the asks are shortened, never the reference code. The firm-total
   * ask (last) is kept whole when anything has to give.
   */
  static confirmIMessageText(asks: string[], shortCode: string): string {
    const clean = (s: string) => s.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/\+?\d[\d\s().-]{6,}\d/g, "").replace(/\s+/g, " ").trim();
    const head = "Thanks! Can you confirm: ";
    const tail = `? HG-${shortCode}`;
    const parts = asks.map(clean).filter(Boolean);
    let ask = parts.join("; ");
    const room = 159 - head.length - tail.length;
    if (ask.length > room) {
      const last = parts.at(-1)!;
      const lead = parts.slice(0, -1).join("; ");
      ask = last.length + 3 >= room ? `${last.slice(0, room - 1).trimEnd()}…` : `${lead.slice(0, room - last.length - 3).trimEnd()}…; ${last}`;
    }
    return `${head}${ask}${tail}`;
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
    // Never text a number that opted out; never send a text another instance is sending right now.
    if ((await this.repo.findSuppressions([b.phone]))[0]) return null;
    try {
      await this.claimSend(key, job.id, "text");
    } catch (err) {
      this.log("text_deferred", { job_id: job.id, business_id: b.business_id, kind, error: (err as Error).message });
      return null;
    }
    // iMessage when it's on; otherwise SMS from the buyer's own number (same text channel).
    const viaSms = !this.d.imessage;
    let delivered = false;
    try {
      const body = fitText(text, viaSms ? SMS_LIMIT : 159);
      const sent = await (viaSms ? this.d.sms!.send({ to: b.phone, text: body, idempotencyKey: key }) : this.d.imessage!.send({ to: b.phone, text: body, idempotencyKey: key })).catch(async (e: unknown) => {
        await this.outboxFailed(key, job.id, "text", e instanceof ChannelSendError && e.ambiguous ? "unknown" : "not_sent", e);
        throw e;
      });
      delivered = true;
      await this.repo.finishOutbox(key, "sent", sent.messageId, this.now().toISOString());
      if (viaSms) await this.noteTextRoute(job, b.phone, "business", { businessId: b.business_id });
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
      // Delivered but not recorded (a database outage): never a bounce. The claim stays pending and
      // is re-sent under the same provider key once stale (the provider replays the original send).
      if (delivered) {
        this.log("send_record_failed", { job_id: job.id, key, error: redactError(err) });
        if (kind !== "rfq") throw err;
        return null;
      }
      if (kind === "rfq" && err instanceof ChannelSendError && err.ambiguous) {
        await this.repo.updateBusiness(job.id, b.business_id, { status: "contacted", contacted_at: this.now().toISOString() }, { ifStatus: ["pending"] });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Text to ${b.name}: outcome unknown; not re-sent (an operator reviews it)`, channel: "imessage" });
        return null;
      }
      if (kind === "rfq") {
        await this.repo.updateBusiness(job.id, b.business_id, { status: "bounced" });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: viaSms ? `Text to ${b.name} failed` : `Couldn't text ${b.name}: ${imessageFailureReason((err as Error).message, job.inbox.split("@")[0]!)}`, channel: "imessage" });
      }
      this.log("imessage_business_failed", { job_id: job.id, business_id: b.business_id, kind, error: (err as Error).message });
      if (kind !== "rfq") throw err;
      return null;
    }
  }

  /**
   * Haggle's own text line (its number; "default" when the identity's number isn't known). Routes and
   * held texts are keyed by (line, remote number), so a second line never answers for the first.
   */
  private textLine(): string {
    return this.d.config.identity?.phone?.replace(/[\s().-]/g, "") || "default";
  }

  /**
   * Record what Haggle last texted a number for this job (text_routes, durable and workspace-scoped):
   * a text back from that number answers it, on any instance and after a restart. Best effort.
   */
  private async noteTextRoute(job: JobRow, remote: string, purpose: "human" | "business", ids: { businessId?: string; questionId?: string; approvalId?: string }) {
    await this.repo.recordTextRoute({
      line: this.textLine(), remote, workspace_id: job.workspace_id, job_id: job.id, purpose, business_id: purpose === "business" ? ids.businessId ?? null : null,
      question_id: purpose === "human" ? ids.questionId ?? null : null, approval_id: purpose === "human" ? ids.approvalId ?? null : null, last_out_at: this.now().toISOString(),
    }).catch((err: Error) => this.log("text_route_failed", { job_id: job.id, error: err.message.slice(0, 200) }));
  }

  /** What Haggle last texted this number within the scope (never another workspace's deal). */
  private async lastTextRoute(remote: string, scope: TextScope) {
    return lastRoute(await this.repo.listTextRoutes(this.textLine(), remote), scope);
  }

  private notified = new Set<string>();
  /** `${to}|${text}` already texted: the same words again (a re-read, an unchanged revision) aren't news. */
  private notifiedText = new Set<string>();
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
    const blocked = c.now ? null : await this.callBlockedUntil(job, b.phone, c.kind);
    if (blocked) {
      const at = blocked.toISOString();
      if (!(await this.repo.listEvents(job.id)).some((e) => e.type === "call_scheduled" && e.data.key === c.key)) {
        await this.repo.appendEvent(job.id, "call_scheduled", { business_id: b.business_id, key: c.key, kind: c.kind, reason: c.reason, body: c.body, round: c.round ?? null, approval_id: c.approvalId ?? null, at });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call to ${b.name} scheduled for ${at} (call hours or a recent call)`, channel: "phone" });
      }
      return { placed: null, scheduledFor: at };
    }
    const { callId } = await this.placeCallOnce(job.id, { jobId: job.id, businessId: b.business_id, toNumber: b.phone, reason: c.reason, idempotencyKey: c.key });
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
    const events = await this.repo.listEvents(job.id);
    const dropped = new Set(events.filter((e) => e.type === "call_dropped").map((e) => String(e.data.key)));
    // One entry per key: the latest schedule wins (a failed placement re-schedules its key).
    const latest = new Map<string, (typeof scheduled)[number]>();
    for (const e of scheduled) latest.set(String(e.data.key), e);
    for (const e of latest.values()) {
      const d = e.data;
      const key = String(d.key);
      if (dropped.has(key) || Date.parse(String(d.at)) > now) continue;
      if (await this.repo.findMessageByIdempotencyKey(key)) continue;
      const b = businesses.find((x) => x.business_id === d.business_id);
      if (!b?.phone) continue;
      const what = d.kind === "counter" ? "Counteroffer call" : d.kind === "answer" ? "Call with the answer" : "Call";
      // A counteroffer call only makes sense while its round is open: once quotes are final it is
      // never placed, and the board says so (never silently dropped).
      if (d.kind === "counter" && (job.state !== "negotiating" || job.ready)) {
        await this.dropScheduledCall(job, b, key, `${what} to ${b.name} not placed: the negotiation round had closed`);
        continue;
      }
      const failures = events.filter((x) => x.type === "call_failed" && x.data.key === key);
      const lastFailure = failures.at(-1);
      if (lastFailure && now - Date.parse(String(lastFailure.data.failed_at ?? lastFailure.at)) < (this.d.config.callRetryMs ?? CALL_RETRY_MS)) continue;
      try {
        const r = await this.callBusiness(job, b, { key, kind: d.kind as MessageRow["kind"], reason: String(d.reason), body: String(d.body), round: d.round == null ? null : Number(d.round), approvalId: d.approval_id == null ? null : String(d.approval_id) });
        if (!r.placed) continue;
        if (!["quoted", "declined"].includes(b.status)) await this.repo.updateBusiness(job.id, b.business_id, { status: "ringing" });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Calling ${b.name} (Voice AI, ${d.kind === "counter" ? "counteroffer" : d.kind === "answer" ? "answer to its question" : d.kind})`, channel: "phone" });
      } catch (err) {
        const error = clip((err as Error).message, 160);
        this.log("call_failed", { job_id: job.id, business_id: b.business_id, key, error });
        await this.repo.appendEvent(job.id, "call_failed", { business_id: b.business_id, key, error, failed_at: this.now().toISOString() });
        if (failures.length + 1 >= CALL_MAX_ATTEMPTS) await this.dropScheduledCall(job, b, key, `${what} to ${b.name} not placed after ${failures.length + 1} tries (${clip(error, 100)})`);
        else await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${what} to ${b.name} couldn't be placed (${clip(error, 100)}); retrying in a minute`, channel: "phone" });
      }
    }
  }

  /** A scheduled call that will never be placed: recorded once (call_dropped) and shown on the board with the reason. */
  private async dropScheduledCall(job: JobRow, b: JobBusinessRow, key: string, summary: string) {
    if ((await this.repo.listEvents(job.id)).some((e) => e.type === "call_dropped" && e.data.key === key)) return;
    this.log("call_dropped", { job_id: job.id, business_id: b.business_id, key, reason: summary });
    await this.repo.appendEvent(job.id, "call_dropped", { business_id: b.business_id, key, reason: summary });
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary, channel: "phone" });
  }

  /** An A2A message task in the business's open context (follow-up, answer, message), recorded once per key. */
  private async sendA2aMessage(job: JobRow, b: JobBusinessRow, kind: "followup" | "answer" | "message", key: string, text: string): Promise<MessageRow | null> {
    const prior = await this.repo.findMessageByIdempotencyKey(key);
    if (prior) return prior;
    if (!this.d.a2a || !b.a2a_card_url || !b.thread_id) return null;
    const t = await this.a2aSend(job.id, key, { cardUrl: b.a2a_card_url, text, data: { haggle: "message/1", protocol: "haggle.v0", type: kind, job_id: job.id }, messageId: `haggle-${key.replace(/:/g, "-")}`, contextId: b.thread_id });
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

  /**
   * Quotes are final (collection and any negotiation round are over): one text per round tells the
   * human, the action they need to take. The recommendation is the board's (recommended_quote_id:
   * best value among quotes the human can approve; never the model's, never a raw price pick). It
   * opens a pending approval for exactly that quote and the text says how to approve it by reply
   * (YES <code> approves; the assistant's pay then charges it); only the human's YES or tap decides.
   * That suggestion never locks the other options: choosing another quote (board or approve) or
   * another negotiation round replaces it (supersedeAutoApproval). Nothing is texted when no quote can
   * be approved, nor without SMS and a number to text (e.g. mock mode).
   */
  private async offerReady(jobId: string) {
    const job = await this.repo.getJob(jobId);
    if (!job || !job.ready || (job.state !== "collecting" && job.state !== "negotiating") || !this.d.sms) return;
    const events = await this.repo.listEvents(jobId);
    if (!events.some((e) => e.type === "ready" && Number(e.data.round) === job.round)) return;
    // Offered once per round; an offer cut short by a lost lease (nothing reached the human) is offered again.
    const offers = (type: string) => events.filter((e) => e.type === type && Number(e.data.round) === job.round).length;
    if (offers("ready_offered") > offers("ready_offer_lost")) return;
    if (!(await this.notifyTarget(job))) return;
    // A reply that came in just now (its webhook lost) is read before Haggle recommends anything.
    if (await this.reconcileJob(jobId)) await this.parsePending(job);
    await this.repo.appendEvent(jobId, "ready_offered", { round: job.round });
    try {
      const { quotes } = await this.rankRows(job);
      const q = await this.recommendedQuote(job);
      if (!q) {
        // Approvable quotes that each miss a must: no YES suggestion (a miss never wins by default),
        // but the human hears that quotes are final and what the best available one misses.
        const best = await this.bestAvailable(job);
        if (best && best.q.total_cents !== null) {
          const n = quotes.filter((x) => x.total_cents !== null).length;
          await this.repo.appendEvent(jobId, "reply", { business_id: null, kind: "ready_none_compliant", quote_id: best.q.id, summary: `Quotes are final, but none meets every requirement; best available: ${await this.businessName(jobId, best.q.business_id)} (${complianceSummary(best.compliance)}). Nothing was recommended.` });
          await this.notifyHuman(job, `ready:${job.round}`, `All quotes are in for ${clip(job.request.what, 40)} (${n}). None meets everything you asked; closest: ${clip(await this.businessName(jobId, best.q.business_id), 24)} ${usdText(best.q.total_cents)} (${clip(complianceSummary(best.compliance, 1), 60)}). Choose on the deal board in Claude.`);
          return;
        }
        // Nothing the human can approve yet (decision 23): no text; the board explains each option.
        await this.repo.appendEvent(jobId, "reply", { business_id: null, kind: "ready_not_texted", summary: "Quotes are final, but no quote can be approved yet (see each option on the deal board); nothing was texted." });
        return;
      }
      const name = await this.businessName(jobId, q.business_id);
      const n = quotes.filter((x) => x.total_cents !== null).length;
      const head = `All quotes are in for ${clip(job.request.what, 50)} (${n} quote${n === 1 ? "" : "s"})`;
      // The human already said no to this exact quote: tell them, don't ask again.
      const declined = new Set(events.filter((e) => e.type === "approval_declined").map((e) => String(e.data.approval_id)));
      const declinedQuote = q && events.some((e) => e.type === "approval_requested" && e.data.quote_id === q.id && declined.has(String(e.data.approval_id)));
      if (q.total_cents && !declinedQuote) {
        try {
          const a = await this.openApproval(jobId, q.id, "imessage", undefined, { text: true, email: false }, true);
          if (await this.repo.findMessageByIdempotencyKey(`sms:${sendKeys.approvalRequest(a.id)}`) || (await this.isHeld(a.id))) {
            await this.repo.appendEvent(jobId, "reply", {
              business_id: null, kind: "ready_texted", approval_id: a.id,
              summary: `All quotes are in: texted the user Haggle's recommendation, ${name} ${usdText(q.total_cents)} (${a.payment_cents > 0 ? `a reply YES approves ${usdText(a.payment_cents)}; ${this.afterYes()}` : "a reply YES confirms it, nothing paid"}). If the user picks another quote (board or approve), that replaces the suggestion.`,
            });
            return;
          }
          // Not sent (and not held for later): no dangling suggestion; the board still offers every option.
          await this.supersedeAutoApproval(job, a, "the text didn't go through");
        } catch (err) {
          // Over the payment ceiling, no amount to pay, ...: the human still hears that quotes are final.
          this.log("ready_approval_skipped", { job_id: jobId, error: (err as Error).message.slice(0, 200) });
        }
        await this.notifyHuman(job, `ready:${job.round}`, `${head}. Recommended: ${clip(name, 30)} ${usdText(q.total_cents)}. Choose and approve on the deal board in Claude.`);
        return;
      }
      if (q.total_cents) await this.notifyHuman(job, `ready:${job.round}`, `${head}. Recommended: ${clip(name, 30)} ${usdText(q.total_cents)}. See every option on the deal board in Claude.`);
    } catch (err) {
      this.log("notify_failed", { job_id: jobId, key: "ready", error: (err as Error).message });
    } finally {
      // The lease was lost during the offer: its texts were fenced (never sent). The next advance (this
      // instance's or the new holder's) offers again; texts that did go out are deduped by their keys,
      // and a suggestion still pending keeps the job awaiting approval, so nothing is offered twice.
      if (this.fenced(jobId)) await this.repo.appendEvent(jobId, "ready_offer_lost", { round: job.round }).catch(() => undefined);
    }
  }

  /**
   * The board's recommendation (getQuotes recommended_quote_id): the best-value eligible quote that
   * the human can approve (no approval block, within the per-payment ceiling), else null. Never
   * advances the job (it runs inside an advance).
   */
  private async recommendedQuote(job: JobRow, pre?: { all: QuoteRow[]; businesses: JobBusinessRow[] }): Promise<QuoteRow | null> {
    const all = pre?.all ?? (await this.repo.listQuotes(job.id));
    const { quotes, ranking, capCents } = await this.rankRows(job, all);
    const byId = new Map((pre?.businesses ?? (await this.repo.getBusinesses(job.id))).map((b) => [b.business_id, b]));
    const eligible = new Set(ranking.ranked.map((r) => r.quoteId));
    const value = await this.valueRanking(job, quotes.filter((q) => eligible.has(q.id) && q.total_cents !== null), all, byId, ranking.caveats);
    // A request compared on a non-money answer (earliest date) recommends in the ranker's compare_by order.
    const orderIds = nonMoneyCompare(job.request) ? ranking.ranked.map((r) => r.quoteId) : value.ranked.map((r) => r.quoteId);
    // Never a quote that misses a must (unmet or unconfirmed requirement, over budget, pay-now over the
    // cap): Haggle doesn't pick one of those for the human; they may still choose it knowingly.
    // Nor a stale real quote: it is re-confirmed with the business before anyone can approve it.
    const events = await this.repo.listEvents(job.id);
    for (const id of orderIds) {
      const q = quotes.find((x) => x.id === id);
      const b = q ? byId.get(q.business_id) : undefined;
      if (q && this.approvalBlock(job, q, b, false) === null && this.complianceOf(job, q, capCents).status === "compliant" && (b?.simulated || !this.freshnessOf(q, events).stale)) return q;
    }
    return null;
  }

  /** The best approvable quote when none is compliant (shown as "best available", never recommended), with what it misses. */
  private async bestAvailable(job: JobRow): Promise<{ q: QuoteRow; compliance: Compliance } | null> {
    const all = await this.repo.listQuotes(job.id);
    const { quotes, ranking, capCents } = await this.rankRows(job, all);
    const byId = new Map((await this.repo.getBusinesses(job.id)).map((b) => [b.business_id, b]));
    for (const r of ranking.ranked) {
      const q = quotes.find((x) => x.id === r.quoteId);
      if (q && this.approvalBlock(job, q, byId.get(q.business_id), false) === null) return { q, compliance: this.complianceOf(job, q, capCents) };
    }
    return null;
  }

  /** "Haggle: All quotes are in for … Recommended: X $1,150 (deposit $100). See every option in Claude, or reply YES 1234 to approve …" */
  private async readyApprovalText(job: JobRow, a: ApprovalRow): Promise<string> {
    const name = clip(await this.businessName(job.id, a.business_id), 30);
    const n = (await this.repo.listQuotes(job.id)).filter((q) => q.status === "current" && q.total_cents !== null).length;
    const deposit = a.payment_cents > 0 && a.payment_cents < a.quote_total_cents;
    // Approve, then pay (decisions 2, 48): YES approves the amount; a texted PAY <code> (or the
    // assistant's pay) charges it. Without a payment rail only the assistant's pay is mentioned.
    // Manual rail: nothing is charged by text or by the assistant; the business confirms first, then the human pays it directly.
    const manual = this.d.config.manualPaymentHandoff === true;
    const payByText = a.payment_cents > 0 && this.paymentsEnabled && !manual;
    const act = a.payment_cents <= 0 ? `confirm ${name} (nothing is paid)` : manual ? `approve the ${usdText(a.payment_cents)}${deposit ? " deposit" : ""} to ${name} (they confirm before you pay them directly)` : `approve the ${usdText(a.payment_cents)}${deposit ? " deposit" : ""} to ${name}${payByText ? "" : " (your assistant then pays it)"}`;
    const then = payByText ? `, then PAY ${a.code} to charge it` : "";
    // A replacement suggestion (a better quote after "all quotes are in"): says what changed.
    const update = (await this.repo.listEvents(job.id)).find((e) => e.type === "approval_requested" && e.data.approval_id === a.id)?.data.update;
    if (typeof update === "string" && update) {
      return `Haggle update: ${update}. Reply YES ${a.code} to ${act} instead${then}; the earlier code no longer works. (HG-${job.short_code})`.slice(0, SMS_LIMIT);
    }
    const tail = `See every option in Claude, or reply YES ${a.code} to ${act}${then}. (HG-${job.short_code})`;
    const rec =`Recommended: ${name} ${usdText(a.quote_total_cents)}${deposit ? ` (deposit ${usdText(a.payment_cents)})` : ""}.`;
    // The code is never cut: the request summary gives way first.
    const facts = HaggleEngine.orderFacts(job.request);
    const about = facts ? `${job.request.what}, ${facts}` : job.request.what;
    const room = SMS_LIMIT - `Haggle: All quotes are in for  (${n} quotes). ${rec} ${tail}`.length;
    return `Haggle: All quotes are in for ${clip(about, Math.max(12, room))} (${n} quote${n === 1 ? "" : "s"}). ${rec} ${tail}`.slice(0, SMS_LIMIT);
  }

  /** True for Haggle's own "all quotes are in" approval that nobody has claimed: choosing another quote replaces it. */
  private async isAutoApproval(jobId: string, approvalId: string): Promise<boolean> {
    return isAutoIn(await this.repo.listEvents(jobId), approvalId);
  }

  /**
   * Replace Haggle's own pending suggestion (never an approval the human or agent asked for): it is
   * marked expired with the reason, the job goes back to its final quotes, and a late YES for its
   * code is told it was replaced (nothing paid). Returns false when it was already decided.
   */
  private async supersedeAutoApproval(job: JobRow, a: ApprovalRow, reason: string): Promise<boolean> {
    const ok = await this.repo.transitionApproval(a.id, "pending", { status: "expired", decided_at: this.now().toISOString() });
    if (!ok) return false;
    await this.repo.appendEvent(job.id, "approval_superseded", { approval_id: a.id, quote_id: a.quote_id, reason });
    await this.fire(job.id, { type: "approval_void" });
    return true;
  }

  /**
   * A better quote after "all quotes are in" (a late reply, or one the inbound sweep recovered): the
   * board shows it at once. Haggle's own unclaimed suggestion is replaced (the old one expires, so
   * its code can never approve) by one for the new best quote, and the human is texted once: "Update:
   * Sunset Kitchen lowered to $2,660 (now the best). Reply YES 5678 to approve … instead." An approval
   * the human or agent chose is never replaced; the human is told once instead. Live HG-2QAM: the
   * $2,660 never reached the board and the human paid Mission Eats' $2,740.
   */
  private async reviseSuggestion(jobId: string) {
    const job = await this.repo.getJob(jobId);
    if (!job || !job.ready || !this.d.sms || !["awaiting_approval", "collecting", "negotiating"].includes(job.state)) return;
    const a = await this.repo.getLatestApproval(jobId);
    if (!a) return;
    const events = await this.repo.listEvents(jobId);
    const auto = events.some((e) => e.type === "approval_requested" && e.data.approval_id === a.id && e.data.auto === "ready")
      && !events.some((e) => e.type === "approval_claimed" && e.data.approval_id === a.id);
    // Haggle's suggestion voided because its own business revised its quote (onRevision) is renewed too.
    const revisedAway = a.status === "expired" && events.some((e) => e.type === "approval_void" && e.data.approval_id === a.id && /revised/.test(String(e.data.reason)));
    if (a.status !== "pending" && !(auto && revisedAway)) return;
    const pay = await this.repo.getPaymentForJob(jobId);
    if (pay && pay.approval_id === a.id) return; // money is moving for it
    // The board's recommendation (value-ranked, approvable), the same one offerReady texted.
    const q = await this.recommendedQuote(job);
    if (!q || q.total_cents === null || q.id === a.quote_id) return;
    // Only news: the quote arrived after the suggestion was made (event order, not clock time).
    const quoteSeq = events.find((e) => e.type === "quote" && e.data.quote_id === q.id)?.seq;
    const askedSeq = events.find((e) => e.type === "approval_requested" && e.data.approval_id === a.id)?.seq;
    if (quoteSeq === undefined || askedSeq === undefined || quoteSeq < askedSeq) return;
    if (events.some((e) => e.type === "suggestion_revised" && e.data.quote_id === q.id)) return;
    const name = clip(await this.businessName(jobId, q.business_id), 30);
    const all = await this.repo.listQuotes(jobId);
    const earlier = events.filter((e) => e.type === "quote" && e.data.business_id === q.business_id && e.seq < quoteSeq).at(-1);
    const before = earlier ? all.find((x) => x.id === earlier.data.quote_id && x.total_cents !== null) : undefined;
    const verb = !before ? "quoted" : before.total_cents! > q.total_cents ? "lowered to" : "revised to";
    const what = `${name} ${verb} ${usdText(q.total_cents)} (now the best)`;
    await this.repo.appendEvent(jobId, "suggestion_revised", { quote_id: q.id, replaced_approval_id: a.id, auto });
    if (!auto) {
      const chosen = clip(await this.businessName(jobId, a.business_id), 30);
      await this.repo.appendEvent(jobId, "reply", { business_id: null, kind: "better_quote", summary: `${what}, after ${chosen} ${usdText(a.quote_total_cents)} was sent for approval. That approval stands until someone chooses otherwise.` });
      await this.notifyHuman(job, `better:${q.id}`, `Update: ${what}. The approval waiting for you is ${chosen} ${usdText(a.quote_total_cents)}; to switch, choose ${name} on the deal board in Claude.`);
      return;
    }
    // The human's YES for the old code may have won meanwhile: then it stands (the CAS refuses).
    if (a.status === "pending" && !(await this.supersedeAutoApproval(job, a, `a better quote arrived: ${what}`))) return;
    try {
      const next = await this.openApproval(jobId, q.id, "imessage", undefined, { text: true, email: false }, true, what);
      await this.repo.appendEvent(jobId, "reply", {
        business_id: null, kind: "ready_texted", approval_id: next.id,
        summary: `Update: ${what}. Haggle's recommendation now is ${name}${(await this.repo.findMessageByIdempotencyKey(`sms:${sendKeys.approvalRequest(next.id)}`)) ? "; texted the user the new code (the earlier one no longer works)" : ""}.`,
      });
    } catch (err) {
      this.log("revised_approval_skipped", { job_id: jobId, error: (err as Error).message.slice(0, 200) });
      await this.notifyHuman(job, `better:${q.id}`, `Update: ${what}. The earlier recommendation was withdrawn; choose and approve on the deal board in Claude.`);
    }
  }

  /** An explicit request for the quote Haggle already suggested: send the channels it asks for (best effort). */
  private async deliverClaimed(job: JobRow, a: ApprovalRow, channel: ApprovalRow["channel"], offer?: ApprovalOffer) {
    const settings = await this.getSettings(job.workspace_id);
    if (channel === "imessage" && this.d.imessage && settings.approver_phone) {
      await this.sendApprovalIMessage(job, a).catch(async (err: Error) => {
        await this.repo.appendEvent(job.id, "approval_imessage_failed", { approval_id: a.id, error: err.name });
      });
    }
    const approverEmail = job.approver_email ?? (settings.approver_email ? normalizeAddress(settings.approver_email) : null);
    if ((channel === "email" || offer?.email) && approverEmail) {
      if (!job.approver_email) await this.repo.touchJob(job.id, { approver_email: approverEmail });
      await this.sendApprovalEmail({ ...job, approver_email: approverEmail }, a).catch(async (err: Error) => {
        await this.repo.appendEvent(job.id, "approval_email_failed", { approval_id: a.id, error: err.name });
      });
    }
    if (offer?.text) await this.sendApprovalSms(job, a).catch(() => undefined); // already sent: a no-op
  }

  /** Texts that need the human (questions, approvals, results) refused while their number was paused are held (held_texts) until it texts back. */
  private async isHeld(approvalId: string): Promise<boolean> {
    return this.repo.isApprovalHeld(approvalId).catch(() => false);
  }

  /**
   * Who gets update texts (and whose coded replies decide) for this job: the workspace's own
   * approver. The operator's notify number stands in only for the default workspace (single-tenant
   * servers); it never receives, or decides, another workspace's approvals.
   */
  private async notifyTarget(job: JobRow): Promise<string | null> {
    if (!this.d.sms) return null;
    const approver = (await this.getSettings(job.workspace_id)).approver_phone;
    if (job.workspace_id !== DEFAULT_WORKSPACE_ID) return approver || null;
    return this.d.config.notifyPhone?.trim() || approver || null;
  }

  /**
   * Text the human. Only when they must act or money moved: business questions, quotes are final
   * (offerReady), an approval, the payment result, a deal that failed, replies to their own texts.
   * Never per quote or per call (the deal board shows those), which also keeps Inkbox's 10 texts
   * without a reply for what matters. Best effort: a failed text never blocks the deal. One text per
   * key (also Inkbox-idempotent across restarts), never the same words twice; the reply comes back
   * through ingestText.
   */
  private async notifyHuman(job: JobRow, key: string, text: string, questionId?: string) {
    const idempotencyKey = `notify:${job.id}:${key}`;
    if (this.notified.has(idempotencyKey)) return;
    try {
      const to = await this.notifyTarget(job);
      if (!to) return;
      const body = `Haggle: ${text} (HG-${job.short_code})`.slice(0, SMS_LIMIT);
      if (this.notifiedText.has(`${to}|${body}`)) return;
      await this.textHuman(job, to, { key: idempotencyKey, text: body, ...(questionId ? { questionId } : {}) });
    } catch (err) {
      this.log("notify_failed", { job_id: job.id, key, reason: "error", error: (err as Error).message });
    }
  }

  /**
   * Send one text to the human through the text budget. Never throws: a refusal is logged with its
   * reason and noted on the deal once, and a text that needs the human is held until they reply.
   */
  private async textHuman(job: JobRow, to: string, t: HeldText & { attempt?: number }): Promise<{ ok: true; messageId: string } | { ok: false; reason: string }> {
    const budget = this.textBudget!;
    const short = t.key.replace(`notify:${job.id}:`, "");
    if (!(await this.stillLeased(job.id))) return { ok: false, reason: "lease_lost" };
    if (budget.isBlocked(to)) {
      const reason = budget.blockReason(to) ?? "unanswered_limit";
      await this.holdText(to, job, t);
      this.log("notify_held", { job_id: job.id, key: short, reason });
      if (reason === "unanswered_limit") await this.noteTextsPaused(job, to);
      return { ok: false, reason };
    }
    // Durable dedupe across restarts and instances (the in-memory sets are per process). Fails
    // closed: a text whose claim can't be made or re-made (the database is down, another instance
    // re-claimed it, it is under operator review) is not sent from here.
    try {
      const c = await this.repo.claimOutbox({ key: t.key, job_id: job.id, kind: "text" }, this.now().toISOString());
      if (!c.fresh) {
        if (c.row.status === "sent") return { ok: true, messageId: c.row.provider_ref ?? "" };
        const d = decideClaim({ kind: "text", key: t.key, row: c.row, nowMs: this.now().getTime(), staleMs: OUTBOX_STALE_MS, underReview: !!(await this.repo.findOpenReview("outbox", t.key)) });
        if (d.action === "defer") return { ok: false, reason: "in_flight" };
        if (d.action === "review") await this.deadLetter({ kind: "outbox", subject: t.key, job_id: job.id, reason: d.reason, attempts: c.row.attempts });
        if (d.action !== "send" || !(await this.repo.reclaimOutbox(t.key, ["pending", "not_sent", "unknown"], this.now().toISOString()))) return { ok: false, reason: d.action === "send" ? "in_flight" : "not_retried" };
      }
    } catch (err) {
      this.log("notify_outbox_failed", { job_id: job.id, key: short, error: redactError(err) });
      return { ok: false, reason: "outbox_unavailable" };
    }
    this.notified.add(t.key);
    try {
      // A retry gets a fresh provider key: Inkbox may replay a refused send for the old one.
      const sent = await this.d.sms!.send({ to, text: t.text, idempotencyKey: t.attempt ? `${t.key}:retry:${t.attempt}` : t.key });
      await this.repo.finishOutbox(t.key, "sent", sent.messageId, this.now().toISOString()).catch(() => undefined);
      this.notifiedText.add(`${to}|${t.text}`);
      // Only a question or an approval expects the human's reply; other updates don't change where a reply goes.
      if (t.questionId || t.approvalId) await this.noteTextRoute(job, to, "human", { ...(t.questionId ? { questionId: t.questionId } : {}), ...(t.approvalId ? { approvalId: t.approvalId } : {}) });
      return { ok: true, messageId: sent.messageId };
    } catch (err) {
      this.notified.delete(t.key);
      await this.repo.finishOutbox(t.key, "not_sent", null, this.now().toISOString()).catch(() => undefined);
      const blocked = isUnansweredLimitError(err);
      const reason = blocked ? "unanswered_limit" : err instanceof ChannelSendError ? err.reason : "error";
      this.log(blocked ? "notify_blocked" : "notify_failed", { job_id: job.id, key: short, reason, error: (err as Error).message.slice(0, 300) });
      if (blocked) {
        await this.holdText(to, job, t);
        await this.noteTextsPaused(job, to);
      }
      return { ok: false, reason };
    }
  }

  private async holdText(to: string, job: JobRow, t: HeldText) {
    await this.repo.holdText({ line: this.textLine(), remote: to, key: t.key, workspace_id: job.workspace_id, job_id: job.id, text: t.text, question_id: t.questionId ?? null, approval_id: t.approvalId ?? null }, 3)
      .catch((err: Error) => this.log("hold_text_failed", { job_id: job.id, error: err.message.slice(0, 200) }));
  }

  /** Once per deal and pause: say on the deal (wait_for_update) why texts stopped and how to resume. */
  private async noteTextsPaused(job: JobRow, to: string) {
    const k = `${to}|${job.id}|blocked`;
    if (this.pausedNoted.has(k)) return;
    this.pausedNoted.add(k);
    await this.repo.appendEvent(job.id, "reply", {
      business_id: null, channel: "phone",
      summary: "Texts to you are paused: Inkbox holds texts after 10 with no reply. Text Haggle back (e.g. RESUME) and it re-sends what you missed; the deal board is up to date.",
    }).catch(() => undefined);
  }

  /** Any text from a number lifts Inkbox's pause on it and resets its count. */
  private textReplied(from: string) {
    if (!this.textBudget) return;
    this.textBudget.replied(from);
    for (const k of [...this.pausedNoted]) if (k.startsWith(`${from}|`)) this.pausedNoted.delete(k);
  }

  /** Re-send what the human missed while paused (still-open questions and approvals, results). */
  private async flushHeldTexts(from: string) {
    // Taken atomically: another instance flushing the same number gets none of them.
    const held = await this.repo.takeHeldTexts(this.textLine(), from).catch(() => []);
    for (const row of held) {
      const h = { jobId: row.job_id, key: row.key, text: row.text, ...(row.question_id ? { questionId: row.question_id } : {}), ...(row.approval_id ? { approvalId: row.approval_id } : {}) };
      try {
        const job = await this.repo.getJob(h.jobId);
        // Re-sent only to the job's own human: if its workspace's approver changed meanwhile, it isn't this number's any more.
        if (!job || (await this.notifyTarget(job)) !== from) continue;
        if (h.approvalId) {
          const a = await this.repo.getApproval(h.approvalId);
          if (a?.status === "pending") await this.sendApprovalSms(job, a, this.now().getTime());
          else if (a?.status === "expired" && !TERMINAL.has(job.state) && /All quotes are in/.test(h.text)) {
            // Haggle's suggestion expired while texts were paused: the human still needs to hear quotes are final.
            await this.notifyHuman(job, `ready-late:${a.id}`, `${h.text.replace(/^Haggle: /, "").replace(/ See every option.*$/, "")} See every option and choose on the deal board in Claude.`);
          }
          continue;
        }
        if (h.questionId && (await this.repo.listQuestions(job.id)).find((q) => q.id === h.questionId)?.status !== "pending") continue;
        const { jobId: _j, ...text } = h;
        await this.textHuman(job, from, { ...text, attempt: this.now().getTime() });
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
  async ingestText(m: { messageId: string; from: string; text: string; inbound?: boolean; to?: string }): Promise<{ jobId: string | null; outcome: string }> {
    if (m.inbound === false) return { jobId: null, outcome: "outbound" };
    const from = m.from.replace(/[\s().-]/g, "");
    // A text to another of Haggle's numbers isn't this line's to answer (routes are per line).
    const to = m.to?.replace(/[\s().-]/g, "");
    if (to && /^\+\d{8,15}$/.test(to) && this.textLine() !== "default" && to !== this.textLine()) return { jobId: null, outcome: "not_our_line" };
    if (await this.repo.findMessageByProviderId(`sms-in:${m.messageId}`)) return { jobId: null, outcome: "duplicate" };
    // A bare carrier opt-out keyword (STOP, CANCEL, END...): the carrier may now block texts to this
    // number, so nothing more is texted to it (held) until it texts again, e.g. START (docs/carrier-keywords.md).
    if (isCarrierOptOut(m.text)) {
      this.textBudget?.carrierOptOut(from);
      return this.routeText(m, from);
    }
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
  private async ingestTextApproval(m: { messageId: string; text: string }, from: string, open: JobRow[], last: ReturnType<typeof lastRoute>): Promise<{ jobId: string | null; outcome: string } | null> {
    const parsed = m.text.trim().match(TEXT_DECISION);
    if (!parsed) return null;
    const texted: ApprovalRow[] = [];
    const mine: JobRow[] = []; // open deals this number approves for now
    for (const job of open) {
      if (from !== (await this.notifyTarget(job))) continue;
      mine.push(job);
      const a = await this.repo.getLatestApproval(job.id);
      if (a && (await this.repo.findMessageByIdempotencyKey(`sms:${sendKeys.approvalRequest(a.id)}`))) texted.push(a);
      // Haggle's earlier texted suggestions that a better quote replaced (reviseSuggestion): their code
      // is answered "replaced", never taken as a wrong code against the new suggestion (lockout).
      if (!parsed[2]) continue;
      for (const e of (await this.repo.listEvents(job.id)).filter((x) => x.type === "approval_superseded" && x.data.approval_id !== a?.id)) {
        const old = await this.repo.getApproval(String(e.data.approval_id));
        if (old && old.code === parsed[2] && !texted.some((x) => x.id === old.id)) texted.push(old);
      }
    }
    // The approval texted last may belong to a deal that has since closed (approved on the card and paid).
    // Only while this number is still that deal's approver: a replaced approver's phone (lost, or the
    // operator changed it) keeps its old text route but never decides (S5-D F1).
    if (last?.approvalId && !texted.some((a) => a.id === last.approvalId)) {
      const a = await this.repo.getApproval(last.approvalId);
      const aJob = a ? await this.repo.getJob(a.job_id) : null;
      if (a && aJob && from === (await this.notifyTarget(aJob))) texted.push(a);
    }
    const pending = texted.filter((a) => a.status === "pending");
    const code = parsed[2];
    if (code && !pending.some((a) => a.code === code)) {
      // Already decided elsewhere (the card, email) or unknown: tell the human, never forward the code.
      const decided = texted.find((a) => a.code === code);
      if (decided || pending.length === 0) {
        // Recorded and answered only on a deal this number approves for: never another workspace's (S5-D F2).
        const job = await this.repo.getJob(decided?.job_id ?? texted.find((a) => a.id === last?.approvalId)?.job_id ?? mine[0]?.id ?? "");
        const stored = job ? await this.repo.insertMessage({
          job_id: job.id, business_id: null, approval_id: decided?.id ?? null, direction: "in", kind: "approval_reply", channel: "imessage", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
          rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 500), attachments: [], attachments_download_url: null,
          sender_trusted: true, trust_reason: "sms-from-text-approver", matched_via: "approval_code", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
        }) : null;
        if (job && !stored) return { jobId: job.id, outcome: "duplicate" };
        if (job) {
          const what = !decided ? `no approval is waiting for code ${code}, so nothing was done.` : await this.alreadyDecidedText(job, decided);
          // Approve, then pay (decision 2): a late YES never charges; the reply says what really happened.
          await this.notifyHuman(job, `approval-ack:${m.messageId}`, what);
        }
        return { jobId: job?.id ?? null, outcome: decided ? "approval_already_decided" : "no_matching_approval" };
      }
    }
    if (pending.length === 0) return null;
    if (!parsed[2] && !(last?.approvalId && pending.some((a) => a.id === last.approvalId))) return null;
    return this.decideByText(pending, { providerId: `sms-in:${m.messageId}`, from, text: m.text, trustReason: "sms-from-text-approver" });
  }

  /**
   * "PAY <code>" texted by the human after approving (decision 48): the same guarded pay() the tool
   * uses (a stored human approval for that exact quote, amount within the approval and the ceiling,
   * payee = the business that quoted, one charge per approval), then the result by text. Only the
   * job's text number counts (the notify number, else the settings approver); PAY from any other
   * number is ignored and recorded. Before YES it says to approve first; a confirm-only approval has
   * nothing to pay. Idempotent per message id.
   */
  private async ingestPayText(m: { messageId: string; text: string }, from: string, open: JobRow[], code: string | undefined, scope: TextScope): Promise<{ jobId: string | null; outcome: string }> {
    const record = (jobId: string | null, approvalId: string | null, trusted: boolean) => this.repo.insertMessage({
      job_id: jobId, business_id: null, approval_id: approvalId, direction: "in", kind: "approval_reply", channel: "imessage", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 500), attachments: [], attachments_download_url: null,
      sender_trusted: trusted, trust_reason: trusted ? "sms-from-text-approver" : "sms-pay-from-unknown-number", matched_via: "pay_code", parse_status: "none",
      quarantine_reason: trusted ? null : "pay_not_from_approver", round: null, simulated: false,
    });
    // The deals this number approves for: the open ones and recently closed ones (a second PAY after paid).
    const jobs = new Map<string, JobRow>();
    for (const j of [...open, ...(await this.repo.listRecentJobs(20))]) if (!jobs.has(j.id) && inTextScope(scope, j)) jobs.set(j.id, j);
    const mine: JobRow[] = [];
    for (const j of jobs.values()) if (from === (await this.notifyTarget(j))) mine.push(j);
    if (!mine.length) {
      // Not the approver's phone: never charges. Recorded, on the deal whose code it named if any.
      let named: ApprovalRow | null = null;
      if (code) for (const j of open) { const a = await this.repo.getLatestApproval(j.id); if (a?.code === code) { named = a; break; } }
      if (!(await record(named?.job_id ?? null, named?.id ?? null, false))) return { jobId: named?.job_id ?? null, outcome: "duplicate" };
      this.log("pay_text_ignored", { from: maskHandle(from), reason: "not_the_approver", job_id: named?.job_id ?? null });
      if (named) await this.repo.appendEvent(named.job_id, "reply", { business_id: null, kind: "pay_ignored", summary: "A PAY text from a number that isn't the approver's was ignored; nothing was charged." });
      return { jobId: named?.job_id ?? null, outcome: "pay_ignored_not_approver" };
    }
    const latest = (await Promise.all(mine.map((j) => this.repo.getLatestApproval(j.id)))).filter((a): a is ApprovalRow => a !== null);
    // Two of this human's deals under one code: never pick one (the deal code says which).
    const coded = code ? latest.filter((a) => a.code === code) : [];
    const target = coded.length === 1 ? coded[0]! : null;
    const job = (target && mine.find((j) => j.id === target.job_id)) || mine.find((j) => !TERMINAL.has(j.state)) || mine[0]!;
    if (!(await record(job.id, target?.id ?? null, true))) return { jobId: job.id, outcome: "duplicate" };
    const reply = (text: string) => this.notifyHuman(job, `pay-ack:${m.messageId}`, text);
    if (coded.length > 1) {
      await reply(`more than one of your deals has code ${code}, so nothing was charged. Reply again with the deal code, e.g. "PAY ${code} HG-${job.short_code}".`);
      return { jobId: job.id, outcome: "pay_ambiguous_code" };
    }
    if (!target) {
      await reply(code ? `no approved payment has code ${code}, so nothing was charged. Use the code in Haggle's latest approval text, or pay on the deal board in Claude.` : "to charge an approved payment, reply PAY with its code (the one in Haggle's approval text).");
      return { jobId: job.id, outcome: code ? "pay_no_matching_approval" : "pay_code_required" };
    }
    const name = clip(await this.businessName(job.id, target.business_id), 30);
    const amount = usdText(target.payment_cents);
    if (target.action === "confirm" || target.payment_cents <= 0) {
      await reply(`that approval only confirms the order with ${name}; there is nothing to pay.`);
      return { jobId: job.id, outcome: "pay_confirm_only" };
    }
    if (this.d.config.manualPaymentHandoff) {
      const bk = await this.repo.getBookingByApproval(target.id);
      await reply(bk?.status === "awaiting_vendor_confirmation" || !bk
        ? `Haggle doesn't charge on this server, and ${name} hasn't confirmed the booking yet: don't pay until Haggle texts that it's booked.`
        : `Haggle doesn't charge on this server: pay ${amount} to ${name} directly, then reply PAID ${target.code}.`);
      return { jobId: job.id, outcome: "pay_manual_handoff" };
    }
    if (target.status === "pending") {
      await reply(`reply YES ${target.code} first to approve ${amount} to ${name}, then PAY ${target.code} to charge it.`);
      return { jobId: job.id, outcome: "pay_needs_approval" };
    }
    const prior = await this.repo.getPaymentForJob(job.id);
    if (target.status === "used" || (prior?.approval_id === target.id && prior.status === "settled")) {
      await reply(`already paid ${amount} to ${name}. Nothing else to do.`);
      return { jobId: job.id, outcome: "already_paid" };
    }
    if (target.status !== "approved") {
      await reply(`that approval was ${target.status === "locked" ? "locked (too many wrong codes)" : target.status}, so nothing was charged. Choose again on the deal board in Claude.`);
      return { jobId: job.id, outcome: `pay_approval_${target.status}` };
    }
    await this.repo.appendEvent(job.id, "pay_by_text", { approval_id: target.id, quote_id: target.quote_id });
    try {
      const p = await this.pay(job.id, target.quote_id);
      // Settled: the "Paid $X to …" text went when the job became paid (commit), once.
      if (p.status === "settled") return { jobId: job.id, outcome: "paid" };
      if (p.status === "failed" || p.status === "rejected" || p.status === "expired") {
        await this.notifyPayFailed(job, target, p.reason ?? p.status);
        return { jobId: job.id, outcome: "pay_failed" };
      }
      await reply(`charging ${amount} to ${name} now; you'll get a text when it's paid.`);
      return { jobId: job.id, outcome: "paying" };
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      await reply(`couldn't charge ${amount} to ${name}: ${clip(err.message, 140)} Nothing was charged.`);
      return { jobId: job.id, outcome: "pay_refused" };
    }
  }

  /**
   * "PAID <code>" texted by the workspace approver after paying the business directly (manual
   * handoff). The exact approval, quote, amount, caps and job state are revalidated first (they may
   * have changed since the approval); only then is the handoff final and the business told the
   * customer reports having paid. From any other number it is ignored and recorded.
   */
  /**
   * "BOOKED <code>" from the workspace approver: they accept a booking the business confirmed from a
   * sender Haggle can't verify (thread continuity only). Only for that exact approval's code, only while
   * such a claim is pending; then the booking proceeds as a confirmed one (handoff, or confirm-only done).
   */
  private async ingestBookedText(m: { messageId: string; text: string }, from: string, open: JobRow[], code: string | undefined, scope: TextScope): Promise<{ jobId: string | null; outcome: string }> {
    const mine: JobRow[] = [];
    for (const j of open) if (inTextScope(scope, j) && from === (await this.notifyTarget(j))) mine.push(j);
    if (!mine.length) return { jobId: null, outcome: "booked_ignored_not_approver" };
    const latest = (await Promise.all(mine.map((j) => this.repo.getLatestApproval(j.id)))).filter((a): a is ApprovalRow => a !== null && a.status === "approved");
    const coded = code ? latest.filter((a) => a.code === code) : [];
    const job = coded.length === 1 ? mine.find((j) => j.id === coded[0]!.job_id)! : mine.sort((x, y) => y.created_at.localeCompare(x.created_at))[0]!;
    const stored = await this.repo.insertMessage({
      job_id: job.id, business_id: null, approval_id: coded.length === 1 ? coded[0]!.id : null, direction: "in", kind: "approval_reply", channel: "imessage", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 500), attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: "sms-from-text-approver", matched_via: "booked_code", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
    });
    if (!stored) return { jobId: job.id, outcome: "duplicate" };
    const reply = (text: string) => this.notifyHuman(job, `booked-ack:${m.messageId}`, text);
    if (coded.length !== 1) {
      await reply(coded.length > 1 ? `more than one of your deals has code ${code}; nothing was accepted. Reply again with the deal code, e.g. "BOOKED ${code} HG-${job.short_code}".` : "that code doesn't match a booking waiting for you; nothing was accepted.");
      return { jobId: job.id, outcome: coded.length > 1 ? "booked_ambiguous_code" : "booked_no_match" };
    }
    const a = coded[0]!;
    const booking = await this.repo.getBookingByApproval(a.id);
    if (booking?.status === "not_in_writing") return this.attestBooking(job, a, booking, reply);
    const claim = (await this.repo.listEvents(job.id)).filter((e) => e.type === "booking" && e.data.approval_id === a.id && e.data.status === "vendor_claims_confirmed").at(-1);
    if (!booking || booking.status !== "awaiting_vendor_confirmation" || !claim) {
      await reply("there's no unverified booking confirmation waiting for you on that deal; nothing was changed.");
      return { jobId: job.id, outcome: "booked_nothing_pending" };
    }
    const name = clip(await this.businessName(job.id, a.business_id), 30);
    if (!(await this.repo.updateBooking(booking.id, ["awaiting_vendor_confirmation"], { status: "confirmed", confirmed_at: this.now().toISOString() }))) return { jobId: job.id, outcome: "booked_nothing_pending" };
    const identity = claim.data.sender_identity === "text_only" ? "text_only" : "thread_only";
    await this.repo.appendEvent(job.id, "booking", { status: "confirmed", approval_id: a.id, by: "human_ack", sender_identity: identity, at: this.now().toISOString() });
    await this.repo.appendEvent(job.id, "reply", { business_id: a.business_id, summary: `The human accepted ${name}'s booking confirmation (its sender couldn't be verified)` });
    if (a.action === "confirm") {
      await this.fire(job.id, { type: "booking_confirmed" });
      await reply(`accepted: the order with ${name} is confirmed. Nothing was paid through Haggle; arrange payment with them directly.`);
      return { jobId: job.id, outcome: "order_confirmed" };
    }
    const withInstructions = claim.data.payment_instructions === true;
    const ho = await this.startHandoff(job, a, { ask: !withInstructions });
    if (!ho) {
      await reply(`accepted the booking with ${name}, but this approval no longer passes Haggle's payment checks, so Haggle didn't ask how to pay them. Don't pay yet; the operator was flagged.`);
      return { jobId: job.id, outcome: "booking_confirmed" };
    }
    if (withInstructions && booking.reply_text) {
      await this.repo.updateHandoff(ho.id, ["instructions_requested"], { status: "instructions_received", instructions_text: booking.reply_text, instructions_message_id: booking.reply_message_id });
      await this.repo.appendEvent(job.id, "payment", { status: "instructions_received", rail: "manual", business_id: a.business_id, warning: identity === "text_only" ? SMS_PAYMENT_WARNING : CONTINUITY_ONLY_WARNING, sender_identity: identity });
      await reply(`accepted the booking with ${name}. Their payment instructions are on the deal board; confirm them with ${name} by phone before paying ${usdText(a.payment_cents)} directly, then reply PAID ${a.code}.`);
    } else {
      await reply(`accepted the booking with ${name}. Haggle asked how they take payment; don't pay until you have their instructions.`);
    }
    return { jobId: job.id, outcome: "booking_confirmed" };
  }

  /**
   * BOOKED <code> for a booking Haggle can't confirm in writing (a vendor reached by phone or A2A): the
   * approver confirmed it with the business directly. Recorded once (migration 118); only then does the
   * payment handoff start. The approver's own coded text is the only way in (ingestBookedText).
   */
  private async attestBooking(job: JobRow, a: ApprovalRow, booking: BookingRow, reply: (text: string) => Promise<void>): Promise<{ jobId: string | null; outcome: string }> {
    const name = clip(await this.businessName(job.id, a.business_id), 30);
    if (booking.human_attested_at) {
      await reply(`already accepted the booking with ${name}; nothing changed.`);
      return { jobId: job.id, outcome: "booked_already" };
    }
    if (!(await this.repo.updateBooking(booking.id, ["not_in_writing"], { human_attested_at: this.now().toISOString() }))) {
      await reply("there's no booking waiting for you on that deal; nothing was changed.");
      return { jobId: job.id, outcome: "booked_nothing_pending" };
    }
    await this.repo.appendEvent(job.id, "booking", { status: "human_attested", approval_id: a.id, by: "human_ack", sender_identity: "none", at: this.now().toISOString() });
    await this.repo.appendEvent(job.id, "reply", { business_id: a.business_id, summary: `The human confirmed the booking with ${name} directly (Haggle couldn't get it in writing)` });
    const ho = await this.startHandoff(job, a, { ask: false });
    if (!ho) {
      await reply(`accepted the booking with ${name}, but this approval no longer passes Haggle's payment checks, so don't pay yet; the operator was flagged.`);
      return { jobId: job.id, outcome: "booking_confirmed" };
    }
    await reply(`accepted the booking with ${name}. Ask them how they take payment, pay them ${usdText(a.payment_cents)} directly (Haggle never moves money), then reply PAID ${a.code}.`);
    return { jobId: job.id, outcome: "booking_confirmed" };
  }

  private async ingestPaidText(m: { messageId: string; text: string }, from: string, open: JobRow[], code: string | undefined, scope: TextScope): Promise<{ jobId: string | null; outcome: string }> {
    const record = (jobId: string | null, approvalId: string | null, trusted: boolean) => this.repo.insertMessage({
      job_id: jobId, business_id: null, approval_id: approvalId, direction: "in", kind: "approval_reply", channel: "imessage", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 500), attachments: [], attachments_download_url: null,
      sender_trusted: trusted, trust_reason: trusted ? "sms-from-text-approver" : "sms-paid-from-unknown-number", matched_via: "paid_code", parse_status: "none",
      quarantine_reason: trusted ? null : "paid_not_from_approver", round: null, simulated: false,
    });
    const jobs = new Map<string, JobRow>();
    for (const j of [...open, ...(await this.repo.listRecentJobs(20))]) if (!jobs.has(j.id) && inTextScope(scope, j)) jobs.set(j.id, j);
    const mine: JobRow[] = [];
    for (const j of jobs.values()) if (from === (await this.notifyTarget(j))) mine.push(j);
    if (!mine.length) {
      if (!(await record(null, null, false))) return { jobId: null, outcome: "duplicate" };
      this.log("paid_text_ignored", { from: maskHandle(from), reason: "not_the_approver" });
      return { jobId: null, outcome: "paid_ignored_not_approver" };
    }
    const latest = (await Promise.all(mine.map((j) => this.repo.getLatestApproval(j.id)))).filter((a): a is ApprovalRow => a !== null);
    // Two of this human's deals under one code: never pick one (the deal code says which).
    const coded = code ? latest.filter((a) => a.code === code) : [];
    const target = coded.length === 1 ? coded[0]! : null;
    const job = (target && mine.find((j) => j.id === target.job_id)) || mine.find((j) => !TERMINAL.has(j.state)) || mine[0]!;
    if (!(await record(job.id, target?.id ?? null, true))) return { jobId: job.id, outcome: "duplicate" };
    const reply = (text: string) => this.notifyHuman(job, `paid-ack:${m.messageId}`, text);
    if (coded.length > 1) {
      await reply(`more than one of your deals has code ${code}, so nothing was recorded. Reply again with the deal code, e.g. "PAID ${code} HG-${job.short_code}".`);
      return { jobId: job.id, outcome: "paid_ambiguous_code" };
    }
    const h = target ? await this.repo.getHandoffByApproval(target.id) : null;
    const bk = target && !h ? await this.repo.getBookingByApproval(target.id) : null;
    if (target && (bk?.status === "awaiting_vendor_confirmation" || (bk?.status === "not_in_writing" && !bk.human_attested_at))) {
      // Paid before the business confirmed: recorded as said, but nothing is marked paid and the business isn't told.
      await this.repo.appendEvent(job.id, "operator_attention", { reason: "paid_before_booking_confirmed", approval_id: target.id });
      await reply(`${clip(await this.businessName(job.id, target.business_id), 30)} hasn't confirmed the booking yet, so nothing was recorded as paid. If you already paid, tell them directly; Haggle will text when they confirm.`);
      return { jobId: job.id, outcome: "paid_before_booking" };
    }
    if (!target || !h) {
      await reply(code ? `no payment handoff has code ${code}; nothing was recorded.` : "to record that you paid, reply PAID with the code from Haggle's approval text.");
      return { jobId: job.id, outcome: "paid_no_matching" };
    }
    if (h.status === "human_confirmed") {
      await reply("already recorded that you reported paying. Nothing else to do.");
      return { jobId: job.id, outcome: "handoff_already_confirmed" };
    }
    const fresh = (await this.repo.getJob(job.id)) ?? job;
    const held = (await this.repo.getBookingByApproval(target.id))?.status;
    const verdict = await this.paymentVerdict(fresh, target, { bookingHeld: held === "confirmed" || held === "not_in_writing" });
    if (!verdict.ok) {
      await this.repo.appendEvent(job.id, "payment_refused", { code: verdict.code, approval_id: target.id, rail: "manual" });
      await reply(`couldn't record that payment: the approval no longer matches (${verdict.code.toLowerCase().replace(/_/g, " ")}). Nothing was sent to the business; see the deal board.`);
      return { jobId: job.id, outcome: "handoff_refused" };
    }
    const done = await this.repo.updateHandoff(h.id, ["instructions_requested", "instructions_received"], { status: "human_confirmed", confirmed_by: from, confirmed_at: this.now().toISOString() });
    if (!done) return { jobId: job.id, outcome: "handoff_already_confirmed" };
    await this.repo.transitionApproval(target.id, "approved", { status: "used" });
    // The customer's report, not a verified settlement (that needs the business's own "received").
    await this.repo.appendEvent(job.id, "payment", { status: "human_reported_paid", rail: "manual", reported_by: "human", amount_usd: centsToUsd(h.amount_cents) });
    await this.fire(job.id, { type: "payment_settled" });
    return { jobId: job.id, outcome: "handoff_confirmed" };
  }

  /**
   * The guard every charge or handoff passes, whenever it starts or resumes: a stored human approval
   * for this exact quote revision, business and amount, unexpired; amount within the job, approval,
   * server and current workspace caps; payee = the business that quoted; job still paying.
   */
  private async paymentVerdict(job: JobRow, approval: ApprovalRow, opts: { bookingHeld?: boolean } = {}) {
    const quote = await this.repo.getQuote(approval.quote_id);
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === approval.business_id);
    // Rechecked at every start and resume (sprint 4 D): a quote read by the keyword fallback, from a
    // quarantined or unverified message, or a simulated reply on a live job never carries money.
    const src = quote ? await this.repo.getMessage(quote.message_id) : null;
    const carriesMoney = !!quote && !!src && !heuristicReading(quote.record) && src.kind !== "quarantine" && src.sender_trusted === true && src.job_id === job.id && !(job.mode === "live" && src.simulated);
    return checkStripePaymentAllowed({
      stripeConfigured: true,
      job: { id: job.id, state: job.state },
      approval: { id: approval.id, job_id: approval.job_id, quote_id: approval.quote_id, business_id: approval.business_id, quote_total_cents: approval.quote_total_cents, payment_cents: approval.payment_cents, status: approval.status,
        // Manual handoff: an approval whose booking the business confirmed doesn't lapse while the human
        // arranges payment (hours or days); everything else is still revalidated.
        expires_at: opts.bookingHeld ? new Date(this.now().getTime() + 60_000).toISOString() : approval.expires_at },
      quote: quote ? { id: quote.id, business_id: quote.business_id, total_cents: quote.total_cents, deposit_cents: quote.deposit_cents, status: quote.status } : null,
      payee: b && quote ? { business_id: b.business_id, on_job: true, quoted_from_trusted_sender: quote.sender_trusted && quote.business_id === b.business_id && carriesMoney } : null,
      existingPayment: null,
      spendCapCents: Math.min(job.payment_cap_cents, this.d.config.globalPaymentCapCents, approval.cap_cents, (await this.getSettings(job.workspace_id)).spending_cap_cents),
      now: this.now(),
    });
  }

  // ───────────────── purchase after approval: re-confirmation, booking, handoff, receipt, cancellation ─────────────────
  //
  // Manual rail (HAGGLE_PAYMENTS=manual): approval → the business confirms availability and the
  // approved terms in writing ("booked") → it is asked how it takes payment → the human pays it
  // directly and texts PAID <code> ("the customer reports paying") → only the business's own "received"
  // from a verified sender makes it settled_verified. Each step's state is in bookings /
  // payment_handoffs / handoff_receipts (migrations 106, 110); the words come from payments/purchase.ts.

  private get reconfirmTimeoutMs() { return this.d.config.reconfirmTimeoutMs ?? 24 * 3_600_000; }
  private get bookingTimeoutMs() { return this.d.config.bookingTimeoutMs ?? 24 * 3_600_000; }
  private get handoffTimeoutMs() { return this.d.config.handoffTimeoutMs ?? 48 * 3_600_000; }

  /** Until when a quote can be approved as is (the business's valid-until, the validity window, any re-confirmation). */
  private freshnessOf(q: QuoteRow, events: JobEventRow[]): NonNullable<BoardQuote["freshness"]> {
    const reconfirmedAt = events.filter((e) => e.type === "reconfirmed" && e.data.quote_id === q.id).at(-1)?.data.at;
    const f = quoteFreshness({ created_at: q.created_at, valid_until: q.record.valid_until }, this.now(), this.d.config.quoteValidityMs ?? DEFAULT_QUOTE_VALIDITY_MS, typeof reconfirmedAt === "string" ? reconfirmedAt : null);
    return { stale: f.stale, ...(f.reason ? { reason: f.reason } : {}), good_until: f.good_until, valid_until: f.valid_until, ...(pendingReconfirm(events, q.id) ? { reconfirmation: "requested" as const } : {}) };
  }

  /**
   * A stale quote the agent asked to approve: one message asking the business whether it still stands
   * (its own channel; email or text). The approval opens only once it confirms the same terms
   * (purchaseTick); a changed total is a new quote revision that needs its own approval.
   */
  private async requestReconfirmation(job: JobRow, b: JobBusinessRow, q: QuoteRow, channel: ApprovalRow["channel"], action: ApprovalAction, offer: ApprovalOffer | undefined, reason: string): Promise<void> {
    const events = await this.repo.listEvents(job.id);
    if (pendingReconfirm(events, q.id)) return;
    const deposit = q.deposit_cents && q.deposit_cents > 0 ? `, with a ${usdText(q.deposit_cents)} deposit` : "";
    const what = [job.request.what, quantityText(job.request.quantity, job.request.unit), job.request.date ? `on ${eventWhen(job.request.date, job.request.time, job.request.date_until)}` : null].filter(Boolean).join(", ");
    const key = `reconfirm:${q.id}`;
    if (b.channel === "email" && b.email) {
      await this.sendRecorded(job, b, "message", key, {
        to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true,
        bodyText: [`Hi ${b.name},`, "", `Before the customer approves: could you confirm that your quote of ${usdText(q.total_cents!)} total${deposit} for ${what} still stands?`,
          "Please reply \"confirmed\" if it does, or send the updated total if anything changed. Nothing has been booked or paid yet.", "", this.signOff(job)].join("\n"),
      });
    } else if (b.channel === "imessage" && this.canReach(b)) {
      if (!(await this.sendIMessageToBusiness(job, b, "message", key, `Hi ${b.name}, does your ${usdText(q.total_cents!)} quote for ${clip(job.request.what, 40)} still stand? Reply "confirmed" or send the new total. Ref HG-${job.short_code}`, null))) {
        throw new EngineError("reconfirm_not_sent", `Couldn't text ${b.name} to re-confirm its quote.`, "Try again later, or approve another quote.", "get_quotes");
      }
    } else {
      throw new EngineError("quote_stale", `${b.name}'s quote is ${reason}, and Haggle can't re-confirm it automatically on its channel (${b.channel}).`, `Ask ${b.name} for a fresh quote (send_message), or approve another quote.`, "get_quotes");
    }
    await this.repo.appendEvent(job.id, "reconfirm_requested", {
      quote_id: q.id, business_id: b.business_id, channel, action, offer_text: offer?.text === true, offer_email: offer?.email === true,
      total_cents: q.total_cents, deposit_cents: q.deposit_cents, reason, at: this.now().toISOString(),
    });
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, kind: "reconfirm_requested", summary: `${b.name}'s ${usdText(q.total_cents!)} quote is ${reason}: asked ${b.name} to confirm it still stands before the human approves it` });
    await this.repo.touchJob(job.id);
  }

  /**
   * Withdraw the current approval when its booking is stuck: the vendor didn't confirm after Haggle's
   * reminder (or the human didn't accept a booking Haggle can't confirm in writing), or the payment
   * checks refused the handoff. Only before any payment was reported. The vendor that was asked to
   * book is told not to hold it (unless the same quote is being approved again, which asks it anew).
   * Returns true when the job went back to choosing.
   */
  private async withdrawStuckBooking(job: JobRow, nextQuoteId: string): Promise<boolean> {
    const a = await this.repo.getLatestApproval(job.id);
    if (!a || a.status !== "approved") return false;
    const [booking, h, events] = await Promise.all([this.repo.getBookingByApproval(a.id), this.repo.getHandoffByApproval(a.id), this.repo.listEvents(job.id)]);
    if (!booking || (h && !["instructions_requested", "instructions_received"].includes(h.status))) return false;
    // A booking the business confirmed is dropped only by the approver's CANCEL <code> (decision H3), never by
    // re-approving another quote. Re-approving the same quote (a refused handoff, once fixed) tells the business nothing.
    if (isVendorConfirmed(booking) && nextQuoteId !== a.quote_id) return false;
    const refused = !h && events.some((e) => e.type === "payment_refused" && e.data.approval_id === a.id && e.data.rail === "manual");
    const stalled = !!booking.stalled_at && (booking.status === "awaiting_vendor_confirmation" || (booking.status === "not_in_writing" && !booking.human_attested_at));
    if (!refused && !stalled) return false;
    const why = refused ? "the approval no longer passed Haggle's payment checks" : booking.status === "not_in_writing" ? "the booking was never confirmed with the business" : "the business didn't confirm the booking";
    if (!(await this.repo.transitionApproval(a.id, "approved", { status: "expired", decided_at: this.now().toISOString() }))) return false;
    await this.repo.updateBooking(booking.id, [booking.status], { status: "cancelled", cancel_reason: `withdrawn: ${why}` });
    if (h) await this.repo.updateHandoff(h.id, ["instructions_requested", "instructions_received"], { status: "cancelled" });
    await this.repo.appendEvent(job.id, "approval_void", { approval_id: a.id, reason: why, by: "agent_reapproval" });
    await this.repo.appendEvent(job.id, "booking", { status: "cancelled", approval_id: a.id, why, at: this.now().toISOString() });
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === a.business_id);
    const asked = booking.status === "awaiting_vendor_confirmation" || booking.status === "confirmed";
    if (b && asked && nextQuoteId !== a.quote_id) {
      const note = `The customer has gone with another option, so please don't hold the booking for ${job.request.what}. Nothing was paid. Thank you for your time.`;
      try {
        if (b.channel === "email" && b.email) await this.sendRecorded(job, b, "message", `withdraw:${a.id}`, { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true, bodyText: `Hi ${b.name},\n\n${note}\n\n${this.signOff(job)}` });
        else if (b.channel === "imessage" && this.canReach(b)) await this.sendIMessageToBusiness(job, b, "message", `withdraw:${a.id}`, `Hi ${b.name}, the customer went with another option; please don't hold the booking. Nothing was paid. Ref HG-${job.short_code}`, null);
      } catch (err) {
        this.log("withdraw_note_failed", { job_id: job.id, error: (err as Error).message });
      }
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Told ${b.name} not to hold the booking (${why}); nothing was paid` });
    }
    const r = await this.fire(job.id, { type: "approval_void" });
    return r.ok;
  }

  /** A reply to a re-confirmation request that explicitly confirms the same terms (email: handled here, never parsed as a revision). */
  private async ingestReconfirmReply(job: JobRow, b: JobBusinessRow, msg: InboundMessage, base: PurchaseBase, via: MessageRow["matched_via"], trustReason: string): Promise<{ jobId: string; outcome: string } | null> {
    const events = await this.repo.listEvents(job.id);
    const pending = [...events].reverse().find((e) => e.type === "reconfirm_requested" && e.data.business_id === b.business_id && pendingReconfirm(events, String(e.data.quote_id)));
    if (!pending) return null;
    const q = await this.repo.getQuote(String(pending.data.quote_id));
    if (!q || q.status !== "current") return null;
    const r = readBookingReply(msg.bodyText ?? "", { agreedCents: [q.total_cents, q.deposit_cents].filter((c): c is number => c !== null && c > 0), ...(job.request.quantity !== undefined ? { quantity: job.request.quantity } : {}), ...(job.request.date && !job.request.date_until ? { eventDate: job.request.date } : {}) });
    // Anything but a clean "yes, same terms" is read as a reply (a new revision, a decline, a question).
    if (r.intent !== "confirm") return null;
    const stored = await this.repo.insertMessage({ ...base, job_id: job.id, business_id: b.business_id, kind: "reply", sender_trusted: true, trust_reason: trustReason as never, matched_via: via, parse_status: "none", quarantine_reason: null });
    if (!stored) return { jobId: job.id, outcome: "duplicate" };
    await this.repo.updateBusiness(job.id, b.business_id, { last_reply_at: this.now().toISOString(), ...(msg.messageId ? { last_inbound_message_id: msg.messageId, references: [...b.references, msg.messageId].slice(-20) } : {}) });
    await this.repo.appendEvent(job.id, "reconfirmed", { quote_id: q.id, business_id: b.business_id, message_id: stored.id, at: this.now().toISOString() });
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${b.name} confirmed its ${usdText(q.total_cents!)} quote still stands` });
    await this.repo.touchJob(job.id);
    return { jobId: job.id, outcome: "quote_reconfirmed" };
  }

  /** Resolve re-confirmations: confirmed → open the approval the agent asked for; changed / declined / silent → say so. */
  private async resolveReconfirmations(job: JobRow, events: JobEventRow[]) {
    const requests = events.filter((e) => e.type === "reconfirm_requested" && pendingReconfirm(events, String(e.data.quote_id)));
    if (!requests.length) return;
    const all = await this.repo.listQuotes(job.id);
    for (const r of requests) {
      const quoteId = String(r.data.quote_id);
      const bid = String(r.data.business_id);
      const name = await this.businessName(job.id, bid);
      const resolve = (outcome: string, extra: Record<string, unknown> = {}) => this.repo.appendEvent(job.id, "reconfirm_resolved", { quote_id: quoteId, business_id: bid, outcome, ...extra });
      const open = async (qid: string) => {
        try {
          const a = await this.openApproval(job.id, qid, r.data.channel as ApprovalRow["channel"], r.data.action as ApprovalAction, { text: r.data.offer_text === true, email: r.data.offer_email === true });
          await this.repo.appendEvent(job.id, "reply", { business_id: bid, kind: "reconfirmed_approval", approval_id: a.id, summary: `${name} confirmed its quote still stands: the approval is now with the human` });
        } catch (err) {
          const m = err instanceof EngineError ? `${err.code}: ${err.message}` : (err as Error).message;
          await this.repo.appendEvent(job.id, "reply", { business_id: bid, kind: "reconfirmed_not_opened", summary: `${name} re-confirmed, but the approval couldn't be opened (${clip(m, 160)}); call approve again` });
        }
      };
      if (events.some((e) => e.type === "reconfirmed" && e.data.quote_id === quoteId && e.seq > r.seq)) {
        await resolve("confirmed");
        await open(quoteId);
        continue;
      }
      // A newer quote from the business since the request: the same firm terms in its own words confirm; anything else is news.
      // (event order, not timestamps: rows and events may be stamped by different clocks)
      const after = new Set(events.filter((e) => e.type === "quote" && e.seq > r.seq && e.data.business_id === bid).map((e) => String(e.data.quote_id)));
      const newer = all.filter((q) => q.id !== quoteId && after.has(q.id)).sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
      if (newer && newer.status === "current") {
        const msg = await this.repo.getMessage(newer.message_id);
        const same = newer.total_cents === r.data.total_cents && (newer.deposit_cents ?? null) === (r.data.deposit_cents ?? null);
        const read = readBookingReply(msg?.body_text ?? "", { agreedCents: [newer.total_cents, newer.deposit_cents].filter((c): c is number => c !== null && c > 0) });
        const said = same && newer.total_cents !== null && (read.intent === "confirm" || findDollarAmounts(vendorOwnWords(msg?.body_text ?? "")).includes(newer.total_cents));
        if (!newer.record.available) {
          await resolve("declined", { new_quote_id: newer.id });
          await this.notifyHuman(job, `reconfirm:${quoteId}`, `${clip(name, 30)} can no longer do it at the quoted terms; nothing was approved or paid. Choose another option on the deal board.`);
        } else if (same && said) {
          await resolve("confirmed", { new_quote_id: newer.id });
          await open(newer.id);
        } else if (!same && newer.total_cents !== null) {
          await resolve("changed", { new_quote_id: newer.id, old_total_cents: r.data.total_cents, new_total_cents: newer.total_cents });
          await this.repo.appendEvent(job.id, "reply", { business_id: bid, kind: "reconfirm_changed", summary: `${name} changed its quote from ${usdText(Number(r.data.total_cents))} to ${usdText(newer.total_cents)}: the new quote needs its own approval` });
          await this.notifyHuman(job, `reconfirm:${quoteId}`, `${clip(name, 30)} changed its quote from ${usdText(Number(r.data.total_cents))} to ${usdText(newer.total_cents)}. Nothing was approved; the new quote needs your approval if you want it.`);
        } else if (!events.some((e) => e.type === "reply" && e.data.kind === "reconfirm_unclear" && e.data.quote_id === quoteId)) {
          await this.repo.appendEvent(job.id, "reply", { business_id: bid, kind: "reconfirm_unclear", quote_id: quoteId, summary: `${name} replied but didn't clearly confirm its quote still stands; still waiting` });
        }
        continue;
      }
      if (this.now().getTime() - Date.parse(String(r.data.at)) > this.reconfirmTimeoutMs) {
        await resolve("no_reply");
        await this.notifyHuman(job, `reconfirm:${quoteId}`, `${clip(name, 30)} hasn't confirmed its quote still stands, so it wasn't sent for approval. Ask them for a fresh quote or choose another option.`);
      }
    }
  }

  /** The current purchase (booking + handoff + receipt) for the job's latest approval, in honest words. */
  private async purchaseFor(job: JobRow, events?: JobEventRow[]): Promise<PurchaseView | null> {
    if (!this.d.config.manualPaymentHandoff) return null;
    const a = await this.repo.getLatestApproval(job.id);
    if (!a) return null;
    const [booking, handoff] = await Promise.all([this.repo.getBookingByApproval(a.id), this.repo.getHandoffByApproval(a.id)]);
    if (!booking) return null;
    const receipt = handoff ? await this.repo.getHandoffReceipt(handoff.id) : null;
    const ev = events ?? (await this.repo.listEvents(job.id));
    return purchaseView({
      business: await this.businessName(job.id, a.business_id), booking, handoff, receipt, approvalCode: undefined,
      cancelAfterPayment: ev.some((e) => e.type === "cancel_after_payment" && e.data.approval_id === a.id), jobCancelled: job.state === "cancelled",
      confirmOnly: a.action === "confirm", order: this.orderText(job), mustHaves: mustHaveLine(job.request.requirements),
      ...((r) => (r ? { handoffRefused: String(r.data.code) } : {}))(ev.filter((e) => e.type === "payment_refused" && e.data.approval_id === a.id && e.data.rail === "manual").at(-1)),
    });
  }

  /** The order as every later message names it: "offsite lunch, 60 people, Saturday, November 14, 2026 at 11:30 AM, 500 Howard St, San Francisco, CA". */
  private orderText(job: JobRow): string {
    const r = job.request;
    return [r.what, quantityText(r.quantity, r.unit), r.date ? eventWhen(r.date, r.time, r.date_until) : null, eventPlace(r.area, r.venue)].filter(Boolean).join(", ");
  }

  /** The board's payment line under the manual handoff (null when nothing was accepted yet). */
  private async handoffFor(job: JobRow, events?: JobEventRow[]): Promise<EnginePaymentStatus | null> {
    const v = await this.purchaseFor(job, events);
    return v ? purchasePaymentLine(v, job.mode === "mock") : null;
  }

  /**
   * After the human approves (manual rail): the booking. A business Haggle reaches by email is asked to
   * confirm availability and the approved terms in writing (and how it takes payment) before anything
   * is booked or paid. One Haggle can't get a written answer from (a call, A2A, or a text, whose replies
   * aren't routed to bookings yet) is "not_in_writing": the human confirms it directly and the handoff
   * starts at once, as before.
   */
  private async startBooking(job: JobRow, a: ApprovalRow): Promise<BookingRow | null> {
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === a.business_id);
    if (!b) return null;
    if (a.action !== "confirm" && !(await this.handoffAllowed(job, a, "booking"))) return null;
    // Email, or a text on the business's pinned number (its replies reach ingestPurchaseReply by the same identity rules).
    const byText = b.channel === "imessage" && this.canReach(b);
    const written = (b.channel === "email" && !!b.email) || byText;
    const confirmOnly = a.action === "confirm";
    const booking = (await this.repo.insertBooking({
      id: newId("bk"), job_id: job.id, approval_id: a.id, quote_id: a.quote_id, business_id: a.business_id, total_cents: a.quote_total_cents, payment_cents: a.payment_cents,
      status: written ? "awaiting_vendor_confirmation" : "not_in_writing", request_message_id: null, reply_text: null, reply_message_id: null, reply_has_link: false,
      confirmed_at: null, stalled_at: null, cancel_reason: null,
    })) ?? (await this.repo.getBookingByApproval(a.id));
    if (!booking) return null;
    if (!written) {
      // Nobody has confirmed it yet: the human confirms it with the business directly and accepts it by
      // text (BOOKED <code>, ingestBookedText); only then does the payment handoff start (migration 118).
      if (!(await this.repo.listEvents(job.id)).some((e) => e.type === "booking" && e.data.approval_id === a.id)) {
        await this.repo.appendEvent(job.id, "booking", { status: "not_in_writing", approval_id: a.id, awaiting: "human_attestation", at: this.now().toISOString() });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Haggle can't get ${b.name}'s booking confirmation in writing (${b.channel}): the human confirms it with them directly, then replies BOOKED <code>; nothing is booked or paid yet` });
      }
      return booking;
    }
    const deposit = a.payment_cents > 0 && a.payment_cents < a.quote_total_cents;
    const what = this.orderText(job);
    const musts = mustHaveLine(job.request.requirements);
    const q = await this.repo.getQuote(a.quote_id);
    const open = q ? this.unconfirmedMusts(job, q) : [];
    const text = [
      `Hi ${b.name},`, "",
      `The customer has accepted your quote of ${usdText(a.quote_total_cents)} total for ${what}.`, "",
      "Before anything is booked or paid, please reply to confirm:",
      "1. You're available and will provide this as quoted.",
      `2. The total of ${usdText(a.quote_total_cents)} stands${deposit ? `, with a ${usdText(a.payment_cents)} deposit due now` : ""}.`,
      ...(musts ? [`3. You'll meet every must-have: ${musts}.`] : []),
      ...(open.length ? [`   Your quote didn't confirm ${open.length === 1 ? "this one" : "these"}, so please confirm ${open.length === 1 ? "it" : "each"} specifically: ${open.join("; ")}.`] : []), "",
      confirmOnly ? "The customer arranges payment with you directly; Haggle never takes or sends money. Nothing has been paid."
        : "Once you confirm, please also tell us how you take payment (an invoice or payment instructions). The customer pays you directly; Haggle never takes or sends money. Nothing has been paid yet.", "",
      this.signOff(job),
    ].join("\n");
    try {
      const m = byText
        // A text: the order first (the same facts), then the ask; fitText keeps it within the channel's limit.
        // (the ask first: an iMessage is cut at 159 characters, and the order's facts may be long).
        ? await this.sendIMessageToBusiness(job, b, "message", `booking:${a.id}`, `HG-${job.short_code}: the customer accepted your ${usdText(a.quote_total_cents)} quote. Reply CONFIRMED if you can do it as quoted${deposit ? ` (${usdText(a.payment_cents)} deposit)` : ""}${confirmOnly ? "" : ", and how you take payment"}. Nothing is paid yet. Order: ${what}${musts ? `; ${musts}` : ""}`, null)
        : await this.sendRecorded(job, b, "accept", sendKeys.accept(a.id), { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, bodyText: text, inThread: true, approvalId: a.id });
      if (m) await this.repo.updateBooking(booking.id, ["awaiting_vendor_confirmation"], { request_message_id: m.id });
    } catch (err) {
      this.log("booking_request_failed", { job_id: job.id, error: (err as Error).message });
    }
    if (!(await this.repo.listEvents(job.id)).some((e) => e.type === "booking" && e.data.approval_id === a.id)) {
      await this.repo.appendEvent(job.id, "booking", { status: "awaiting_vendor_confirmation", approval_id: a.id, at: this.now().toISOString() });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Asked ${b.name} to confirm the booking (availability and the ${usdText(a.quote_total_cents)} terms); nothing is booked or paid yet` });
    }
    return booking;
  }

  /** Hard must-haves the business's quote never confirmed (stated misses are caveats the human accepted; request facts count as quoted). */
  private unconfirmedMusts(job: JobRow, q: QuoteRow): string[] {
    const results = new Map(q.requirement_results.map((r) => [r.requirement_id, r]));
    return this.requirements(job).filter((req) => req.hard && (results.get(req.id)?.met ?? null) === null).map((req) => req.text);
  }

  /** One follow-up (per approval) asking the vendor about the must-haves its "yes" skipped; the booking stays unconfirmed. */
  private async askMustHaves(job: JobRow, b: JobBusinessRow, a: ApprovalRow, musts: string[]) {
    const key = `booking-musts:${a.id}`;
    const list = musts.join("; ");
    try {
      if (b.channel === "email" && b.email) {
        await this.sendRecorded(job, b, "followup", key, { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true,
          bodyText: [`Hi ${b.name},`, "", `Thank you. Before the booking is confirmed, please confirm you'll meet ${musts.length === 1 ? "this must-have" : "these must-haves"}: ${list}.`, "Nothing has been booked or paid yet.", "", this.signOff(job)].join("\n") });
      } else if (b.channel === "imessage" && this.canReach(b)) {
        await this.sendIMessageToBusiness(job, b, "followup", key, `Thanks! Before it's booked, can you confirm: ${clip(list, 90)}? Nothing is paid yet. Ref HG-${job.short_code}`, null);
      }
    } catch (err) {
      this.log("booking_musts_ask_failed", { job_id: job.id, error: (err as Error).message });
    }
  }

  /**
   * The payment guard, re-run before the vendor is asked to book or to say how it's paid (manual rail):
   * a cap lowered after the approval, a changed quote or an untrustworthy source stops it (security
   * review, workstream D). Recorded once per stage for the operator; nothing is sent to the vendor.
   */
  private async handoffAllowed(job: JobRow, a: ApprovalRow, stage: "booking" | "handoff"): Promise<boolean> {
    const v = await this.paymentVerdict(job, a, { bookingHeld: true });
    if (v.ok) return true;
    const events = await this.repo.listEvents(job.id);
    if (!events.some((e) => e.type === "payment_refused" && e.data.approval_id === a.id && e.data.stage === stage)) {
      await this.repo.appendEvent(job.id, "payment_refused", { code: v.code, approval_id: a.id, rail: "manual", stage });
      await this.repo.appendEvent(job.id, "operator_attention", { reason: `${stage}_refused`, code: v.code, approval_id: a.id });
      this.log("operator_attention", { job_id: job.id, reason: `${stage}_refused`, code: v.code });
    }
    return false;
  }

  /**
   * Manual handoff, once the booking is confirmed: one handoff row per approval and, unless the
   * business already said how it takes payment, one message asking it how (email or text; a phone or
   * A2A business is arranged by the human). Nothing here says or implies that payment was sent.
   */
  private async startHandoff(job: JobRow, a: ApprovalRow, opts: { ask?: boolean } = {}): Promise<PaymentHandoffRow | null> {
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === a.business_id);
    if (!b) return null;
    if (!(await this.handoffAllowed(job, a, "handoff"))) return null;
    const h = (await this.repo.insertHandoff({ id: newId("ho"), job_id: job.id, approval_id: a.id, business_id: a.business_id, amount_cents: a.payment_cents, status: "instructions_requested", instructions_text: null, instructions_message_id: null, confirmed_by: null, confirmed_at: null }))
      ?? (await this.repo.getHandoffByApproval(a.id));
    const deposit = a.payment_cents < a.quote_total_cents;
    const what = `${usdText(a.payment_cents)}${deposit ? " deposit" : ""}`;
    if (opts.ask !== false) {
      const text = [
        `Hi ${b.name},`, "",
        `Thank you. The customer will pay the ${what} for your ${usdText(a.quote_total_cents)} quote (${this.orderText(job)}) to you directly.`,
        "Please reply with how you take payment (an invoice, or payment instructions). The customer pays you themselves; Haggle never takes or sends money.", "",
        this.signOff(job),
      ].join("\n");
      try {
        if (b.channel === "email" && b.email) await this.sendRecorded(job, b, "message", `handoff:${a.id}`, { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, bodyText: text, inThread: true, approvalId: a.id });
        else if (b.channel === "imessage" && this.canReach(b)) await this.sendIMessageToBusiness(job, b, "message", `handoff:${a.id}`, `Hi ${b.name}, the customer approved your ${usdText(a.quote_total_cents)} quote and will pay the ${what} to you directly. How do you take payment? Ref HG-${job.short_code}`, null);
      } catch (err) {
        this.log("handoff_ask_failed", { job_id: job.id, error: (err as Error).message });
      }
    }
    if (!(await this.repo.listEvents(job.id)).some((e) => e.type === "payment" && e.data.status === "handoff_requested" && e.data.approval_id === a.id)) {
      await this.repo.appendEvent(job.id, "payment", { status: "handoff_requested", rail: "manual", approval_id: a.id, at: this.now().toISOString() });
    }
    return h;
  }

  /**
   * A trusted reply from a business while it owes Haggle an answer about a purchase: a re-confirmation
   * of a stale quote, the booking confirmation, its payment instructions, or "received" after the
   * customer reported paying. Returns null for anything else (the normal reply path reads it).
   */
  private async ingestPurchaseReply(b: JobBusinessRow, msg: InboundMessage, base: PurchaseBase, via: MessageRow["matched_via"], trustReason: string): Promise<{ jobId: string; outcome: string } | null> {
    const job = await this.repo.getJob(b.job_id);
    if (!job) return null;
    if (job.state === "collecting" || job.state === "negotiating") return this.ingestReconfirmReply(job, b, msg, base, via, trustReason);
    if (!this.d.config.manualPaymentHandoff || (job.state !== "paying" && job.state !== "paid")) return null;
    const a = await this.repo.getLatestApproval(job.id);
    if (!a || a.business_id !== b.business_id) return null;
    // A withdrawn or lapsed approval books nothing, whatever the job's state says (a void that lost a race).
    if (job.state === "paying" && a.status !== "approved") return null;
    const booking = await this.repo.getBookingByApproval(a.id);
    if (!booking) return null;
    const h = await this.repo.getHandoffByApproval(a.id);
    if (job.state === "paid") return h?.status === "human_confirmed" ? this.ingestReceipt(job, b, a, h, msg, base, via, trustReason) : null;
    const q = await this.repo.getQuote(a.quote_id);
    const musts = booking.status === "awaiting_vendor_confirmation" && q ? this.unconfirmedMusts(job, q) : [];
    const r = readBookingReply(msg.bodyText ?? "", {
      agreedCents: [a.quote_total_cents, a.payment_cents, q?.deposit_cents ?? null].filter((c): c is number => c !== null && c > 0), ...(job.request.quantity !== undefined ? { quantity: job.request.quantity } : {}),
      ...(job.request.date && !job.request.date_until ? { eventDate: job.request.date } : {}), ...(musts.length ? { mustConfirm: musts } : {}),
    });
    const store = () => this.repo.insertMessage({ ...base, job_id: job.id, business_id: b.business_id, kind: "reply", sender_trusted: true, trust_reason: trustReason as never, matched_via: via, parse_status: "none", quarantine_reason: null });
    const name = clip(b.name, 30);
    // Declined, or new terms, before or after confirming: the approval is withdrawn (nothing was paid).
    if (r.intent === "decline" || r.intent === "change") {
      const to = booking.status === "awaiting_vendor_confirmation" ? (r.intent === "decline" ? "declined" : "changed") : "cancelled";
      await this.repo.updateBooking(booking.id, [booking.status], { status: to, reply_text: r.ownText, reply_has_link: r.hasLink, ...(to === "cancelled" ? { cancel_reason: `business ${r.intent === "decline" ? "withdrew" : "changed terms"} after confirming` } : {}) });
      if (h && ["instructions_requested", "instructions_received"].includes(h.status)) await this.repo.updateHandoff(h.id, ["instructions_requested", "instructions_received"], { status: "cancelled" });
      if (await this.repo.transitionApproval(a.id, "approved", { status: "expired", decided_at: this.now().toISOString() })) {
        await this.repo.appendEvent(job.id, "approval_void", { approval_id: a.id, reason: r.intent === "decline" ? "the business can't take the booking" : "the business replied with different terms" });
      }
      await this.repo.appendEvent(job.id, "booking", { status: to, approval_id: a.id, why: r.why, at: this.now().toISOString() });
      await this.notifyHuman(job, `booking-${r.intent}:${a.id}`, r.intent === "decline"
        ? `${name} can't take the booking after all. Your approval was withdrawn and nothing was paid; don't pay them. Choose another option on the deal board.`
        : `${name} replied with different terms, so your approval was withdrawn; nothing was paid. Don't pay them; Haggle shows the new terms on the deal board for a fresh approval.`);
      await this.fire(job.id, { type: "approval_void" });
      if (r.intent === "change") return null; // read as a revised quote by the normal reply path
      const stored = await store();
      return { jobId: job.id, outcome: stored ? "booking_declined" : "duplicate" };
    }
    if (booking.status === "awaiting_vendor_confirmation") {
      const stored = await store();
      if (!stored) return { jobId: job.id, outcome: "duplicate" };
      if (r.intent === "unclear") {
        await this.repo.updateBooking(booking.id, ["awaiting_vendor_confirmation"], { reply_text: r.ownText, reply_message_id: stored.id, reply_has_link: r.hasLink });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, kind: "booking_unclear", summary: `${b.name} replied but hasn't clearly confirmed the booking (${r.why}); not booked yet` });
        if (r.unconfirmedMusts?.length) await this.askMustHaves(job, b, a, r.unconfirmedMusts);
        await this.notifyHuman(job, `booking-unclear:${stored.id}`, `${name} replied about the booking but hasn't clearly confirmed it yet (see the deal board). Don't pay yet.`);
        await this.repo.touchJob(job.id);
        return { jobId: job.id, outcome: "booking_unclear" };
      }
      if (!bindsTermsAlone(trustReason)) {
        // Continuity (or a texted number) isn't identity: the booking stays unconfirmed until the human accepts it (BOOKED <code>).
        const identity = weakIdentity(trustReason);
        await this.repo.updateBooking(booking.id, ["awaiting_vendor_confirmation"], { reply_text: r.ownText, reply_message_id: stored.id, reply_has_link: r.hasLink });
        await this.repo.appendEvent(job.id, "booking", { status: "vendor_claims_confirmed", approval_id: a.id, message_id: stored.id, sender_identity: identity, warning: identity === "text_only" ? TEXT_ONLY_BOOKING_WARNING : THREAD_ONLY_BOOKING_WARNING, payment_instructions: r.paymentInstructions, at: this.now().toISOString() });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, kind: "booking_unverified", summary: `${b.name} says the booking is confirmed, but Haggle can't verify the sender; waiting for the human to accept it (BOOKED <code>)` });
        await this.notifyHuman(job, `booking-ack:${a.id}`, identity === "text_only"
          ? `${name} says it's confirmed by text, but a text can't prove who sent it. Check with them directly; if it's right, reply BOOKED ${a.code} to accept the booking. Don't pay yet.`
          : `${name} says it's confirmed, but Haggle can't verify that email came from them. Check with them directly; if it's right, reply BOOKED ${a.code} to accept the booking. Don't pay yet.`);
        await this.repo.touchJob(job.id);
        return { jobId: job.id, outcome: "booking_unverified" };
      }
      await this.repo.updateBooking(booking.id, ["awaiting_vendor_confirmation"], { status: "confirmed", confirmed_at: this.now().toISOString(), reply_text: r.ownText, reply_message_id: stored.id, reply_has_link: r.hasLink });
      await this.repo.appendEvent(job.id, "booking", { status: "confirmed", approval_id: a.id, at: this.now().toISOString() });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${b.name} confirmed the booking (availability and the ${usdText(a.quote_total_cents)} terms)` });
      if (a.action === "confirm") {
        // Confirm-only (manual rail): the business's written yes completes the order; nothing is paid through Haggle.
        await this.fire(job.id, { type: "booking_confirmed" });
        await this.notifyHuman(job, `booked:${a.id}`, `${name} confirmed the order (${usdText(a.quote_total_cents)} total). Nothing was paid through Haggle; arrange payment with them directly.`);
        await this.repo.touchJob(job.id);
        return { jobId: job.id, outcome: "order_confirmed" };
      }
      const ho = await this.startHandoff(job, a, { ask: !r.paymentInstructions });
      if (ho && r.paymentInstructions) {
        // Thread continuity (an email proven only by the reply token) or a texted number is not proof of who wrote payment details.
        const sms = TEXT_OR_CALLER_ID_REASONS.has(trustReason);
        const weak = CONTINUITY_ONLY_REASONS.has(trustReason) || sms;
        const warning = [r.hasLink ? "contains a link: verify it with the business independently; Haggle never opens it" : null, sms ? SMS_PAYMENT_WARNING : weak ? CONTINUITY_ONLY_WARNING : null].filter(Boolean).join("; ");
        await this.repo.updateHandoff(ho.id, ["instructions_requested"], { status: "instructions_received", instructions_text: r.ownText, instructions_message_id: stored.id });
        await this.repo.appendEvent(job.id, "payment", { status: "instructions_received", rail: "manual", business_id: b.business_id, ...(warning ? { warning } : {}), ...(weak ? { sender_identity: weakIdentity(trustReason) } : {}) });
        await this.notifyHuman(job, `booked:${a.id}`, `${name} confirmed the booking and sent payment instructions (on the deal board${r.hasLink ? "; it has a link, so check it with them before paying" : ""}${weak ? "; confirm the payment details with them by phone first" : ""}). Pay them ${usdText(a.payment_cents)} directly; then reply PAID ${a.code}.`);
      } else if (!ho) {
        // The payment guard refused the handoff (e.g. the cap was lowered after approval): nobody is told to pay.
        await this.notifyHuman(job, `booked:${a.id}`, `${name} confirmed the booking, but this approval no longer passes Haggle's payment checks, so Haggle didn't ask how to pay them. Don't pay yet; the operator was flagged.`);
      } else {
        await this.notifyHuman(job, `booked:${a.id}`, `${name} confirmed the booking. Haggle asked how they take payment; don't pay until you have their instructions.`);
      }
      await this.repo.touchJob(job.id);
      return { jobId: job.id, outcome: "booking_confirmed" };
    }
    // Booked: the business's payment instructions (untrusted text). A reply without any is kept as a reply.
    if (h && ["instructions_requested", "instructions_received"].includes(h.status) && !r.paymentInstructions) {
      const stored = await store();
      if (!stored) return { jobId: job.id, outcome: "duplicate" };
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${b.name} replied (no payment instructions in it)` });
      await this.repo.touchJob(job.id);
      return { jobId: job.id, outcome: "purchase_reply" };
    }
    return this.ingestPaymentInstructions(b, msg, base, via, trustReason);
  }

  /** After the customer reported paying: the business's explicit "received", from a verified sender, makes it settled_verified. */
  private async ingestReceipt(job: JobRow, b: JobBusinessRow, a: ApprovalRow, h: PaymentHandoffRow, msg: InboundMessage, base: PurchaseBase, via: MessageRow["matched_via"], trustReason: string): Promise<{ jobId: string; outcome: string } | null> {
    if (await this.repo.getHandoffReceipt(h.id)) return null;
    const r = confirmsReceipt(msg.bodyText ?? "");
    const after = readBookingReply(msg.bodyText ?? "", { agreedCents: [a.quote_total_cents, a.payment_cents] });
    if (!r.received && after.intent !== "decline") return null;
    const stored = await this.repo.insertMessage({ ...base, job_id: job.id, business_id: b.business_id, kind: "reply", sender_trusted: true, trust_reason: trustReason as never, matched_via: via, parse_status: "none", quarantine_reason: null });
    if (!stored) return { jobId: job.id, outcome: "duplicate" };
    if (!r.received) {
      // The business backs out after the customer reported paying: no refund is claimed; a human handles it.
      await this.repo.appendEvent(job.id, "operator_attention", { reason: "business_withdrew_after_reported_payment", approval_id: a.id, business_id: b.business_id });
      this.log("operator_attention", { job_id: job.id, reason: "business_withdrew_after_reported_payment" });
      await this.notifyHuman(job, `withdrew:${a.id}`, `${clip(b.name, 30)} says it can't do it after you reported paying. Haggle can't reverse or refund a payment you made directly: contact them about it. The operator was flagged.`);
      return { jobId: job.id, outcome: "operator_attention" };
    }
    if (!bindsTermsAlone(trustReason)) {
      // A "received" Haggle can't attribute to the business (an email thread, a text) never verifies the money: the human is told instead.
      const texted = weakIdentity(trustReason) === "text_only";
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, kind: "receipt_unverified", sender_identity: weakIdentity(trustReason), summary: `${b.name}'s ${texted ? "text" : "thread"} says the payment was received, but Haggle can't verify the sender; not recorded as verified` });
      await this.notifyHuman(job, `received-unverified:${a.id}`, texted
        ? `${clip(b.name, 30)} says by text that your ${usdText(h.amount_cents)} payment arrived, but Haggle can't verify who sent it. Check with them directly if it matters.`
        : `${clip(b.name, 30)}'s email thread says your ${usdText(h.amount_cents)} payment arrived, but Haggle can't verify who sent it. Check with them directly if it matters.`);
      await this.repo.touchJob(job.id);
      return { jobId: job.id, outcome: "receipt_unverified" };
    }
    await this.repo.insertHandoffReceipt({ id: newId("rc"), handoff_id: h.id, job_id: job.id, message_id: stored.id, evidence: (r.ownText || "received").slice(0, 500) });
    await this.repo.appendEvent(job.id, "payment", { status: "settled_verified", rail: "manual", business_id: b.business_id, approval_id: a.id });
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `${b.name} confirmed it received the ${usdText(h.amount_cents)} payment` });
    await this.notifyHuman(job, `received:${a.id}`, `${clip(b.name, 30)} confirmed it received your ${usdText(h.amount_cents)} payment.`);
    await this.repo.touchJob(job.id);
    return { jobId: job.id, outcome: "receipt_confirmed" };
  }

  /**
   * Per advance: re-confirmations (collecting / negotiating) and, under the manual handoff, a booking
   * or payment instructions that are overdue. Each timeout happens once: one reminder to the business,
   * one text to the human, and an operator_attention event (operator-visible; the job is not failed).
   */
  private async purchaseTick(jobId: string) {
    const job = await this.repo.getJob(jobId);
    if (!job) return;
    const events = await this.repo.listEvents(jobId);
    if (job.state === "collecting" || job.state === "negotiating") {
      await this.resolveReconfirmations(job, events);
      return;
    }
    if (job.state !== "paying" || !this.d.config.manualPaymentHandoff) return;
    const a = await this.repo.getLatestApproval(jobId);
    if (!a || a.status !== "approved") return;
    const booking = await this.repo.getBookingByApproval(a.id);
    const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === a.business_id);
    if (!booking || !b) {
      // Approved before bookings existed, or the booking request never started: start it now.
      if (!booking && b && !(await this.repo.getHandoffByApproval(a.id))) await this.startBooking(job, a);
      return;
    }
    const at = (type: string, pred: (e: JobEventRow) => boolean) => { const e = events.filter((x) => x.type === type && pred(x)).at(-1); return e && typeof e.data.at === "string" ? Date.parse(e.data.at) : null; };
    const now = this.now().getTime();
    const name = clip(b.name, 30);
    if (booking.status === "awaiting_vendor_confirmation" && !booking.stalled_at) {
      const since = at("booking", (e) => e.data.approval_id === a.id && e.data.status === "awaiting_vendor_confirmation");
      if (since !== null && now - since > this.bookingTimeoutMs && (await this.repo.updateBooking(booking.id, ["awaiting_vendor_confirmation"], { stalled_at: this.now().toISOString() }))) {
        if (b.channel === "email" && b.email) await this.sendRecorded(job, b, "followup", `booking-nudge:${a.id}`, { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true, bodyText: `Hi ${b.name},\n\nJust checking: can you confirm the booking for ${job.request.what} at ${usdText(a.quote_total_cents)} total? Nothing has been paid yet.\n\n${this.signOff(job)}` }).catch((err: Error) => this.log("booking_nudge_failed", { job_id: jobId, error: err.message }));
        await this.repo.appendEvent(jobId, "operator_attention", { reason: "booking_unconfirmed", approval_id: a.id, business_id: b.business_id });
        this.log("operator_attention", { job_id: jobId, reason: "booking_unconfirmed" });
        await this.notifyHuman(job, `booking-stalled:${a.id}`, `${name} hasn't confirmed the booking yet; Haggle reminded them. Don't pay; you may want to call them or choose another option.`);
      }
      return;
    }
    if (booking.status === "not_in_writing" && !booking.human_attested_at) {
      // Waiting for the human to confirm it with the business directly (BOOKED <code>): one reminder, operator-visible.
      const since = at("booking", (e) => e.data.approval_id === a.id && e.data.status === "not_in_writing");
      if (!booking.stalled_at && since !== null && now - since > this.bookingTimeoutMs && (await this.repo.updateBooking(booking.id, ["not_in_writing"], { stalled_at: this.now().toISOString() }))) {
        await this.repo.appendEvent(jobId, "operator_attention", { reason: "booking_unattested", approval_id: a.id, business_id: b.business_id });
        this.log("operator_attention", { job_id: jobId, reason: "booking_unattested" });
        await this.notifyHuman(job, `booking-stalled:${a.id}`, `${name}'s booking still needs you: confirm it with them directly and reply BOOKED ${a.code}, or choose another option. Don't pay before that.`);
      }
      return;
    }
    const h = await this.repo.getHandoffByApproval(a.id);
    if (h?.status === "instructions_requested" && !h.stalled_at) {
      const since = at("payment", (e) => e.data.approval_id === a.id && e.data.status === "handoff_requested");
      if (since !== null && now - since > this.handoffTimeoutMs && (await this.repo.markHandoffStalled(h.id, this.now().toISOString()))) {
        if (b.channel === "email" && b.email) await this.sendRecorded(job, b, "followup", `handoff-nudge:${a.id}`, { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true, bodyText: `Hi ${b.name},\n\nJust checking: how would you like the customer to pay the ${usdText(a.payment_cents)}${a.payment_cents < a.quote_total_cents ? " deposit" : ""}? An invoice or payment instructions is fine. Haggle never takes or sends money.\n\n${this.signOff(job)}` }).catch((err: Error) => this.log("handoff_nudge_failed", { job_id: jobId, error: err.message }));
        await this.repo.appendEvent(jobId, "operator_attention", { reason: "payment_instructions_overdue", approval_id: a.id, business_id: b.business_id });
        this.log("operator_attention", { job_id: jobId, reason: "payment_instructions_overdue" });
        await this.notifyHuman(job, `handoff-stalled:${a.id}`, `${name} hasn't sent payment instructions yet; Haggle reminded them. Ask them directly how to pay; reply PAID ${a.code} only after you've paid.`);
      }
    }
  }

  /**
   * The approver texted a bare carrier opt-out keyword. Nothing is texted back (the carrier may block it,
   * and texting after an opt-out isn't allowed); texts are held until they text again. Recorded on each
   * of their open deals (the agent sees it) and flagged for the operator.
   */
  private async approverOptedOut(m: { messageId: string; text: string }, from: string, jobs: JobRow[]): Promise<{ jobId: string | null; outcome: string }> {
    const home = [...jobs].sort((x, y) => y.created_at.localeCompare(x.created_at))[0]!;
    const stored = await this.repo.insertMessage({
      job_id: home.id, business_id: null, approval_id: null, direction: "in", kind: "approval_reply", channel: "imessage", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 100), attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: "sms-from-text-approver", matched_via: null, parse_status: "none", quarantine_reason: null, round: null, simulated: false,
    });
    if (!stored) return { jobId: home.id, outcome: "duplicate" };
    const word = m.text.trim().replace(/[.!\s]+$/, "").toUpperCase();
    for (const job of jobs) {
      await this.repo.appendEvent(job.id, "operator_attention", { reason: "approver_carrier_opt_out", keyword: word });
      await this.repo.appendEvent(job.id, "reply", { business_id: null, kind: "approver_opted_out", summary: `The approver texted ${word}, which carriers treat as "stop texting me": Haggle won't text them until they text again (START, or any reply). Nothing was approved, cancelled or paid by it. Codes like CANCEL 482913 must include the code.` });
      await this.repo.touchJob(job.id);
    }
    this.log("operator_attention", { job_id: home.id, reason: "approver_carrier_opt_out" });
    return { jobId: home.id, outcome: "approver_opted_out" };
  }

  /** The business holding this deal's live approval opted out: the human hears Haggle can't text it any more. */
  private async noteBookedVendorOptedOut(job: JobRow, b: Pick<JobBusinessRow, "business_id" | "name">) {
    const a = await this.repo.getLatestApproval(job.id);
    if (!a || a.business_id !== b.business_id || !["approved", "used"].includes(a.status) || job.state !== "paying") return;
    await this.repo.appendEvent(job.id, "operator_attention", { reason: "booked_vendor_opted_out", approval_id: a.id, business_id: b.business_id });
    await this.notifyHuman(job, `vendor-opted-out:${a.id}`, `${clip(b.name, 30)} texted an opt-out word, so Haggle can't text them any more. Check the booking with them directly. Don't pay before you have.`);
  }

  private async routeText(m: { messageId: string; from: string; text: string }, from: string): Promise<{ jobId: string | null; outcome: string }> {
    const all = await this.repo.listOpenJobs();
    // Only the workspace (and, if the text names one, the deal) this number belongs to; between two
    // workspaces nothing is guessed: the text is held and the human asked for the deal code.
    const scope = await this.textScope(from, m.text, all);
    if (scope.kind === "ambiguous") return this.holdAmbiguousText(m, from, scope, "sms-in");
    const open = all.filter((j) => inTextScope(scope, j));
    // The human's words without the deal code they added to say which deal (a business's text stays whole).
    const hm = scope.kind === "workspace" ? { ...m, text: scope.text } : m;
    const last = await this.lastTextRoute(from, scope);
    const paid = hm.text.trim().match(PAID_TEXT);
    if (paid) return this.ingestPaidText(hm, from, open, paid[1], scope);
    const booked = hm.text.trim().match(BOOKED_TEXT);
    if (booked) return this.ingestBookedText(hm, from, open, booked[1], scope);
    // STOP (or any opt-out, including a bare carrier keyword like CANCEL or QUIT) from a number Haggle
    // texted as a business: never contacted again.
    const carrierWord = isCarrierOptOut(m.text);
    if (isOptOut(m.text) || carrierWord) {
      if (carrierWord) {
        // The approver's own bare keyword: Haggle stops texting them (ingestText holds every text) and says so on the deal.
        const theirs: JobRow[] = [];
        for (const job of open) if (from === (await this.notifyTarget(job))) theirs.push(job);
        if (theirs.length) return this.approverOptedOut(m, from, theirs);
      }
      for (const job of open) {
        const b = (await this.repo.getBusinesses(job.id)).find((x) => x.phone === from);
        if (!b || from === (await this.notifyTarget(job))) continue;
        const stored = await this.repo.insertMessage({
          job_id: job.id, business_id: b.business_id, approval_id: null, direction: "in", kind: "reply", channel: "imessage", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
          rfc_message_id: null, thread_id: null, from_address: from, to_address: job.inbox, subject: null, body_text: m.text.slice(0, 500), attachments: [], attachments_download_url: null,
          sender_trusted: true, trust_reason: "sms-reply-to-pinned-number", matched_via: "sms_number", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
        });
        if (!stored) return { jobId: job.id, outcome: "duplicate" };
        await this.optOut(job.id, b, from, m.text.slice(0, 200));
        await this.noteBookedVendorOptedOut(job, b);
        return { jobId: job.id, outcome: "opted_out" };
      }
    }
    // "PAY <code>" is never an answer or a business reply: it charges (approver only) or is ignored.
    const pay = hm.text.trim().match(PAY_TEXT);
    if (pay) return this.ingestPayText(hm, from, open, pay[1], scope);
    // "CALL <code>": the approver allowing one callback Haggle texted them about (never anyone else's say-so).
    const call = hm.text.trim().match(CALL_TEXT);
    if (call) {
      const r = await this.ingestCallbackText(hm, from, open, call[1]!);
      if (r) return r;
    }
    // "CANCEL <code>": the approver cancelling a booking the business confirmed (never the model's or a business's say-so).
    const cancelText = hm.text.trim().match(CANCEL_TEXT);
    if (cancelText) {
      const r = await this.ingestCancelText(hm, from, open, cancelText[1]!);
      if (r) return r;
    }
    {
      // The human even when no deal is open any more (e.g. "YES <code>" after the card approved and paid).
      let isHuman = (!!this.d.sms && from === this.d.config.notifyPhone?.replace(/[\s().-]/g, "")) || !!last?.approvalId;
      for (const job of open) if (from === (await this.notifyTarget(job))) isHuman = true;
      if (isHuman) {
        const decided = await this.ingestTextApproval(hm, from, open, last);
        if (decided) return decided;
        // "RESUME" (lifting Inkbox's pause on texts) is not an answer to a business.
        if (/^\s*(resume|updates?|start)\s*[.!]*\s*$/i.test(hm.text)) return { jobId: last?.jobId ?? null, outcome: "texts_resumed" };
      }
    }
    const businesses: TextDealCandidate[] = [];
    for (const job of open) {
      const msgs = await this.repo.listMessages(job.id);
      const texted = msgs.filter((x) => x.direction === "out" && x.to_address === from && x.provider_email_id?.startsWith("sms:"));
      if (!texted.length) continue;
      const rows = await this.repo.getBusinesses(job.id);
      for (const x of texted) {
        const b = rows.find((y) => y.business_id === x.business_id);
        if (b) businesses.push({ job, b, at: Date.parse(x.created_at), msgs });
      }
    }
    let human = false;
    for (const job of open) if (from === (await this.notifyTarget(job))) human = true;
    // The same number can be both (a teammate playing a business): the last text to it decides.
    if (businesses.length > 0 && (!human || last?.kind !== "human")) {
      const { hit: { job, b }, via } = pickTextDeal(businesses, m.text);
      // The SMS twin of the iMessage purchase hook (ingestBusinessIMessage): same reader, same certainty rule.
      if (via === "code" || new Set(businesses.map((x) => x.job.id)).size === 1) {
        const handled = await this.ingestPurchaseReply(b, textInbound(m, job, "sms-in"), textBase(m, job, "sms-in"), via === "code" ? "sms_number+code" : via === "open_ask" ? "sms_number+open_ask" : "sms_number", "sms-reply-to-pinned-number");
        if (handled) return handled;
      }
      const stored = await this.repo.insertMessage({
        job_id: job.id, business_id: b.business_id, approval_id: null, direction: "in", kind: "reply", channel: b.channel === "imessage" ? "imessage" : "phone", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
        rfc_message_id: null, thread_id: null, from_address: from, to_address: job.inbox, subject: null, body_text: m.text.slice(0, 5000) || null, attachments: [], attachments_download_url: null,
        // A reply to the follow-up Haggle texted to this business's pinned number.
        sender_trusted: true, trust_reason: "sms-reply-to-pinned-number", matched_via: via === "code" ? "sms_number+code" : via === "open_ask" ? "sms_number+open_ask" : "sms_number", parse_status: m.text.trim() ? "pending" : "none", quarantine_reason: null,
        round: null, simulated: false,
      });
      if (!stored) return { jobId: job.id, outcome: "duplicate" };
      await this.repo.updateBusiness(job.id, b.business_id, { last_reply_at: this.now().toISOString(), ...(b.status === "contacted" || b.status === "question" || b.status === "silent" || b.status === "replied" ? { status: "replied" as const } : {}) });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Text from ${b.name}`, channel: b.channel === "imessage" ? "imessage" : "phone", ...snippet(messageSnippet(m.text)) });
      await this.repo.touchJob(job.id);
      return { jobId: job.id, outcome: "stored" };
    }
    if (!human) return { jobId: null, outcome: "unknown_sender" };
    m = hm;
    // The human: numbered answers to the question list Haggle texted ("1: drop-off is fine. 2: no
    // dessert"), an answer naming the business ("answer Sunset Kitchen with ..." / "Sunset Kitchen: ..."),
    // else the question Haggle texted them about. Each answer goes to its business on its own channel.
    const pending: QuestionRow[] = [];
    for (const job of open) if (from === (await this.notifyTarget(job))) pending.push(...(await this.repo.listQuestions(job.id)).filter((q) => q.status === "pending"));
    const storeAnswer = (jobId: string) => this.repo.insertMessage({
      job_id: jobId, business_id: null, approval_id: null, direction: "in", kind: "answer", channel: "phone", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 2000) || null, attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: "sms-from-notify-number", matched_via: "sms_number", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
    });
    const batch = await this.lastQuestionBatch(open, from);
    const numbered = batch ? splitNumberedAnswers(m.text, batch.numbers.length) : null;
    if (batch && numbered) {
      if (!(await storeAnswer(batch.jobId))) return { jobId: batch.jobId, outcome: "duplicate" };
      const problems: string[] = [];
      let answered = 0;
      for (const part of numbered) {
        const q = pending.find((p) => batch.numbers[part.n - 1]!.includes(p.id));
        if (!q) { problems.push(`${part.n}: already answered`); continue; }
        try {
          await this.answerSeller(q.job_id, q.id, part.text);
          answered++;
        } catch (err) {
          if (!(err instanceof EngineError)) throw err;
          problems.push(`${part.n}: not sent (${err.message.slice(0, 80)})`);
        }
      }
      const job = await this.repo.getJob(batch.jobId);
      if (job && problems.length) await this.notifyHuman(job, `answers:${m.messageId}`, `${answered ? `sent ${answered} answer${answered === 1 ? "" : "s"}; ` : ""}${problems.join("; ")}.`);
      return { jobId: batch.jobId, outcome: answered ? "answered" : "no_open_question" };
    }
    let answer = m.text;
    let named: QuestionRow | undefined;
    const instruction = m.text.match(/^\s*(?:please\s+)?(?:answer|tell|reply(?:\s+to)?|respond(?:\s+to)?|for)\s+(.+)$/is);
    const lead = (instruction?.[1] ?? m.text).trimStart();
    for (const q of pending) {
      const b = (await this.repo.getBusinesses(q.job_id)).find((x) => x.business_id === q.business_id);
      if (!b || !lead.toLowerCase().startsWith(b.name.toLowerCase())) continue;
      // Without "answer ...", the name must be followed by a separator ("Sunset Kitchen: just food").
      const rest = lead.slice(b.name.length);
      if (!instruction && !/^\s*[:,\-–]/.test(rest)) continue;
      named = q;
      answer = rest.replace(/^\s*(?:with|that|saying|[:,\-–])\s*/i, "").trim() || m.text;
      break;
    }
    // Several businesses asked and the reply doesn't say which: ask the human, never guess.
    const lastListed = batch ? pending.filter((p) => batch.numbers.some((g) => g.includes(p.id))) : [];
    if (!named && batch && batch.numbers.length > 1 && new Set(lastListed.map((p) => p.business_id)).size > 1) {
      if (!(await storeAnswer(batch.jobId))) return { jobId: batch.jobId, outcome: "duplicate" };
      const job = await this.repo.getJob(batch.jobId);
      if (job) await this.notifyHuman(job, `which:${m.messageId}`, `which question is that for? Reply with its number, e.g. "1: ${m.text.replace(/\s+/g, " ").slice(0, 60)}".`, lastListed[0]!.id);
      return { jobId: batch.jobId, outcome: "ambiguous_answer" };
    }
    const target = named ?? pending.find((q) => q.id === last?.questionId) ?? pending.sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0];
    let jobId = target?.job_id ?? last?.jobId ?? null;
    if (!jobId) {
      // Nothing texted to this human yet: their newest open deal.
      const mine: JobRow[] = [];
      for (const job of open) if (from === (await this.notifyTarget(job))) mine.push(job);
      jobId = mine.sort((x, y) => y.created_at.localeCompare(x.created_at))[0]?.id ?? null;
    }
    const stored = jobId ? await storeAnswer(jobId) : null;
    if (jobId && !stored) return { jobId, outcome: "duplicate" };
    if (!target) {
      // Not an answer to anything open ("add cookies and brownies" is a change to the request): never
      // dropped silently. It goes on the deal for the agent (wait_for_update) and the human is told
      // how to change the request; nothing is sent to a business and the request isn't changed.
      const job = jobId ? await this.repo.getJob(jobId) : null;
      if (job && !TERMINAL.has(job.state)) {
        const said = clip(m.text, 200);
        await this.repo.appendEvent(job.id, "reply", {
          business_id: null, kind: "user_text", text: said,
          summary: `You texted: "${said}" (no business question was open, so nothing was sent to a business. If it changes the request, confirm with the user and pass it on with send_message; Haggle never changes a request by text.)`,
        });
        await this.repo.touchJob(job.id);
        // A greeting or a thanks (often just to lift Inkbox's pause on texts) needs no reply.
        if (!PLEASANTRY_TEXT.test(said)) await this.notifyHuman(job, `unmatched:${m.messageId}`, `got "${clip(said, 60)}", but no business question is open, so nothing was sent. To change the request, tell your agent in Claude.`);
      }
      return { jobId, outcome: "no_open_question" };
    }
    await this.answerSeller(target.job_id, target.id, answer);
    return { jobId: target.job_id, outcome: "answered" };
  }

  /**
   * The workspace (and, if the text names one, the deal) a text from this number belongs to, from
   * durable records only: deals whose workspace approver it is (open or recent), and open deals with
   * a business at that number. See textRouting.ts.
   */
  private async textScope(from: string, text: string, open: JobRow[]): Promise<TextScope> {
    const jobs = new Map<string, JobRow>();
    for (const j of [...open, ...(await this.repo.listRecentJobs(50))]) if (!jobs.has(j.id)) jobs.set(j.id, j);
    const openIds = new Set(open.map((j) => j.id));
    const humanOf = new Map<string, boolean>();
    const owners = new Map<string, JobRow[]>();
    const human: JobRow[] = [];
    for (const j of jobs.values()) {
      if (!humanOf.has(j.workspace_id)) humanOf.set(j.workspace_id, from === (await this.notifyTarget(j)));
      const isHuman = humanOf.get(j.workspace_id)!;
      if (!isHuman && !(openIds.has(j.id) && (await this.repo.getBusinesses(j.id)).some((b) => b.phone === from))) continue;
      owners.set(j.workspace_id, [...(owners.get(j.workspace_id) ?? []), j]);
      if (isHuman) human.push(j);
    }
    if (owners.size < 2) return decideTextScope(owners, text);
    // An approval code (YES / NO / PAY / PAID 4821) on exactly one workspace's latest approval for this human decides too.
    const t = text.trim();
    const code = t.match(TEXT_DECISION)?.[2] ?? t.match(PAY_TEXT)?.[1] ?? t.match(PAID_TEXT)?.[1];
    const coded: string[] = [];
    if (code) for (const j of human) if ((await this.repo.getLatestApproval(j.id))?.code === code) coded.push(j.workspace_id);
    // A callback code (CALL 482913) only one workspace's pending callback has decides too.
    const callCode = t.match(CALL_TEXT)?.[1];
    if (callCode) for (const j of human) if (await this.hasCallbackCode(j.id, callCode)) coded.push(j.workspace_id);
    const cancelCode = t.match(CANCEL_TEXT)?.[1];
    if (cancelCode) for (const j of human) if (await this.hasCancelCode(j.id, cancelCode)) coded.push(j.workspace_id);
    return decideTextScope(owners, text, coded);
  }

  /**
   * A text from a number tied to deals in several workspaces that doesn't say which (no deal code,
   * no approval code only one of them has): never routed by guess. Kept for audit (no job,
   * quarantined); the human is asked to resend it with the deal code, and each business deal it
   * might answer notes that a reply is waiting on the code. Nothing of one deal is shown to another.
   */
  private async holdAmbiguousText(m: { messageId: string; text: string }, from: string, scope: Extract<TextScope, { kind: "ambiguous" }>, prefix: "sms-in" | "imsg-in"): Promise<{ jobId: string | null; outcome: string }> {
    const stored = await this.repo.insertMessage({
      job_id: null, business_id: null, approval_id: null, direction: "in", kind: "quarantine", channel: "imessage", provider_email_id: `${prefix}:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 2000) || null, attachments: [], attachments_download_url: null,
      sender_trusted: false, trust_reason: "text-number-on-several-workspaces", matched_via: null, parse_status: "none", quarantine_reason: "ambiguous_workspace", round: null, simulated: false,
    });
    if (!stored) return { jobId: null, outcome: "duplicate" };
    this.log("text_held_ambiguous", { from: maskHandle(from), workspaces: scope.workspaces.length });
    const tied = [...new Map(scope.jobs.map((j) => [j.id, j])).values()].filter((j) => !TERMINAL.has(j.state)).sort((a, b) => b.created_at.localeCompare(a.created_at));
    let told = false;
    // Only deal codes this number was already given (it approves that deal, or Haggle contacted it on
    // it): another workspace's deal code is never revealed to it.
    const known: JobRow[] = [];
    for (const j of tied) if (from === (await this.notifyTarget(j)) || (await this.repo.getBusinesses(j.id)).some((x) => x.phone === from && x.contacted_at)) known.push(j);
    for (const j of tied) {
      const b = (await this.repo.getBusinesses(j.id)).find((x) => x.phone === from);
      if (b) await this.repo.appendEvent(j.id, "reply", { business_id: b.business_id, kind: "text_held", summary: `A text from ${b.name} was held unread: its number is on more than one Haggle deal, so Haggle can't tell which one it answers. Ask ${b.name} to include HG-${j.short_code} in the reply (send_message).` });
      if (!told && prefix === "sms-in" && from === (await this.notifyTarget(j))) {
        told = true;
        const codes = known.slice(0, 4).map((x) => `HG-${x.short_code}`).join(", ");
        await this.notifyHuman(j, `which-deal:${m.messageId}`, `this number has open deals in more than one Haggle account (${codes}), so nothing was done with "${clip(m.text, 40)}". Reply again starting with the deal code, e.g. "HG-${j.short_code}: ${clip(m.text, 30)}".`);
      }
    }
    return { jobId: null, outcome: "ambiguous_workspace" };
  }

  /**
   * Operator only (scripts, never an MCP tool): route a text held as ambiguous (holdAmbiguousText) to
   * one deal its number belongs to: that deal's approver, or a business Haggle contacted at it, and
   * the deal still open. Never an approval, payment or callback reply (YES / NO / PAY / PAID / CALL):
   * who decided what for whom is the human's to say, so they resend it with the deal code. Once per text.
   */
  async releaseHeldText(heldMessageId: string, jobId: string, operator: string): Promise<{ jobId: string | null; outcome: string }> {
    if (operator.trim().length < 2) throw new EngineError("operator_required", "Name the operator releasing the text.", "Pass --operator <name>.", "none");
    const held = await this.repo.getMessage(heldMessageId);
    if (!held || held.kind !== "quarantine" || held.quarantine_reason !== "ambiguous_workspace" || held.job_id !== null || !held.from_address || !held.provider_email_id) {
      throw new EngineError("not_held", "No held ambiguous text with that id.", "Use the id of a quarantined message with reason ambiguous_workspace.", "none");
    }
    const job = await this.repo.getJob(jobId);
    if (!job || TERMINAL.has(job.state)) throw new EngineError("job_not_open", "That deal isn't open.", "Release only to an open deal the number belongs to.", "none");
    const from = held.from_address;
    const text = held.body_text ?? "";
    const t = withoutJobCode(text);
    if (TEXT_DECISION.test(t) || PAY_TEXT.test(t) || PAID_TEXT.test(t) || CALL_TEXT.test(t) || BOOKED_TEXT.test(t.trim()) || CANCEL_TEXT.test(t.trim())) {
      throw new EngineError("decision_not_releasable", "A held approval, payment, callback or cancellation reply is never attributed by an operator.", "Ask the human to resend it with the deal code (e.g. \"YES 4821 HG-AB12\").", "none");
    }
    const tied = from === (await this.notifyTarget(job)) || (await this.repo.getBusinesses(job.id)).some((b) => b.phone === from && b.contacted_at);
    if (!tied) throw new EngineError("not_tied", "That number isn't this deal's approver or a business Haggle contacted on it.", "Release the text to a deal the number belongs to.", "none");
    const prefix = held.provider_email_id.startsWith("imsg-in:") ? "imsg-in" : "sms-in";
    const m = { messageId: `${held.provider_email_id.slice(prefix.length + 1)}:released`, from, text: `HG-${job.short_code} ${text}` };
    if (await this.repo.findMessageByProviderId(`${prefix}:${m.messageId}`)) return { jobId: job.id, outcome: "duplicate" };
    await this.repo.appendEvent(job.id, "text_released", { held_message_id: held.id, operator: operator.trim().slice(0, 60) });
    this.log("text_released", { job_id: job.id, from: maskHandle(from) });
    return prefix === "imsg-in" ? this.ingestBusinessIMessage(m) : this.routeText(m, from);
  }

  /**
   * A text from a business on the iMessage channel (not the approver): matched by its pinned
   * number to the most recent open job that texted it, stored and parsed like an email body.
   * Trusted: iMessage sender handles are carrier/Apple-registered and Inkbox delivers them on the
   * buyer identity's own connection (not caller ID). Idempotent per message id.
   */
  private async ingestBusinessIMessage(m: { messageId: string; from: string; text: string }): Promise<{ jobId: string | null; outcome: string }> {
    const hits: TextDealCandidate[] = [];
    for (const job of await this.repo.listOpenJobs()) {
      const mine = (await this.repo.getBusinesses(job.id)).filter((b) => b.channel === "imessage" && b.phone === m.from && b.contacted_at);
      if (!mine.length) continue;
      const msgs = await this.repo.listMessages(job.id);
      for (const b of mine) hits.push({ job, b, at: Date.parse(b.contacted_at!), msgs });
    }
    if (!hits.length) return { jobId: null, outcome: "unknown_sender" };
    // Deals in several workspaces with this number: only the deal code it quotes decides, never a guess.
    const workspaces = [...new Set(hits.map((h) => h.job.workspace_id))].sort();
    if (workspaces.length > 1) {
      const code = jobCodeIn(m.text);
      const named = code ? hits.filter((h) => h.job.short_code.toUpperCase() === code) : [];
      if (!named.length) return this.holdAmbiguousText(m, m.from, { kind: "ambiguous", workspaces, jobs: hits.map((h) => h.job) }, "imsg-in");
      hits.splice(0, hits.length, ...named);
    }
    // Same number on several open jobs (decision 46): the HG-<code> it quotes wins, else the deal
    // waiting on its answer (newest ask), else the most recently contacted job.
    const { hit: { job, b }, via } = pickTextDeal(hits, m.text);
    const byCode = via === "code";
    // STOP (or another opt-out) by iMessage: the same as by SMS, never contacted again on any channel.
    if (isOptOut(m.text) || isCarrierOptOut(m.text)) {
      const stored = await this.repo.insertMessage({
        job_id: job.id, business_id: b.business_id, approval_id: null, direction: "in", kind: "reply", channel: "imessage", provider_email_id: `imsg-in:${m.messageId}`, idempotency_key: null,
        rfc_message_id: null, thread_id: null, from_address: m.from, to_address: job.inbox, subject: null, body_text: m.text.slice(0, 500), attachments: [], attachments_download_url: null,
        sender_trusted: true, trust_reason: "imessage-from-pinned-number", matched_via: "imessage_number", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
      });
      if (!stored) return { jobId: job.id, outcome: "duplicate" };
      await this.optOut(job.id, b, m.from, m.text.slice(0, 200));
      await this.noteBookedVendorOptedOut(job, b);
      return { jobId: job.id, outcome: "opted_out" };
    }
    // A booking confirmation, re-confirmation, payment instructions or receipt by text: the same purchase
    // reader as email, on the same identity (this business's pinned number on this deal's text channel),
    // and only when the deal is certain (one open deal for this number, or the text quotes its HG code).
    if (byCode || new Set(hits.map((h) => h.job.id)).size === 1) {
      const handled = await this.ingestPurchaseReply(b, textInbound(m, job, "imsg-in"), textBase(m, job, "imsg-in"), byCode ? "imessage_number+code" : via === "open_ask" ? "imessage_number+open_ask" : "imessage_number", "imessage-from-pinned-number");
      if (handled) return handled;
    }
    const stored = await this.repo.insertMessage({
      job_id: job.id, business_id: b.business_id, approval_id: null, direction: "in", kind: "reply", channel: "imessage", provider_email_id: `imsg-in:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: m.from, to_address: job.inbox, subject: null, body_text: m.text.slice(0, 5000) || null, attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: "imessage-from-pinned-number", matched_via: byCode ? "imessage_number+code" : via === "open_ask" ? "imessage_number+open_ask" : "imessage_number", parse_status: m.text.trim() ? "pending" : "none", quarantine_reason: null,
      round: null, simulated: false,
    });
    if (!stored) return { jobId: job.id, outcome: "duplicate" };
    await this.repo.updateBusiness(job.id, b.business_id, { last_reply_at: this.now().toISOString(), ...(b.status === "contacted" || b.status === "question" ? { status: "replied" as const } : {}) });
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Text from ${b.name}`, channel: "imessage", ...snippet(messageSnippet(m.text)) });
    await this.repo.touchJob(job.id);
    return { jobId: job.id, outcome: "stored" };
  }

  /**
   * Phone vendors worth one negotiation callback, with the evidence: their current quote and a real,
   * eligible, cheaper quote from another business on this job. Nothing is placed here; a callback
   * needs a human's go-ahead (placeCallback).
   */
  async callbackProposals(jobId: string): Promise<CallbackProposal[]> {
    const job = await this.loadJob(jobId);
    // Only while the deal has a negotiation round left (decision 37): countered rounds < max_rounds (≤ MAX_ROUND).
    if (!this.d.phone || TERMINAL.has(job.state) || !this.hasRoundLeft(job)) return [];
    const [businesses, { quotes, ranking }] = await Promise.all([this.repo.getBusinesses(jobId), this.rankRows(job)]);
    const out: CallbackProposal[] = [];
    for (const b of businesses.filter((x) => x.channel === "phone" && x.phone)) {
      const mine = quotes.find((q) => q.business_id === b.business_id && q.total_cents !== null);
      // Only a phone business not countered yet (an automatic counter round may already have called it,
      // decision 13), and never past the deal's rounds (decision 37).
      if (!mine || b.countered_round > 0 || mine.round + 1 > Math.min(job.max_rounds, MAX_ROUND)) continue;
      if (await this.repo.findMessageByIdempotencyKey(`call:${job.id}:${b.business_id}:r${mine.round + 1}`)) continue;
      // The best eligible competing quote on this job (another business), from this one ranking.
      const best = ranking.ranked.find((r) => r.businessId !== b.business_id);
      const bq = best ? quotes.find((x) => x.id === best.quoteId) : undefined;
      const basis = bq?.total_cents ? { total_cents: bq.total_cents, id: bq.id } : null;
      if (!basis || basis.total_cents >= mine.total_cents!) continue;
      const basisRow = quotes.find((q) => q.id === basis.id)!;
      const approx = isApproximate(basisRow.record);
      const money = (c: number) => `$${centsToUsd(c).toLocaleString("en-US")}`;
      out.push({
        business_id: b.business_id, business: b.name, their_quote_id: mine.id, their_total_usd: centsToUsd(mine.total_cents!), basis_quote_id: basis.id,
        basis_total_usd: centsToUsd(basis.total_cents), basis_business: businesses.find((x) => x.business_id === basisRow.business_id)?.name ?? "another business",
        ...(approx ? { basis_approximate: true } : {}), round: 2,
        why: `${b.name} ${isApproximate(mine.record) ? `estimated about ${money(mine.total_cents!)}` : `quoted ${money(mine.total_cents!)}`}; ${approx ? `another business estimated about ${money(basis.total_cents)} (not yet firm)` : `a real eligible quote of ${money(basis.total_cents)} is on this deal`}.`,
      });
    }
    return out;
  }

  /**
   * One negotiation callback, after a human authorized it: Voice AI calls the pinned number again,
   * says it is an AI assistant, and may cite only the real competing total (re-checked now). Recorded
   * as a counteroffer so the board's negotiation history shows it; the answer arrives via call.ended.
   */
  async placeCallback(jobId: string, businessId: string, authorizedBy: string): Promise<{ placed: boolean; proposal: CallbackProposal }> {
    const current = await this.loadJob(jobId);
    if (!TERMINAL.has(current.state) && !this.hasRoundLeft(current)) {
      throw new EngineError("no_rounds_left", `This deal has no negotiation round left (round ${current.round} of ${Math.min(current.max_rounds, MAX_ROUND)}); a callback would open another.`,
        current.max_rounds < MAX_ROUND ? "Choose among the current quotes (get_quotes, then approve); a deal started with max_rounds 2 allows one negotiation round, callbacks included." : "Choose among the current quotes (get_quotes, then approve).", "get_quotes");
    }
    const proposal = (await this.callbackProposals(jobId)).find((p) => p.business_id === businessId);
    if (!proposal) throw new EngineError("callback_not_justified", "There is no evidence-based reason to call this business back now (no cheaper eligible competing quote, already called back, or rounds used up).", "Call get_quotes to see the current quotes; callbacks are offered there when justified.", "get_quotes");
    const job = await this.loadJob(jobId);
    const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === businessId)!;
    const key = `call:${job.id}:${b.business_id}:r${proposal.round}`;
    const reqs = job.request.requirements.filter((r) => r.hard).map((r) => r.text);
    const mine = await this.repo.getQuote(proposal.their_quote_id);
    const reason = HaggleEngine.callBrief(b.name, job, reqs, { competingTotalUsd: proposal.basis_total_usd, competingApproximate: proposal.basis_approximate === true, followUpOnQuoteUsd: proposal.their_total_usd, followUpApproximate: isApproximate(mine?.record), customer: this.customer(job) });
    const { callId } = await this.placeCallOnce(job.id, { jobId: job.id, businessId: b.business_id, toNumber: b.phone!, reason, idempotencyKey: key });
    await this.repo.insertMessage({
      job_id: job.id, business_id: b.business_id, approval_id: null, direction: "out", kind: "call", channel: "phone", provider_email_id: callId, idempotency_key: key,
      rfc_message_id: null, thread_id: null, from_address: job.inbox, to_address: b.phone, subject: null, body_text: reason, attachments: [], attachments_download_url: null,
      sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: proposal.round, simulated: job.mode === "mock",
    });
    await this.repo.updateBusiness(job.id, b.business_id, { status: "ringing", countered_round: proposal.round });
    await this.repo.appendEvent(job.id, "counteroffer", { business_id: b.business_id, round: proposal.round, target_total_usd: proposal.basis_total_usd, basis_quote_id: proposal.basis_quote_id, ...(proposal.basis_approximate ? { basis_approximate: true } : {}), channel: "phone", authorized_by: authorizedBy });
    await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Calling ${b.name} back (Voice AI), citing ${proposal.basis_approximate ? `another business's estimate of about $${proposal.basis_total_usd.toLocaleString("en-US")}` : `a real $${proposal.basis_total_usd.toLocaleString("en-US")} quote`}`, channel: "phone" });
    await this.repo.touchJob(job.id);
    return { placed: true, proposal };
  }

  /**
   * Live mode, or approvals out-of-band only: a callback rings a real person, so no board tap, client
   * form, view-held code or model call places one; only the approver's CALL <code> text or an operator.
   */
  get callbacksNeedApproverText(): boolean {
    return this.d.config.mode === "live" || this.outOfBandApprovalsOnly;
  }

  /** The callee's consent to a callback (callbackAuth.ts), from durable records. Mock (DEMO) jobs call only the simulated fleet. */
  async callbackConsentFor(jobId: string, businessId: string): Promise<CallbackConsent> {
    const job = await this.loadJob(jobId);
    const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === businessId);
    if (!b) return { ok: false, reason: "not a business on this deal" };
    const suppressed = b.phone ? (await this.repo.findSuppressions([b.phone])).length > 0 : false;
    if (job.mode === "mock" && !this.callbacksNeedApproverText) return suppressed ? { ok: false, reason: "this number is suppressed" } : { ok: true, basis: "simulated_vendor" };
    return callbackConsent({ business: b, workspaceVendors: await this.repo.listWorkspaceVendors(job.workspace_id), messages: await this.repo.listMessages(jobId), suppressed });
  }

  private async requireCallbackConsent(jobId: string, businessId: string) {
    const c = await this.callbackConsentFor(jobId, businessId);
    if (!c.ok) throw new EngineError("callback_no_consent", `Haggle won't call this business back: ${c.reason}.`, "Negotiate by email or text (send_message), or ask the operator to add the vendor with its recorded consent (workspace-admin add-vendor --consent).", "get_quotes");
    return c;
  }

  /** A justified callback proposal, or the same refusals placeCallback gives. */
  private async callbackProposalOrThrow(jobId: string, businessId: string): Promise<CallbackProposal> {
    const current = await this.loadJob(jobId);
    if (!TERMINAL.has(current.state) && !this.hasRoundLeft(current)) {
      throw new EngineError("no_rounds_left", `This deal has no negotiation round left (round ${current.round} of ${Math.min(current.max_rounds, MAX_ROUND)}); a callback would open another.`, "Choose among the current quotes (get_quotes, then approve).", "get_quotes");
    }
    const proposal = (await this.callbackProposals(jobId)).find((p) => p.business_id === businessId);
    if (!proposal) throw new EngineError("callback_not_justified", "There is no evidence-based reason to call this business back now (no cheaper eligible competing quote, already called back, or rounds used up).", "Call get_quotes to see the current quotes; callbacks are offered there when justified.", "get_quotes");
    return proposal;
  }

  /**
   * Ask the workspace approver, out of band, to allow one callback: a text to their own phone with a
   * one-time code ("Reply CALL <code>"). The code goes only to that phone (a hash is kept), never to
   * the model, the board or the response. Nothing is dialed here; ingestCallbackText places the call.
   */
  async requestCallbackAuthorization(jobId: string, businessId: string): Promise<{ auth_id: string; texted: boolean; held: boolean; expires_at: string; proposal: CallbackProposal; consent: CallbackConsent }> {
    const proposal = await this.callbackProposalOrThrow(jobId, businessId);
    const consent = await this.requireCallbackConsent(jobId, businessId);
    const job = await this.loadJob(jobId);
    const to = await this.notifyTarget(job);
    if (!to) throw new EngineError("NO_HUMAN_CHANNEL", "No way to reach this workspace's approver by text: a callback is placed only after the approver texts CALL <code>.", "Ask the operator to set the workspace approver phone (workspace-admin set-approver) and enable texting. Nothing was called.", "none");
    // One open authorization per business: a new request replaces an older, unanswered one.
    for (const old of pendingCallbackAuths(await this.repo.listEvents(jobId), this.now()).filter((a) => a.business_id === businessId)) {
      await this.repo.appendEvent(jobId, "callback_auth_decided", { auth_id: old.auth_id, business_id: businessId, decision: "superseded" });
    }
    const authId = newId("cba");
    const code = newCallbackCode();
    const expires = new Date(this.now().getTime() + CALLBACK_AUTH_TTL_MS).toISOString();
    await this.repo.appendEvent(jobId, "callback_auth_requested", { auth_id: authId, business_id: businessId, code_hash: callbackCodeHash(authId, code), expires_at: expires, round: proposal.round, basis_total_usd: proposal.basis_total_usd, consent: consent.ok ? consent.basis : null });
    const money = (n: number) => `$${n.toLocaleString("en-US")}`;
    const text = `Haggle: OK for Haggle's AI assistant to call ${clip(proposal.business, 30)} back once, to ask if they can beat a real ${money(proposal.basis_total_usd)} quote? Nothing is bought. Reply CALL ${code} to allow (expires in 30 min). (HG-${job.short_code})`.slice(0, SMS_LIMIT);
    const r = await this.textHuman(job, to, { key: `notify:${job.id}:callback-auth:${authId}`, text });
    await this.repo.appendEvent(jobId, "reply", { business_id: businessId, summary: `Asked the approver by text to allow one callback to ${proposal.business}${r.ok ? "" : ` (text ${r.reason === "unanswered_limit" ? "held until they text Haggle" : "not sent"})`}` });
    await this.repo.touchJob(jobId);
    return { auth_id: authId, texted: r.ok, held: !r.ok && r.reason === "unanswered_limit", expires_at: expires, proposal, consent };
  }

  /**
   * An operator places a callback (scripts, never an MCP tool): the callee's consent and the proposal
   * are still required; recorded as the operator's authorization.
   */
  async operatorCallback(jobId: string, businessId: string, operator: string): Promise<{ placed: boolean; proposal: CallbackProposal }> {
    if (operator.trim().length < 2) throw new EngineError("operator_required", "Name the operator authorizing the callback.", "Pass --operator <name>.", "none");
    await this.callbackProposalOrThrow(jobId, businessId);
    await this.requireCallbackConsent(jobId, businessId);
    return this.placeCallback(jobId, businessId, `operator:${operator.trim().slice(0, 60)}`);
  }

  /**
   * "CALL <code>" texted to Haggle's line. Only from a job's own text approver (the workspace approver;
   * the notify number on the default workspace), only for a pending authorization of that job whose
   * code matches; consent and the proposal are re-checked before the one call. Null when the sender is
   * no job's approver (left to the normal routing, e.g. a business's reply). Idempotent per message id.
   */
  private async ingestCallbackText(m: { messageId: string; text: string }, from: string, open: JobRow[], code: string): Promise<{ jobId: string | null; outcome: string } | null> {
    const mine: JobRow[] = [];
    for (const job of open) if (from === (await this.notifyTarget(job))) mine.push(job);
    if (!mine.length) return null;
    const pending: { job: JobRow; a: ReturnType<typeof pendingCallbackAuths>[number] }[] = [];
    for (const job of mine) for (const a of pendingCallbackAuths(await this.repo.listEvents(job.id), this.now())) pending.push({ job, a });
    const hit = pending.find((p) => codeMatches(p.a.auth_id, code, p.a.code_hash));
    const home = hit?.job ?? pending[0]?.job ?? mine.sort((x, y) => y.created_at.localeCompare(x.created_at))[0]!;
    const stored = await this.repo.insertMessage({
      job_id: home.id, business_id: null, approval_id: null, direction: "in", kind: "approval_reply", channel: "imessage", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 200), attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: "sms-from-text-approver", matched_via: "approval_code", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
    });
    if (!stored) return { jobId: home.id, outcome: "duplicate" };
    if (!hit) {
      // A wrong code counts against every callback waiting for this approver (a guess can't be retried forever).
      for (const p of pending) {
        await this.repo.appendEvent(p.job.id, "callback_auth_wrong_code", { auth_id: p.a.auth_id });
        if (p.a.wrong + 1 >= MAX_CALLBACK_CODE_ATTEMPTS) await this.repo.appendEvent(p.job.id, "callback_auth_decided", { auth_id: p.a.auth_id, business_id: p.a.business_id, decision: "locked" });
      }
      await this.notifyHuman(home, `callback-ack:${m.messageId}`, `no callback is waiting for code ${code}, so nobody was called.`);
      return { jobId: home.id, outcome: "callback_no_match" };
    }
    const { job, a } = hit;
    await this.repo.appendEvent(job.id, "callback_auth_decided", { auth_id: a.auth_id, business_id: a.business_id, decision: "authorized", by: `approver-text:${maskHandle(from)}` });
    try {
      await this.callbackProposalOrThrow(job.id, a.business_id);
      await this.requireCallbackConsent(job.id, a.business_id);
      const { proposal } = await this.placeCallback(job.id, a.business_id, `approver-text:${maskHandle(from)}:${a.auth_id}`);
      await this.notifyHuman(job, `callback-ack:${m.messageId}`, `calling ${clip(proposal.business, 30)} back now (AI assistant, one call). The deal board shows the result.`);
      return { jobId: job.id, outcome: "callback_placed" };
    } catch (err) {
      if (!(err instanceof EngineError) && !(err instanceof ChannelSendError)) throw err;
      await this.notifyHuman(job, `callback-ack:${m.messageId}`, `nobody was called: ${clip(err.message, 120)}`);
      return { jobId: job.id, outcome: "callback_refused" };
    }
  }

  /** Is this one of the job's pending callback codes (text scoping between workspaces)? */
  private async hasCallbackCode(jobId: string, code: string): Promise<boolean> {
    return pendingCallbackAuths(await this.repo.listEvents(jobId), this.now()).some((a) => codeMatches(a.auth_id, code, a.code_hash));
  }

  /** Is this one of the job's pending cancellation codes (text scoping between workspaces)? */
  private async hasCancelCode(jobId: string, code: string): Promise<boolean> {
    return pendingCallbackAuths(await this.repo.listEvents(jobId), this.now(), "cancel").some((a) => codeMatches(a.auth_id, code, a.code_hash));
  }

  /** The deal's booking the business confirmed in writing (or the approver attested), still before any reported payment. */
  private async vendorConfirmedBooking(job: JobRow): Promise<{ a: ApprovalRow; booking: BookingRow } | null> {
    if (job.state !== "paying" || !this.d.config.manualPaymentHandoff) return null;
    const a = await this.repo.getLatestApproval(job.id);
    if (!a || !["approved", "used"].includes(a.status)) return null;
    const booking = await this.repo.getBookingByApproval(a.id);
    return booking && isVendorConfirmed(booking) ? { a, booking } : null;
  }

  /**
   * Ask the workspace approver, out of band, to cancel a booking the business already confirmed: a text
   * to their own phone with a one-time code ("Reply CANCEL <code>"). The code goes only to that phone (a
   * hash is kept), never to the model or the response. Nothing is cancelled or sent to the business here.
   */
  private async requestCancelAuthorization(job: JobRow, a: ApprovalRow): Promise<{ ok: true; state: JobState; needs_approver: true; note: string }> {
    const name = await this.businessName(job.id, a.business_id);
    const to = await this.notifyTarget(job);
    if (!to) throw new EngineError("NO_HUMAN_CHANNEL", `${name} already confirmed this booking; only the approver can cancel it (by texting CANCEL <code>), and this workspace has no approver phone.`, "Ask the operator to set the workspace approver phone (workspace-admin set-approver). Nothing was cancelled or sent.", "none");
    // One open request per deal: a new one replaces an older, unanswered one.
    for (const old of pendingCallbackAuths(await this.repo.listEvents(job.id), this.now(), "cancel")) {
      await this.repo.appendEvent(job.id, "cancel_auth_decided", { auth_id: old.auth_id, business_id: old.business_id, decision: "superseded" });
    }
    const authId = newId("cna");
    const code = newCallbackCode();
    const expires = new Date(this.now().getTime() + CALLBACK_AUTH_TTL_MS).toISOString();
    await this.repo.appendEvent(job.id, "cancel_auth_requested", { auth_id: authId, business_id: a.business_id, approval_id: a.id, code_hash: callbackCodeHash(authId, code), expires_at: expires });
    const text = `Haggle: cancel the booking ${clip(name, 30)} confirmed (${usdText(a.quote_total_cents)})? Haggle will tell them not to hold it. Reply CANCEL ${code} to cancel (expires in 30 min). (HG-${job.short_code})`.slice(0, SMS_LIMIT);
    const r = await this.textHuman(job, to, { key: `notify:${job.id}:cancel-auth:${authId}`, text });
    await this.repo.appendEvent(job.id, "reply", { business_id: a.business_id, summary: `Asked the approver by text to confirm cancelling the booking with ${name}${r.ok ? "" : " (text not sent yet)"}; nothing was cancelled` });
    await this.repo.touchJob(job.id);
    const note = `${name} already confirmed this booking, so only the approver can cancel it: Haggle texted them a code to reply CANCEL <code>${r.ok ? "" : " (the text is held until they next text Haggle)"}. Nothing was cancelled or sent to ${name}.`;
    return { ok: true as const, state: job.state, needs_approver: true as const, note };
  }

  /**
   * "CANCEL <code>" texted to Haggle's line: only from a job's own text approver, only for that job's
   * pending cancellation whose code matches, and only while it is still the same confirmed booking.
   * Null when the sender is no job's approver (left to the normal routing). Idempotent per message id.
   */
  private async ingestCancelText(m: { messageId: string; text: string }, from: string, open: JobRow[], code: string): Promise<{ jobId: string | null; outcome: string } | null> {
    const mine: JobRow[] = [];
    for (const job of open) if (from === (await this.notifyTarget(job))) mine.push(job);
    if (!mine.length) return null;
    const pending: { job: JobRow; a: ReturnType<typeof pendingCallbackAuths>[number] }[] = [];
    for (const job of mine) for (const a of pendingCallbackAuths(await this.repo.listEvents(job.id), this.now(), "cancel")) pending.push({ job, a });
    const hit = pending.find((p) => codeMatches(p.a.auth_id, code, p.a.code_hash));
    const home = hit?.job ?? pending[0]?.job ?? mine.sort((x, y) => y.created_at.localeCompare(x.created_at))[0]!;
    const stored = await this.repo.insertMessage({
      job_id: home.id, business_id: null, approval_id: null, direction: "in", kind: "approval_reply", channel: "imessage", provider_email_id: `sms-in:${m.messageId}`, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 200), attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: "sms-from-text-approver", matched_via: "approval_code", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
    });
    if (!stored) return { jobId: home.id, outcome: "duplicate" };
    if (!hit) {
      // A wrong code counts against every cancellation waiting for this approver (a guess can't be retried forever).
      for (const p of pending) {
        await this.repo.appendEvent(p.job.id, "cancel_auth_wrong_code", { auth_id: p.a.auth_id });
        if (p.a.wrong + 1 >= MAX_CALLBACK_CODE_ATTEMPTS) await this.repo.appendEvent(p.job.id, "cancel_auth_decided", { auth_id: p.a.auth_id, business_id: p.a.business_id, decision: "locked" });
      }
      await this.notifyHuman(home, `cancel-ack:${m.messageId}`, `no cancellation is waiting for code ${code}, so nothing was cancelled.`);
      return { jobId: home.id, outcome: "cancel_no_match" };
    }
    const { job, a: auth } = hit;
    const by = `approver-text:${maskHandle(from)}`;
    await this.repo.appendEvent(job.id, "cancel_auth_decided", { auth_id: auth.auth_id, business_id: auth.business_id, decision: "authorized", by });
    const asked = (await this.repo.listEvents(job.id)).find((e) => e.type === "cancel_auth_requested" && e.data.auth_id === auth.auth_id);
    const held = await this.vendorConfirmedBooking(await this.loadJob(job.id));
    const name = clip(await this.businessName(job.id, auth.business_id), 30);
    if (held && held.a.id !== asked?.data.approval_id) {
      await this.notifyHuman(job, `cancel-ack:${m.messageId}`, `the booking changed since Haggle asked, so nothing was cancelled. Ask again if you still want to cancel.`);
      return { jobId: job.id, outcome: "cancel_refused" };
    }
    try {
      const r = await this.cancelJob(job.id, by);
      await this.notifyHuman(job, `cancel-ack:${m.messageId}`, r.state === "cancelled"
        ? `cancelled: Haggle told ${name} not to hold the booking. Nothing was paid through Haggle; don't pay them.`
        : `nothing was cancelled: ${clip(r.note ?? "the deal can't be cancelled now", 160)}`);
      return { jobId: job.id, outcome: r.state === "cancelled" ? "cancelled" : "cancel_refused" };
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      await this.notifyHuman(job, `cancel-ack:${m.messageId}`, `nothing was cancelled: ${clip(err.message, 120)}`);
      return { jobId: job.id, outcome: "cancel_refused" };
    }
  }

  /** The deal still has a negotiation round to spend: its current round < max_rounds (never past MAX_ROUND). */
  private hasRoundLeft(job: JobRow): boolean {
    return job.round < Math.min(job.max_rounds, MAX_ROUND);
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
  static callBrief(name: string, job: Pick<JobRow, "request" | "short_code">, reqs: string[], opts: { escalation?: boolean; competingTotalUsd?: number; competingApproximate?: boolean; followUpOnQuoteUsd?: number; followUpApproximate?: boolean; customer?: string } = {}): string {
    const r = job.request;
    const when = r.date ? eventWhen(r.date, r.time, r.date_until) : null;
    const qty = quantityText(r.quantity, r.unit);
    const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const customer = opts.customer ?? customerOf(r);
    return [
      // Live-demo's persona (the customer's AI assistant, never "Haggle") with main's content: the
      // follow-up opener, units, venue, flexible dates, approximate competing figures; and the read-back step.
      `You are an AI assistant phoning ${name} on behalf of ${customer} to get a price quote. You have no name or company of your own: introduce yourself only as their AI assistant. Be brief, warm and natural; keep the call under three minutes.`,
      opts.followUpOnQuoteUsd !== undefined
        ? `1. Open with: "Hi, I'm the AI assistant who called earlier for ${customer} about ${r.what}. Thanks again for your ${opts.followUpApproximate ? `estimate of about ${money(opts.followUpOnQuoteUsd)}` : `quote of ${money(opts.followUpOnQuoteUsd)}`}. Do you have a minute?"`
        : `1. Open with: "Hi, I'm an AI assistant calling on behalf of ${customer} about a quote for ${r.what}. Do you have a minute?"${opts.escalation ? " Mention we emailed earlier and wanted to follow up by phone." : ""}`,
      `2. The order: ${r.what}${qty ? ` for ${qty}` : ""}${when ? ` on ${when}` : ""}${r.area ? `, at ${eventPlace(r.area, r.venue)}` : ""}.${r.date_until ? " The customer is flexible on the day: ask which of those days they can do." : ""}${reqs.length ? ` Must have: ${reqs.join("; ")}.` : ""}`,
      `3. Ask for: the all-in total including delivery and tax, how each requirement is met${r.requirements.some((q) => q.kind === "dietary") ? " (for example how many vegetarian meals)" : ""}, any deposit and when it is due, and what is included.`,
      opts.competingTotalUsd !== undefined
        ? opts.competingApproximate
          ? `4. Another business estimated about ${money(opts.competingTotalUsd)} total for the same order (not yet a firm quote). You may say exactly that, as an estimate, and ask if they can do better. Never call it a firm quote, invent, round down or exaggerate it.`
          : `4. We have a real quote of ${money(opts.competingTotalUsd)} total for the same order. You may say that figure and ask if they can do better. Never invent, round down or exaggerate it.`
        : `4. Do not mention other businesses or prices.`,
      `5. If they give parts (a price per person, a delivery fee, tax as a percent), work out the all-in total yourself.${reqs.length ? " If they haven't said how each must-have is met, ask once before the read-back." : ""} Before ending, read back every figure they gave plus that total${reqs.length ? ", and each must-have they confirmed" : ""}, in the form "Just to confirm: [price] per person for [count], [fee] delivery, [rate] tax, so [total] all in, with a [deposit] deposit${reqs.length ? ", and [each must-have]" : ""}. Is that right?" (their words only, never these placeholders). Wait for their yes or correction, then thank them and end the call. This one call should get everything: we don't want to call back.`,
      `If they ask something you don't know, say you'll pass it on to the customer; never guess. If they can't do it or decline, thank them and end politely. If you reach voicemail, leave one sentence asking for a quote by email and hang up.`,
      `Never agree to buy, book or pay, and never share payment details. Reference HG-${job.short_code}.`,
    ].join("\n").slice(0, 2000);
  }

  /**
   * The Voice AI brief for a call after first contact (a follow-up, an answer, a counteroffer, a
   * message, a confirmation) (≤ 2,000 chars): AI disclosure on behalf of the customer, what to say
   * or ask, and the safety rules. A counter cites only the real competing total it is given.
   */
  private taskBrief(job: JobRow, b: JobBusinessRow, purpose: "rfq" | "escalation" | "message" | "followup" | "confirmation" | "answer" | "counter", extra?: string, counter?: { theirCents: number; targetCents: number; basis?: "competing_quote" | "buyer_target"; approximate?: boolean }): string {
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
      : purpose === "counter" && counter && counter.basis === "buyer_target" ? `${b.name} quoted ${money(counter.theirCents)} total for ${what}. Thank them, then say the customer's budget target for this order is ${money(counter.targetCents)} total and ask whether there is anything they can do to get closer to it (for example on delivery or the deposit). That is the customer's own target, not another quote: never call it a quote, and never invent, round down or exaggerate it. If they can do better, get their updated all-in total and deposit and read them back to confirm. If not, thank them and end politely.`
      : purpose === "counter" && counter ? `${b.name} quoted ${money(counter.theirCents)} total for ${what}. Thank them, then say we've received another ${counter.approximate ? `estimate of about ${money(counter.targetCents)}` : `quote of ${money(counter.targetCents)}`} total for the same order and ask whether they can match or beat it. ${counter.approximate ? "That is another business's estimate, not yet a firm quote: say it as an estimate, never as a firm quote." : "That is a real quote: say exactly that figure."} Never invent, round down or exaggerate it, and never say who quoted it. If they can do better, get their updated all-in total and deposit and read them back to confirm. If not, thank them and end politely.`
      : purpose === "confirmation" ? `Tell ${b.name} the customer would like to go ahead with their quote for ${what}. ${extra ?? ""} Ask them to confirm.`
      : `Ask ${b.name} for a quote for: ${what}.${purpose === "escalation" ? " We emailed them earlier and didn't hear back." : ""} ${reqs.length ? `Requirements: ${reqs.join("; ")}. ` : ""}${(r.details ?? []).map((d) => `${d.label}: ${d.value}.`).join(" ")} Find out: ${find}.`;
    return [`You are an AI assistant calling ${b.name} on behalf of ${customer}${purpose === "rfq" || purpose === "escalation" ? " to request a price quote" : ""}.`, opener, body, rules].join(" ").replace(/\s+/g, " ").trim().slice(0, 2000);
  }

  /**
   * When a call to this number may be placed: never during another call to it, not within the
   * cooldown after the last one (either direction), and only inside call hours in the workspace's
   * timezone. Returns null when it may be placed now, else when to try again.
   */
  private async callBlockedUntil(job: JobRow, phone: string, kind?: MessageRow["kind"]): Promise<Date | null> {
    const now = this.now();
    const base = this.d.config.callCooldownMs ?? DEFAULT_CALL_COOLDOWN_MS;
    // A counteroffer call to a business that just quoted on a call waits less (never under the minimum gap).
    const cooldown = kind === "counter" && base > 0 ? Math.max(this.d.config.minCallGapMs ?? MIN_CALL_GAP_MS, Math.min(base, this.d.config.counterCallGapMs ?? DEFAULT_COUNTER_CALL_GAP_MS)) : base;
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
  /**
   * Every Voice AI call goes through here: at most one dial per idempotency key, ever. The attempt is
   * recorded before dialing; a definite "not placed" refusal is recorded after it. An attempt with
   * neither a recorded call nor a refusal (a crash after dialing, or an ambiguous provider error)
   * is never dialed again: a second ring to a business is worse than a missed call.
   */
  private async placeCallOnce(jobId: string, req: PhoneCallRequest): Promise<{ callId: string }> {
    await this.refuseSuppressed(req.toNumber);
    await this.claimSend(req.idempotencyKey, jobId, "call");
    try {
      const r = await this.d.phone!.placeCall(req);
      await this.repo.finishOutbox(req.idempotencyKey, "sent", r.callId, this.now().toISOString());
      return r;
    } catch (err) {
      const f = err instanceof ChannelSendError ? err : new ChannelSendError("provider_error", false, 0, (err as Error).message, true);
      // "unknown" can never be claimed again (outbox trigger); "not_sent" (a definite refusal) can.
      // An unknown outcome goes to operator review at once: only a person can find out if it rang.
      await this.outboxFailed(req.idempotencyKey, jobId, "call", f.ambiguous ? "unknown" : "not_sent", f);
      throw f;
    }
  }

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
    // The first call only collects a quote and never mentions other businesses or prices (decision 13).
    // Citing a competing price is a counter round (automatic) or a human-authorized callback (placeCallback).
    const reason = HaggleEngine.callBrief(b.name, job, reqs, { escalation: opts.escalation, customer: this.customer(job) });
    try {
      const { callId } = await this.placeCallOnce(job.id, { jobId: job.id, businessId: b.business_id, toNumber: b.phone, reason, idempotencyKey: key });
      await this.repo.insertMessage({
        job_id: job.id, business_id: b.business_id, approval_id: null, direction: "out", kind: "call", channel: "phone", provider_email_id: callId, idempotency_key: key,
        rfc_message_id: null, thread_id: null, from_address: job.inbox, to_address: b.phone, subject: null, body_text: reason, attachments: [], attachments_download_url: null,
        sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: 1, simulated: job.mode === "mock",
      });
      await this.repo.updateBusiness(job.id, b.business_id, { status: "ringing", next_attempt_at: null, ...(opts.escalation ? { escalated_at: this.now().toISOString() } : { contacted_at: this.now().toISOString() }) });
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Calling ${b.name} (Voice AI${opts.escalation ? ", email unanswered" : ""})`, channel: "phone" });
    } catch (err) {
      if (err instanceof LeaseLostError) return; // another instance owns the job now
      const f = err instanceof ChannelSendError ? err : null;
      if (f?.ambiguous) {
        // It may be ringing: treat the business as contacted (its call.ended still lands by number), never redial.
        await this.repo.updateBusiness(job.id, b.business_id, { next_attempt_at: null, ...(opts.escalation ? { escalated_at: this.now().toISOString() } : { status: "contacted" as const, contacted_at: this.now().toISOString() }) });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Call to ${b.name}: outcome unknown (the provider failed after dialing may have started); not redialed` });
        this.log("call_outcome_unknown", { job_id: job.id, business_id: b.business_id, error: f.message });
        return;
      }
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
    // A first contact that never happened (the process died part-way through sending the RFQs) is
    // made once the job has sat still for STUCK_AFTER_MS; idempotency keys keep anything already sent from going twice.
    const stalled = job.state === "contacting" && now - Date.parse(job.updated_at) >= STUCK_AFTER_MS;
    for (const b of await this.repo.getBusinesses(job.id)) {
      if (b.status !== "pending") continue;
      if (b.next_attempt_at ? Date.parse(b.next_attempt_at) <= now : stalled) await this.contactBusiness(job, b);
    }
    await this.sendDueReminders(job);
  }

  /** A job the process died on before it started (`created`, never committed to contacting): start it now. */
  private async recoverCreated(job: JobRow) {
    if (job.state !== "created" || this.now().getTime() - Date.parse(job.created_at) < STUCK_AFTER_MS) return;
    const started = start(this.machine(job));
    if (!started.ok) return;
    await this.repo.appendEvent(job.id, "recovered", { from: "created" });
    await this.commit(job, started.next, started.effects, "recovered");
  }

  /**
   * One call-ended result (Inkbox `call.ended`, or the simulated fleet). Matched by the call id we
   * recorded when placing the call, so only calls Haggle placed to the pinned number count. The
   * transcript is untrusted data, parsed like an email body. Idempotent per call id.
   */
  async ingestCall(call: { callId: string; outcome: "completed" | "no_answer" | "declined" | "failed"; transcript: string; endedAt?: string; simulated?: boolean; direction?: "outbound" | "inbound"; remoteNumber?: string }): Promise<{ jobId: string | null; outcome: string }> {
    let placed = await this.repo.findMessageByProviderId(call.callId);
    if (!placed && call.direction === "inbound" && call.remoteNumber) return this.ingestInboundCall({ ...call, remoteNumber: call.remoteNumber });
    // A crash after dialing, before the call was recorded: rebuilt from its outbox claim (never lost).
    placed ??= await this.recoverPlacedCall(call);
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
    // No text to the human for a finished or unanswered call: the board shows it (they're texted when they must act).
    await this.repo.touchJob(job.id);
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
    if (hits.length > 1) {
      // The number is on several deals (possibly several workspaces): kept for audit with no deal, never
      // read into one; each deal only learns that a call from that business is held (nothing of what was said).
      const stored = await this.repo.insertMessage({
        job_id: null, business_id: null, approval_id: null, direction: "in", kind: "quarantine", channel: "phone", provider_email_id: `call-ended:${call.callId}`, idempotency_key: null,
        rfc_message_id: null, thread_id: null, from_address: num, to_address: null, subject: null, body_text: call.transcript.trim().slice(0, 20_000) || null, attachments: [], attachments_download_url: null,
        sender_trusted: false, trust_reason: "caller-number-on-several-deals", matched_via: null, parse_status: "none", quarantine_reason: "ambiguous_caller", round: null, simulated: call.simulated ?? false,
      });
      if (!stored) return { jobId: null, outcome: "duplicate" };
      for (const { job, b } of hits) await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, kind: "call_held", summary: `${b.name} called Haggle, but its number is on more than one deal, so the call wasn't read into this one. Ask ${b.name} to reply in writing with HG-${job.short_code}.` });
      return { jobId: null, outcome: "ambiguous_caller" };
    }
    if (hits.length !== 1) return { jobId: null, outcome: "unknown_caller" };
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



  /** The strategist's choice among the truthful plan (validated), or the plan as-is. */
  private async strategize(job: JobRow, plan: PlannedCounter[], businesses: JobBusinessRow[], quotes: QuoteRow[]) {
    const names = businesses.map((b) => b.name);
    if (!this.d.strategist || plan.length === 0) return { ...applyStrategy(plan, null, names), by: "rules" as const };
    const byId = new Map(businesses.map((b) => [b.business_id, b]));
    const ctx: StrategyContext = {
      what: job.request.what, ...(job.request.quantity !== undefined ? { quantity: job.request.quantity } : {}), targetUsd: job.budget_cents === null ? null : centsToUsd(job.budget_cents), hardLimit: job.request.budget_kind === "limit",
      quotes: quotes.filter((q) => q.status === "current" && q.total_cents !== null && q.sender_trusted).map((q) => ({
        business_id: q.business_id, business: byId.get(q.business_id)?.name ?? q.business_id, total_usd: centsToUsd(q.total_cents!), deposit_usd: q.deposit_cents === null ? null : centsToUsd(q.deposit_cents),
        round: q.round, channel: byId.get(q.business_id)?.channel ?? "email", notes: [...q.record.flags, ...q.requirement_results.filter((r) => r.met !== true).map((r) => `requirement ${r.requirement_id}: ${r.met === false ? "not met" : "unconfirmed"}`)],
      })),
    };
    try {
      const decision = await this.d.strategist.decide(plan, ctx);
      const applied = applyStrategy(plan, decision, names);
      if (applied.rejectedAsks.length) this.log("strategy_ask_rejected", { job_id: job.id, rejected: applied.rejectedAsks });
      return { ...applied, by: "llm" as const };
    } catch (err) {
      this.log("strategy_failed", { job_id: job.id, error: (err as Error).message });
      return { ...applyStrategy(plan, null, names), by: "rules" as const };
    }
  }

  private async sendCounteroffers(job: JobRow, round: number, businessIds?: string[]) {
    const { rankable, quotes } = await this.rankRows(job);
    const businesses = await this.repo.getBusinesses(job.id);
    const byId = new Map(businesses.map((b) => [b.business_id, b]));
    // A manual round (negotiate tool) may target some businesses; it never goes past MAX_ROUND (2).
    const manual = businessIds?.length || round > job.max_rounds ? { businessIds } : undefined;
    const plan = this.counterPlan(job, rankable, businesses, quotes, manual);
    const { moves, skipped, by } = await this.strategize(job, plan, businesses, quotes);
    for (const k of skipped) await this.repo.appendEvent(job.id, "reply", { business_id: k.business_id, summary: `No counter to ${byId.get(k.business_id)?.name ?? "this business"} this round: ${k.reason}` });
    let sent = 0;
    for (const c of moves) {
      const b = byId.get(c.businessId);
      if (!b) continue;
      // Asked not to be contacted (even unverified, even if an earlier quote of its was read afterwards): never countered (S5-D F10).
      if (await this.optedOut(job, b)) {
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `No counter to ${b.name}: it asked not to be contacted` });
        continue;
      }
      const counter = { haggle: "counter/1", protocol: "haggle.v0", type: "counter", job_id: job.id, round: c.round, target_total_usd: centsToUsd(c.targetTotalCents), basis: c.basis, ...(c.basis === "competing_quote" ? { basis_quote_total_usd: centsToUsd(c.targetTotalCents), ...(c.basisApproximate ? { basis_is_estimate: true } : {}) } : { buyer_target_usd: centsToUsd(c.targetTotalCents) }), respond_by: job.collect_until };
      const why = `${c.basis === "competing_quote" ? (c.basisApproximate ? `match about ${centsToUsd(c.targetTotalCents)} (another business's estimate ${c.basisQuoteId}, not yet firm)` : `match ${centsToUsd(c.targetTotalCents)} (real quote ${c.basisQuoteId})`) : `get closer to the buyer's $${centsToUsd(c.targetTotalCents)} target`} · ${c.strategy.reason}`;
      if (b.channel === "imessage") {
        const key = sendKeys.counter(job.id, b.business_id, c.round);
        if (await this.repo.findMessageByIdempotencyKey(key)) continue;
        try {
          // The strategist/planner's truthful short text (a match ask, the buyer's target, "about $X"),
          // said by the customer's AI assistant (never "Haggle").
          const textSent = await this.sendIMessageToBusiness(job, b, "counter", key, `Thanks! AI assistant for ${this.customer(job)} again. ${c.shortText.replace(/^Thanks!\s*/, "")} Ref HG-${job.short_code}`, c.round);
          if (!textSent) {
            // Never counted as countered: the round doesn't wait for an answer to a text that never went out.
            await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer text to ${b.name} not sent (no text channel or number)`, channel: "imessage" });
            continue;
          }
          await this.repo.updateBusiness(job.id, b.business_id, { countered_round: c.round });
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer to ${b.name} by text: ${why}`, basis_quote_id: c.basisQuoteId });
          await this.repo.appendEvent(job.id, "counteroffer", { business_id: b.business_id, round: c.round, target_total_usd: centsToUsd(c.targetTotalCents), basis_quote_id: c.basisQuoteId, basis: c.basis, ...(c.basisApproximate ? { basis_approximate: true } : {}), strategy: c.strategy });
          sent++;
        } catch (err) {
          this.log("counter_failed", { job_id: job.id, business_id: b.business_id, channel: "imessage", error: (err as Error).message });
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer text to ${b.name} failed: ${clip((err as Error).message, 120)}`, channel: "imessage" });
        }
        continue;
      }
      if (b.channel === "a2a") {
        const key = sendKeys.counter(job.id, b.business_id, c.round);
        if (await this.repo.findMessageByIdempotencyKey(key)) continue;
        try {
          // A new task in the same A2A context (the seller keeps its conversation state per context).
          const t = await this.a2aSend(job.id, key, { cardUrl: b.a2a_card_url!, text: c.text, data: counter, messageId: `haggle-${key.replace(/:/g, "-")}`, contextId: b.thread_id! });
          await this.recordA2aOutbound(job, b, "counter", key, t.taskId, c.text, c.round);
          await this.repo.updateBusiness(job.id, b.business_id, { countered_round: c.round });
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer to ${b.name} over A2A: ${why}`, basis_quote_id: c.basisQuoteId });
          await this.repo.appendEvent(job.id, "counteroffer", { business_id: b.business_id, round: c.round, target_total_usd: counter.target_total_usd, basis_quote_id: c.basisQuoteId, basis: c.basis, ...(c.basisApproximate ? { basis_approximate: true } : {}), strategy: c.strategy });
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
        const call = {
          key, kind: "counter" as const, round: c.round,
          body: c.basis === "buyer_target" ? `Counteroffer call: the customer's target is ${usdText(c.targetTotalCents)} total; can you get closer?`
            : `Counteroffer call: we have another ${c.basisApproximate ? "estimate of about" : "quote of"} ${usdText(c.targetTotalCents)} total; can you match or beat it?`,
          reason: this.taskBrief(job, b, "counter", undefined, { theirCents: c.theirTotalCents, targetCents: c.targetTotalCents, basis: c.basis, approximate: c.basisApproximate }),
        };
        let r: { placed: MessageRow | null; scheduledFor?: string };
        try {
          r = await this.callBusiness(job, b, call);
        } catch (err) {
          // Not dropped: e.g. 503 hosted_agent_at_capacity. Retried by dueScheduledCalls in a minute
          // (a few times, while the round is open), and shown on the board.
          const at = new Date(this.now().getTime() + CALL_RETRY_MS).toISOString();
          this.log("counter_failed", { job_id: job.id, business_id: b.business_id, channel: "phone", error: (err as Error).message });
          await this.repo.appendEvent(job.id, "call_failed", { business_id: b.business_id, key, error: clip((err as Error).message, 160), failed_at: this.now().toISOString() });
          await this.repo.appendEvent(job.id, "call_scheduled", { business_id: b.business_id, ...call, approval_id: null, at });
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer call to ${b.name} couldn't be placed (${clip((err as Error).message, 100)}); retrying at ${at}`, channel: "phone" });
          r = { placed: null, scheduledFor: at };
        }
        if (!r.placed && !r.scheduledFor) {
          await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer call to ${b.name} not placed (calls are off or it has no number)`, channel: "phone" });
          continue;
        }
        await this.repo.updateBusiness(job.id, b.business_id, { countered_round: c.round });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer to ${b.name} by call${r.placed ? "" : ` (scheduled for ${r.scheduledFor})`}: ${why}`, basis_quote_id: c.basisQuoteId, channel: "phone" });
        await this.repo.appendEvent(job.id, "counteroffer", { business_id: b.business_id, round: c.round, target_total_usd: counter.target_total_usd, basis_quote_id: c.basisQuoteId, basis: c.basis, ...(c.basisApproximate ? { basis_approximate: true } : {}), strategy: c.strategy, channel: "phone" });
        sent++;
        continue;
      }
      try {
        await this.sendRecorded(job, b, "counter", sendKeys.counter(job.id, b.business_id, c.round), {
          to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, bodyText: `${c.text}\nAI assistant for ${this.customer(job)}`, attachments: [jsonPart("counter.json", counter)], inThread: true, round: c.round,
        });
        await this.repo.updateBusiness(job.id, b.business_id, { countered_round: c.round });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Counteroffer to ${b.name}: ${why}`, basis_quote_id: c.basisQuoteId });
        await this.repo.appendEvent(job.id, "counteroffer", { business_id: b.business_id, round: c.round, target_total_usd: counter.target_total_usd, basis_quote_id: c.basisQuoteId, basis: c.basis, ...(c.basisApproximate ? { basis_approximate: true } : {}), strategy: c.strategy });
        sent++;
      } catch (err) {
        this.log("counter_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
      }
    }
    // Say on the board who isn't countered and why: the business with the best price is the figure
    // cited to the others, so it gets no counteroffer (no call back, no text), but only when that is
    // true (the planner may also ask it to get closer to the buyer's target).
    const cited = plan.find((p) => p.basis === "competing_quote");
    const basisId = cited ? rankable.find((r) => r.quoteId === cited.basisQuoteId)?.businessId : undefined;
    const basis = basisId && !moves.some((m) => m.businessId === basisId) ? byId.get(basisId) : undefined;
    if (basis && cited) {
      await this.repo.appendEvent(job.id, "reply", {
        business_id: basis.business_id, channel: basis.channel, kind: "counter_basis",
        summary: `${basis.name} has the best price (${usdText(cited.targetTotalCents)}): it's the real quote cited to the others, so it isn't countered`,
      });
    }
    await this.repo.appendEvent(job.id, "counteroffers_sent", { round, sent, planned: plan.length, skipped: skipped.length, strategy: by, ...(basisId ? { basis_business_id: basisId } : {}) });
  }

  private async sendAccept(job: JobRow) {
    const approval = await this.repo.getLatestApproval(job.id);
    if (!approval || approval.status !== "approved") return;
    if (this.d.config.manualPaymentHandoff) {
      // The business confirms the booking first; the payment handoff starts only after that.
      await this.startBooking(job, approval);
      return;
    }
    // Stripe rail: nothing is sent to the business and nothing is charged until the agent calls pay().
    if (this.d.stripe) return;
    const quote = await this.repo.getQuote(approval.quote_id);
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === approval.business_id);
    if (!quote || !b) return;
    if (this.d.payer.disabledReason) {
      // No payment rail on this server: record it once; no payment row (the approval stays usable once
      // payments are enabled), never ask the seller for an invoice we can't pay.
      const said = (await this.repo.listEvents(job.id)).some((e) => e.type === "payment" && e.data.reason === this.d.payer.disabledReason && e.data.approval_id === approval.id);
      if (!said) await this.repo.appendEvent(job.id, "payment", { status: "failed", reason: this.d.payer.disabledReason, approval_id: approval.id });
      return;
    }
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
    // Manual handoff: Haggle never knows money arrived; it says only what the human told it.
    const handoff = this.d.config.manualPaymentHandoff ? await this.repo.getHandoffByApproval(a.id) : null;
    const reported = handoff?.status === "human_confirmed";
    // Manual rail, confirm-only: the business already confirmed in writing; this only closes the loop.
    const confirmedOrder = this.d.config.manualPaymentHandoff && a.action === "confirm" && (await this.repo.getBookingByApproval(a.id))?.status === "confirmed";
    const payLine = confirmedOrder ? "Thanks for confirming: the order is set. The customer arranges payment with you directly; Haggle never takes or sends money." : reported ? `The customer has told us they have paid the ${money(handoff!.amount_cents)} directly to you. Haggle doesn't handle the money, so please check you received it and reply to confirm once it arrives.`
      : paid ? `A payment of ${money(paid.amount_cents)} has been sent${paid.rail === "stripe" ? " (Stripe test mode)" : ""}${ref ? `, reference ${ref}` : ""}.` : "";
    // Every approval goes ahead with the order: confirm-only, or approved and then paid (decisions 2, 3).
    const confirm = true;
    const what = [job.request.what, quantityText(job.request.quantity, job.request.unit), job.request.date ? `on ${job.request.date}` : null].filter(Boolean).join(", ");
    const text = [
      `Hi ${b.name},`, "",
      ...(confirm ? [`We'd like to go ahead with your quote${a.quote_total_cents ? ` of ${money(a.quote_total_cents)} total` : ""} for ${what}.`] : []),
      ...(payLine ? [payLine] : []),
      // Under the manual handoff the booking was already confirmed; the question now is the money.
      ...(confirm && !reported && !confirmedOrder ? ["Please reply to confirm the booking."] : []),
      "", this.signOff(job),
    ].join("\n");
    const key = `confirm:${a.id}`;
    try {
      if (b.channel === "a2a" && this.d.a2a && b.a2a_card_url && b.thread_id) {
        if (!(await this.repo.findMessageByIdempotencyKey(key))) {
          const t = await this.a2aSend(job.id, key, { cardUrl: b.a2a_card_url, text, data: { haggle: "confirm/1", protocol: "haggle.v0", type: "confirmation", job_id: job.id, quote_total_usd: centsToUsd(a.quote_total_cents), ...(paid ? { paid_usd: centsToUsd(paid.amount_cents), payment_reference: ref } : {}) }, messageId: `haggle-${key.replace(/:/g, "-")}`, contextId: b.thread_id });
          await this.recordA2aOutbound(job, b, "confirmation", key, t.taskId, text, job.round);
        }
      } else if (b.channel === "email" && b.email) {
        await this.sendRecorded(job, b, "confirmation", key, { to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, bodyText: text, inThread: true });
      } else if (b.channel === "imessage" && this.canReach(b)) {
        // A text business is confirmed by text (never switched to email).
        const sms = [confirm ? `Hi ${b.name}, the customer would like to go ahead with your quote${a.quote_total_cents ? ` of ${money(a.quote_total_cents)} total` : ""} for ${what}.` : `Hi ${b.name},`, payLine, confirm && !confirmedOrder && !reported ? "Please reply to confirm." : "", `Ref HG-${job.short_code}`].filter(Boolean).join(" ");
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
        to: approver, subject: `[HG-${job.short_code}] Done: ${paid ? "paid" : reported ? "you reported paying" : "confirmed"} ${b.name}`,
        bodyText: [`Your agent finished this deal.`, "", `- Business: ${b.name}`, `- Quote total: ${money(a.quote_total_cents)}`, ...(paid ? [`- Paid: ${money(paid.amount_cents)}${ref ? ` (reference ${ref})` : ""}`] : []),
          ...(reported ? [`- You reported paying ${money(handoff!.amount_cents)} directly (Haggle didn't move or verify the money; the business was asked to confirm receipt)`] : []), `- Action: ${a.action === "confirm" ? "confirm (nothing paid)" : "pay"}`].join("\n"),
        approvalId: a.id,
      });
    } catch (err) {
      this.log("receipt_failed", { job_id: job.id, error: (err as Error).message });
    }
  }

  private async notifyCancelled(job: JobRow) {
    const pending = await this.repo.getLatestApproval(job.id);
    if (pending?.status === "pending") await this.repo.transitionApproval(pending.id, "pending", { status: "expired", decided_at: this.now().toISOString() });
    // Cancelled after the human approved, before any payment: the accepted business hears exactly that
    // (no payment was made or reported), and the booking and handoff are closed.
    // Manual rail: a confirm-only order awaiting the vendor's yes is a booking too (it is told not to hold it).
    const acceptedRow = pending && pending.status === "approved" && (pending.action !== "confirm" || this.d.config.manualPaymentHandoff === true) ? pending : null;
    // A charge already started (Stripe `charging`) can't be described as "no payment": flagged instead.
    const pay = acceptedRow ? await this.repo.getPaymentForJob(job.id) : null;
    const moving = !!pay && pay.approval_id === acceptedRow?.id && ["charging", "signed", "sent", "settled"].includes(pay.status);
    if (moving) {
      await this.repo.appendEvent(job.id, "operator_attention", { reason: "cancelled_while_payment_moving", approval_id: acceptedRow!.id, payment_status: pay!.status });
      this.log("operator_attention", { job_id: job.id, reason: "cancelled_while_payment_moving" });
    }
    const accepted = moving ? null : acceptedRow;
    if (accepted) {
      await this.repo.transitionApproval(accepted.id, "approved", { status: "expired", decided_at: this.now().toISOString() });
      const bk = await this.repo.getBookingByApproval(accepted.id);
      if (bk) await this.repo.updateBooking(bk.id, ["awaiting_vendor_confirmation", "confirmed", "not_in_writing"], { status: "cancelled", cancel_reason: "cancelled by the customer before paying" });
      const h = await this.repo.getHandoffByApproval(accepted.id);
      if (h) await this.repo.updateHandoff(h.id, ["instructions_requested", "instructions_received"], { status: "cancelled" });
      await this.repo.appendEvent(job.id, "booking", { status: "cancelled", approval_id: accepted.id, at: this.now().toISOString() });
    }
    // A short note on the business's own channel to businesses that replied: in the email thread, or
    // by text. Nobody is phoned just to hear a request was cancelled.
    for (const b of await this.repo.getBusinesses(job.id)) {
      if (!["replied", "quoted", "question", "declined"].includes(b.status)) continue;
      const won = accepted?.business_id === b.business_id;
      const note = won
        ? `The customer has cancelled this order before paying, so please don't hold the booking for ${job.request.what}. No payment was made or sent through Haggle. Sorry for the trouble, and thank you.`
        : "Thank you for your quote. The customer has cancelled this request, so we won't be moving forward. Thanks for your time.";
      try {
        if (b.channel === "email" && b.last_inbound_message_id) {
          await this.sendRecorded(job, b, "cancel", sendKeys.cancel(job.id, b.business_id), {
            to: b.email, subject: `[HG-${job.short_code}] Quote request: ${job.request.what}`, inThread: true,
            bodyText: `Hi ${b.name},\n\n${note}\n\n${this.signOff(job)}`,
          });
        } else if (b.channel === "imessage" && b.last_reply_at && this.canReach(b)) {
          await this.sendIMessageToBusiness(job, b, "cancel", sendKeys.cancel(job.id, b.business_id), won ? `The customer cancelled this order before paying; please don't hold the booking. No payment was made. Ref HG-${job.short_code}` : `Thanks for your quote. The customer has cancelled this request, so we won't be moving forward. Ref HG-${job.short_code}`, null);
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
    const bounce = parseBounce(msg);
    // A bounce-looking message from a business's own address in its thread is that business writing, not a DSN.
    if (bounce && (isDsnSender(msg.from) || !(await this.fromPinnedBusiness(msg)))) return this.ingestBounce(msg, bounce);
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
      const q = await this.repo.insertMessage({ ...base, job_id: jobId, business_id: match.kind === "quarantine" ? match.businessId : null, kind: "quarantine", sender_trusted: false, trust_reason: null, matched_via: match.kind === "quarantine" ? match.via : null, parse_status: "none", quarantine_reason: reason });
      if (!q) return { jobId, outcome: "duplicate" }; // a webhook replay or the sweep: one flag per message
      const why = explainQuarantine(reason);
      if (jobId) await this.repo.appendEvent(jobId, "flag", { business_id: match.kind === "quarantine" ? match.businessId : "", flag: "unverified_sender", summary: `A message in a business thread was quarantined, not read: ${why.explanation} ${why.action}`, ...quarantineEventData(why, q.id) });
      this.log("inbound_quarantined", { reason, job_id: jobId, explanation: why.explanation });
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
    let trust = trustFor(b.email!);
    if (!trust.trusted && trust.retryable) throw new RetryLater("sender authentication temporarily unavailable");
    // Mail from outside Inkbox: a From address and a thread are never proof (inbound/senderAuth.ts).
    const external = !trust.trusted && this.d.config.externalSenders === "reply_token" ? await this.verifyExternal(b, msg, trust) : null;
    // An opt-out from the business's own address is honoured on this job even before its identity is
    // proven (never contacting someone who may have asked us to stop is the safe side), but only a
    // verified one suppresses the address everywhere: an unverified STOP may be a competitor's spoof.
    if (isOptOut(msg.bodyText) && normalizeAddress(msg.from) === normalizeAddress(b.email!)) {
      const verified = trust.trusted || external?.ok === true;
      const stored = await this.repo.insertMessage({ ...base, job_id: b.job_id, business_id: b.business_id, kind: "reply", sender_trusted: verified, trust_reason: trust.trusted ? trust.reason : external?.ok ? external.reason : trust.reason, matched_via: match.via, parse_status: "none", quarantine_reason: null });
      if (!stored) return { jobId: b.job_id, outcome: "duplicate" };
      if (verified) await this.optOut(b.job_id, b, b.email!, (msg.bodyText ?? "").slice(0, 200));
      else await this.optOutThisJob(b.job_id, b, (msg.bodyText ?? "").slice(0, 200));
      return { jobId: b.job_id, outcome: "opted_out" };
    }
    if (external) {
      const v = external;
      if (!v.ok) {
        const q = await this.repo.insertMessage({ ...base, job_id: b.job_id, business_id: b.business_id, kind: "quarantine", sender_trusted: false, trust_reason: trust.reason, matched_via: match.via, parse_status: "none", quarantine_reason: `${v.reason}:${v.detail}` });
        if (!q) return { jobId: b.job_id, outcome: "duplicate" };
        const why = explainQuarantine(`${v.reason}:${v.detail}`);
        await this.repo.appendEvent(b.job_id, "flag", { business_id: b.business_id, flag: "unverified_sender", summary: `An email claiming to be ${b.name} couldn't be verified (${v.detail.replace(/_/g, " ")}); it was quarantined, not read. ${why.action}`, ...quarantineEventData(why, q.id) });
        this.log("inbound_quarantined", { reason: v.reason, detail: v.detail, job_id: b.job_id });
        return { jobId: b.job_id, outcome: `quarantined:${v.reason}` };
      }
      trust = { trusted: true, address: normalizeAddress(b.email!), reason: v.reason, evidence: trust.evidence };
    }
    // The business answering something Haggle asked about a purchase: a re-confirmation, the booking,
    // payment instructions or a receipt (workstream D: ingestPurchaseReply).
    if (trust.trusted) {
      const handled = await this.ingestPurchaseReply(b, msg, base, match.via, trust.reason);
      if (handled) return handled;
    }
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

  /**
   * A delivery failure report. It counts for a business only when it quotes one of Haggle's own
   * outbound Message-IDs to that business (a forged bounce can't name one); a hard (5.x.x) bounce
   * suppresses the address and marks the business bounced. Never read as a reply.
   */
  private async ingestBounce(msg: InboundMessage, bounce: NonNullable<ReturnType<typeof parseBounce>>): Promise<{ jobId: string | null; outcome: string }> {
    const ids = new Set(bounce.messageIds.map(normalizeMessageId));
    const cands = ids.size ? await this.repo.findBusinessCandidates({ shortCodes: [], threadId: null, messageIds: bounce.messageIds }) : [];
    let hit: (typeof cands)[number] | null = null;
    for (const c of cands) {
      const ours = (await this.repo.listMessages(c.job_id)).filter((m) => m.direction === "out" && m.business_id === c.business_id && m.channel === "email").map((m) => m.rfc_message_id);
      if ([c.rfq_message_id, ...ours].some((x) => x && ids.has(normalizeMessageId(x)))) { hit = c; break; }
    }
    const stored = await this.repo.insertMessage({
      job_id: hit?.job_id ?? null, business_id: hit?.business_id ?? null, approval_id: null, direction: "in", kind: "quarantine", provider_email_id: msg.providerEmailId, idempotency_key: null,
      rfc_message_id: msg.messageId, thread_id: msg.threadId, from_address: msg.from, to_address: msg.to[0] ?? null, subject: msg.subject, body_text: msg.bodyText, attachments: [], attachments_download_url: null,
      sender_trusted: false, trust_reason: null, matched_via: hit ? "message_id" : null, parse_status: "none", quarantine_reason: hit ? (bounce.hard ? "bounce" : "bounce_soft") : "bounce_unmatched", round: null, simulated: false,
    });
    if (!stored) return { jobId: hit?.job_id ?? null, outcome: "duplicate" };
    if (!hit || !hit.email) return { jobId: null, outcome: "bounce_ignored" };
    if (!bounce.hard) {
      await this.repo.appendEvent(hit.job_id, "reply", { business_id: hit.business_id, summary: `Temporary delivery problem to ${hit.name}; the provider retries` });
      return { jobId: hit.job_id, outcome: "bounce_soft" };
    }
    await this.repo.addSuppression({ contact: normalizeAddress(hit.email), reason: "bounce", job_id: hit.job_id, evidence: bounce.text.slice(0, 300) });
    await this.repo.updateBusiness(hit.job_id, hit.business_id, { status: "bounced", next_attempt_at: null });
    await this.repo.appendEvent(hit.job_id, "reply", { business_id: hit.business_id, summary: `Email to ${hit.name} bounced (address doesn't exist); it won't be emailed again` });
    await this.repo.touchJob(hit.job_id);
    return { jobId: hit.job_id, outcome: "bounced" };
  }

  /** Inkbox message.bounced / message.failed (or the reconciler's outbound status sweep) for one of our own emails. See inbound/deliveryStatus.ts. */
  ingestDeliveryStatus(s: DeliveryStatusInput): Promise<{ jobId: string | null; outcome: string }> {
    return applyDeliveryStatus(this.repo, { ...s, at: s.at ?? this.now() }, (event, data) => this.log(event, data));
  }

  /**
   * Where Haggle stands with each business on this deal (inbound/contactStatus.ts): bounced, failed,
   * opted out, a held (quarantined) reply, replied, awaiting a reply, scheduled. The deal board's
   * fixed `status` enum can't say all of this; `line` is meant for its `last_event`.
   */
  async contactStatuses(jobId: string): Promise<BusinessContactStatus[]> {
    const [businesses, messages, events] = await Promise.all([this.repo.getBusinesses(jobId), this.repo.listMessages(jobId), this.repo.listEvents(jobId)]);
    const contacts = businesses.flatMap((b) => [b.email ? normalizeAddress(b.email) : null, b.phone].filter((c): c is string => !!c));
    const suppressions = contacts.length ? await this.repo.findSuppressions(contacts) : [];
    return businesses.map((business) => contactStatusOf({ business, messages, suppressions, events }));
  }

  /** Held inbound email for operator review (inbound/quarantineReview.ts). */
  quarantined(q: { jobId?: string; limit?: number; includeResolved?: boolean } = {}) {
    return listQuarantine(this.repo, q);
  }

  /**
   * An operator releases a held email after verifying it with the business on an independent channel:
   * it is read as that business's reply (trust "operator_verified": a quote at most, never approval,
   * payment, a payee or a booking confirmation). Recorded append-only with the original reason.
   */
  async releaseQuarantined(i: { messageId: string; verifiedBy: string; how: string; jobId?: string; businessId?: string }) {
    const r = await releaseQuarantined(this.repo, { ...i, now: this.now() });
    if (r.ok) this.log("quarantine_released", { job_id: r.jobId, business_id: r.businessId, message_id: r.messageId, original_reason: r.resolution.original_reason });
    return r;
  }

  async rejectQuarantined(i: { messageId: string; by: string; why: string }) {
    const r = await rejectQuarantined(this.repo, i);
    if (r.ok) this.log("quarantine_rejected", { job_id: r.jobId, message_id: r.messageId });
    return r;
  }

  /** The reply-token check for mail from outside Inkbox (inbound/senderAuth.ts verifyExternalReply). */
  private async verifyExternal(b: JobBusinessRow, msg: InboundMessage, trust: TrustVerdict) {
    const ours = (await this.repo.listMessages(b.job_id)).filter((m) => m.direction === "out" && m.business_id === b.business_id).map((m) => m.rfc_message_id);
    return verifyExternalReply({
      from: msg.from ?? "", pinned: b.email!, inReplyTo: msg.inReplyTo, references: msg.references, ourMessageIds: [b.rfq_message_id, ...ours],
      subject: msg.subject, bodyText: msg.bodyText, token: replyToken(this.d.config.replyTokenSecret!, b.job_id, b.business_id), evidence: trust.evidence,
    });
  }

  /** Is this message from the pinned address of a business it threads to (by job code, thread or our Message-IDs)? */
  private async fromPinnedBusiness(msg: InboundMessage): Promise<boolean> {
    if (!msg.from) return false;
    const codes = [...new Set([...msg.to.map((a) => jobInboxCode(a, this.d.config.inboxDomain)), subjectShortCode(msg.subject)].filter((c): c is string => c !== null))];
    const rows = await this.repo.findBusinessCandidates({ shortCodes: codes, threadId: msg.threadId, messageIds: [...msg.inReplyTo, ...msg.references] });
    return rows.some((r) => r.email && normalizeAddress(r.email) === normalizeAddress(msg.from!));
  }

  /**
   * An opt-out Haggle couldn't verify came from the business (no provider authentication, no reply
   * token): this job stops contacting it, recorded as `opt_out_unverified`; no global suppression.
   */
  private async optOutThisJob(jobId: string, b: Pick<JobBusinessRow, "business_id" | "name">, evidence: string) {
    await this.repo.updateBusiness(jobId, b.business_id, { status: "declined", next_attempt_at: null });
    await this.repo.appendEvent(jobId, "reply", { business_id: b.business_id, opt_out: "opt_out_unverified", evidence, summary: `${b.name} appears to have asked not to be contacted (sender not verified); Haggle stops contacting them on this deal only` });
    await this.repo.touchJob(jobId);
  }

  /** The business asked not to be contacted: suppressed for every workspace and deal, and marked declined here. */
  private async optOut(jobId: string, b: Pick<JobBusinessRow, "business_id" | "name">, contact: string, evidence: string) {
    await this.repo.addSuppression({ contact: contact.toLowerCase(), reason: "opt_out", job_id: jobId, evidence });
    await this.repo.updateBusiness(jobId, b.business_id, { status: "declined", next_attempt_at: null });
    await this.repo.appendEvent(jobId, "reply", { business_id: b.business_id, summary: `${b.name} asked not to be contacted; Haggle won't contact them again` });
    await this.repo.touchJob(jobId);
  }

  /** Manual handoff: a trusted reply from the business Haggle asked for payment instructions. Recorded, never followed or parsed. */
  private async ingestPaymentInstructions(b: JobBusinessRow, msg: InboundMessage, base: Omit<NewMessage, "job_id" | "business_id" | "kind" | "sender_trusted" | "trust_reason" | "matched_via" | "parse_status" | "quarantine_reason">, via: MessageRow["matched_via"], trustReason: string): Promise<{ jobId: string; outcome: string } | null> {
    const job = await this.repo.getJob(b.job_id);
    if (!job || job.state !== "paying") return null;
    const a = await this.repo.getLatestApproval(job.id);
    const h = a ? await this.repo.getHandoffByApproval(a.id) : null;
    if (!a || !h || h.business_id !== b.business_id || !["instructions_requested", "instructions_received"].includes(h.status)) return null;
    const stored = await this.repo.insertMessage({ ...base, job_id: job.id, business_id: b.business_id, kind: "reply", sender_trusted: true, trust_reason: trustReason as never, matched_via: via, parse_status: "none", quarantine_reason: null });
    if (!stored) return { jobId: job.id, outcome: "duplicate" };
    const text = cleanEmailBody(msg.bodyText ?? "").slice(0, 4000);
    const same = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
    if (h.status === "instructions_received" && h.instructions_text && same(h.instructions_text) !== same(text)) {
      // Changed payee details after the human saw the first ones is the classic payment-redirect fraud:
      // the first instructions stay, the operator reviews, and the human confirms by phone (S5-D F12).
      await this.repo.appendEvent(job.id, "payment", { status: "instructions_changed", rail: "manual", business_id: b.business_id, message_id: stored.id, warning: "the business's payment instructions changed after the first ones: Haggle kept the first; confirm by phone on a number you already know before paying", ...(provesSenderIdentity({ sender_trusted: true, trust_reason: trustReason }) ? {} : { sender_identity: weakIdentity(trustReason) }) });
      await this.deadLetter({ kind: "payment", subject: `instructions_changed:${h.id}`, job_id: job.id, reason: "payment instructions changed after the human was told how to pay", attempts: 1 });
      await this.notifyHuman(job, `instructions-changed:${stored.id}`, `${clip(b.name, 30)} sent different payment instructions from the ones it gave before. Haggle kept the first ones. Don't pay until you confirm the details with them by phone on a number you already know; then reply PAID ${a.code}.`);
      await this.repo.touchJob(job.id);
      return { jobId: job.id, outcome: "payment_instructions_changed" };
    }
    await this.repo.updateHandoff(h.id, ["instructions_requested", "instructions_received"], { status: "instructions_received", instructions_text: text, instructions_message_id: stored.id });
    const link = /https?:\/\/|www\./i.test(text);
    // Thread continuity (the reply token) isn't sender identity: payment details from such a reply are a BEC risk (inbound/trustStrength.ts).
    const sms = TEXT_OR_CALLER_ID_REASONS.has(trustReason);
    const weak = CONTINUITY_ONLY_REASONS.has(trustReason) || sms;
    const warning = [link ? "contains a link: verify it with the business independently; Haggle never opens it" : null, sms ? SMS_PAYMENT_WARNING : weak ? CONTINUITY_ONLY_WARNING : null].filter(Boolean).join("; ");
    await this.repo.appendEvent(job.id, "payment", { status: "instructions_received", rail: "manual", business_id: b.business_id, ...(warning ? { warning } : {}), ...(weak ? { sender_identity: weakIdentity(trustReason) } : {}) });
    await this.notifyHuman(job, `instructions:${stored.id}`, `${clip(b.name, 30)} sent payment instructions (see the deal board${link ? "; it has a link, so check it with them before paying" : ""}${weak ? `; ${sms ? "a text" : "its email"} can't be fully verified, so confirm the details with them by phone` : ""}). Pay them directly; then reply PAID ${a.code}.`);
    return { jobId: job.id, outcome: "payment_instructions" };
  }

  // ───────────────────────────── advance ─────────────────────────────

  private readonly advancing = ADVANCING;

  /**
   * One advance per job at a time. The webhook, every wait_for_update and the backup tick all call
   * this; run concurrently, two of them parse the same reply (a slow LLM call) and store it twice:
   * duplicate questions, duplicate quotes. Callers queue behind the running advance instead. The
   * queue is per process, shared by every engine instance: a dev hot reload builds a new engine
   * while the old one's tick keeps running (live 2026-10-18, HG-2QAM: both parsed Harbor Table's
   * reply and the losing parse reset it to "replied"). Across processes storeExtraction is idempotent.
   */
  async advanceJob(jobId: string): Promise<void> {
    // Re-entrant: something this job's own advance awaits wants it advanced (a reply recovered by the
    // pre-close sweep that decides an approval). Queuing behind itself would deadlock; the running
    // advance carries on with the new state, and one more advance runs right after it.
    const inside = ADVANCE_CTX.getStore();
    if (inside?.has(jobId)) return this.advanceAfter(jobId);
    // In-process queue per instance; across processes (replicas, a restart overlap) the job lease.
    const slot = `${this.instanceId}:${jobId}`;
    const prev = this.advancing.get(slot) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => ADVANCE_CTX.run(new Set([...(inside ?? []), jobId]), () => this.advanceLeased(jobId))).then(() => this.noteAdvanced(jobId));
    this.advancing.set(slot, run);
    try {
      await run;
    } finally {
      if (this.advancing.get(slot) === run) this.advancing.delete(slot);
    }
  }

  private get instanceId(): string {
    return this.d.config.instanceId ?? PROCESS_INSTANCE;
  }

  /**
   * Advance under the job's lease (Postgres job_leases): another instance holding it is advancing
   * this job right now, so this one skips (its tick comes round again). A crashed holder's lease
   * expires after leaseTtlMs.
   */
  private async advanceLeased(jobId: string) {
    // One owner token per acquisition: a renewal or release only ever touches this advance's own lease.
    const owner = `${this.instanceId}#${++this.leaseSeq}`;
    const ttl = this.d.config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!(await this.repo.acquireJobLease(jobId, owner, this.now().toISOString(), ttl))) {
      this.log("advance_skipped_leased", { job_id: jobId });
      return;
    }
    // An advance may outlive its lease (slow LLM reads, many replies): renewed every third of the
    // TTL while it runs. Once a renewal fails another instance may own the job: every later send
    // is refused (fence) and the advance stops at its next step.
    const held = { owner, lost: false };
    this.leases.set(jobId, held);
    const beat = setInterval(() => {
      if (held.lost) return;
      void this.repo.renewJobLease(jobId, owner, this.now().toISOString(), ttl).then((ok) => { if (!ok) this.leaseLost(jobId, held); }, () => undefined);
    }, Math.max(1, Math.floor(ttl / 3)));
    beat.unref?.();
    try {
      await this.advanceJobOnce(jobId);
    } finally {
      clearInterval(beat);
      if (this.leases.get(jobId) === held) this.leases.delete(jobId);
      await this.repo.releaseJobLease(jobId, owner).catch((e) => this.log("lease_release_failed", { job_id: jobId, error: (e as Error).message }));
    }
  }

  private leaseSeq = 0;
  /** The lease each running advance in this engine holds, by job. */
  private readonly leases = new Map<string, { owner: string; lost: boolean }>();

  private leaseLost(jobId: string, held: { lost: boolean }) {
    if (held.lost) return;
    held.lost = true;
    this.log("lease_lost", { job_id: jobId });
  }

  /** True when this call chain is advancing the job under a lease it has since lost. */
  private fenced(jobId: string): boolean {
    return !!ADVANCE_CTX.getStore()?.has(jobId) && this.leases.get(jobId)?.lost === true;
  }

  /**
   * Before any send from inside an advance: still the lease holder? Renewed on the spot (a CAS on
   * the owner token, so it can't steal back a lease another instance took). Sends from outside an
   * advance (a tool call) aren't leased; the outbox claim alone keeps them single.
   */
  private async fence(jobId: string | null) {
    if (jobId && !(await this.stillLeased(jobId))) throw new LeaseLostError();
  }

  private async stillLeased(jobId: string): Promise<boolean> {
    if (!ADVANCE_CTX.getStore()?.has(jobId)) return true;
    const held = this.leases.get(jobId);
    if (!held) return true;
    // A renewal that times out or errors (the database stalled) can't prove the lease: fenced, never sent on a guess.
    if (!held.lost && (await this.repo.renewJobLease(jobId, held.owner, this.now().toISOString(), this.d.config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS).catch(() => false))) return true;
    this.leaseLost(jobId, held);
    return false;
  }

  /** When each job last finished an advance in this process, and its version then (advanceForRead). */
  private readonly advancedAt = new Map<string, { wall: number; at: number; version: number }>();

  private async noteAdvanced(jobId: string) {
    const job = await this.repo.getJob(jobId);
    if (job) this.advancedAt.set(jobId, { wall: Date.now(), at: this.now().getTime(), version: job.version });
    if (this.advancedAt.size > 500) this.advancedAt.delete(this.advancedAt.keys().next().value!);
  }

  /**
   * The advance a read runs first (get_quotes, each wait_for_update poll), skipped when this process
   * finished advancing the job under FRESH_ADVANCE_MS ago and nothing changed since: same job version
   * (every inbound message, decision and send bumps it), no reply waiting to be read, no advance
   * queued. Back-to-back reads (wait_for_update then get_quotes, a board polling) cost one advance,
   * not one each (each is dozens of database round trips in live mode).
   */
  private async advanceForRead(jobId: string): Promise<void> {
    const last = this.advancedAt.get(jobId);
    if (last && !this.advancing.has(jobId) && Date.now() - last.wall < FRESH_ADVANCE_MS && Math.abs(this.now().getTime() - last.at) < FRESH_ADVANCE_MS) {
      const [job, pending] = await Promise.all([this.repo.getJob(jobId), this.repo.getPendingMessages(jobId)]);
      if (job && job.version === last.version && pending.length === 0) return;
    }
    await this.advanceJob(jobId);
  }

  private readonly advanceFollowUps = new Set<string>();

  /** One more advance of this job once the running one finishes (outside its async context). */
  private advanceAfter(jobId: string) {
    if (this.advanceFollowUps.has(jobId)) return;
    this.advanceFollowUps.add(jobId);
    const current = this.advancing.get(`${this.instanceId}:${jobId}`) ?? Promise.resolve();
    ADVANCE_CTX.exit(() => {
      void current.catch(() => {}).then(() => {
        this.advanceFollowUps.delete(jobId);
        return this.advanceJob(jobId);
      }).catch((e) => this.log("advance_failed", { job_id: jobId, error: (e as Error).message }));
    });
  }

  /** The live inbound sweep for one job (EngineDeps.reconcile); never throws. */
  private async reconcileJob(jobId: string): Promise<number> {
    if (!this.d.reconcile) return 0;
    try {
      return await this.d.reconcile(jobId);
    } catch (e) {
      this.log("reconcile_failed", { job_id: jobId, error: (e as Error).message });
      return 0;
    }
  }

  // ───────────────────────────── reliability (dead letters, recovery) ─────────────────────────────

  /**
   * Durable operator review (migration 109): one open row per kind + subject, with the redacted last
   * error, and an `operator_review` event on the job. What lands here is never retried by itself.
   * Never throws (a failing review write is logged; the caller's refusal stands either way).
   */
  private async deadLetter(r: { kind: OperatorReviewRow["kind"]; subject: string; job_id: string | null; reason: string; attempts: number; error?: unknown }): Promise<OperatorReviewRow | null> {
    try {
      const { row, created } = await this.repo.openReview({
        id: newId("rev"), job_id: r.job_id, kind: r.kind, subject: r.subject.slice(0, 300), reason: clip(r.reason, 200), attempts: Math.min(Math.max(r.attempts, 0), 1000),
        last_error: r.error === undefined || r.error === null ? null : redactError(r.error),
      }, this.now().toISOString());
      if (created) {
        this.log("operator_review", { review_id: row.id, kind: r.kind, job_id: r.job_id, reason: row.reason });
        if (r.job_id) await this.repo.appendEvent(r.job_id, "operator_review", { review_id: row.id, kind: r.kind, subject: row.subject, reason: row.reason });
      }
      return row;
    } catch (e) {
      this.log("operator_review_failed", { kind: r.kind, job_id: r.job_id, error: redactError(e) });
      return null;
    }
  }

  /** A provider call failed: record it, and once it may not be attempted again, send it to operator review. Never throws. */
  private async outboxFailed(key: string, jobId: string | null, kind: "email" | "text" | "call" | "a2a", status: "not_sent" | "unknown", err: unknown) {
    try {
      await this.repo.finishOutbox(key, status, null, this.now().toISOString());
      const row = await this.repo.getOutbox(key);
      if (!row || row.status === "sent") return;
      const d = row.status === "unknown" ? { action: "review" as const, reason: kind === "call" ? "call outcome unknown (the provider failed after dialing may have started); never redialed" : `${kind} outcome unknown; not re-sent automatically` }
        : decideClaim({ kind, key, row, nowMs: this.now().getTime(), staleMs: OUTBOX_STALE_MS, underReview: false });
      if (d.action === "review") await this.deadLetter({ kind: "outbox", subject: key, job_id: jobId, reason: d.reason, attempts: row.attempts, error: err });
    } catch (e) {
      this.log("outbox_record_failed", { job_id: jobId, kind, error: redactError(e) });
    }
  }

  /** Every A2A task Haggle sends: claimed in the outbox first (its messageId makes a resend idempotent at the business's agent). */
  private async a2aSend(jobId: string, key: string, req: Parameters<NonNullable<EngineDeps["a2a"]>["send"]>[0]) {
    await this.claimSend(key, jobId, "a2a");
    let t;
    try {
      t = await this.d.a2a!.send(req);
    } catch (err) {
      // Only a definite refusal is "not sent". A timeout or 5xx may come after the business's agent
      // took the task, and its messageId dedupe is unverified: unknown, reviewed, never re-sent.
      const definite = err instanceof ChannelSendError && !err.retryable && !err.ambiguous;
      await this.outboxFailed(key, jobId, "a2a", definite ? "not_sent" : "unknown", err);
      throw definite ? err : new ChannelSendError("provider_error", false, 0, `A2A task outcome unknown: ${(err as Error).message}`, true);
    }
    await this.repo.finishOutbox(key, "sent", `a2a-task:${t.taskId}`, this.now().toISOString());
    return t;
  }

  /**
   * Hold a Stripe charge instead of resuming it (decideChargeResume): too old for Stripe's
   * idempotency window, failing over and over, or under review. After an operator release
   * (job-ops retry --payment) the full payment guard runs again before anything is charged.
   * True: not charged now.
   */
  private async holdCharge(job: JobRow, approval: ApprovalRow, pay: PaymentRow): Promise<boolean> {
    const events = await this.repo.listEvents(job.id);
    const release = events.filter((e) => e.type === "operator_release" && e.data.payment_id === pay.id).at(-1);
    const retries = events.filter((e) => e.type === "payment_retry" && e.data.payment_id === pay.id && (!release || e.seq > release.seq)).length;
    const underReview = !!(await this.repo.findOpenReview("payment", pay.id));
    const v = decideChargeResume({ createdAt: pay.created_at, retries, nowMs: this.now().getTime(), underReview, releasedAt: release?.at ?? null });
    if (v.hold) {
      if (!underReview) await this.deadLetter({ kind: "payment", subject: pay.id, job_id: job.id, reason: v.reason, attempts: retries, error: pay.reason });
      return true;
    }
    if (v.released) {
      const g = await this.paymentVerdict(job, approval);
      if (!g.ok) {
        await this.repo.transitionPayment(pay.id, ["charging"], { status: "failed", reason: `refused:${g.code}` });
        await this.repo.appendEvent(job.id, "payment_refused", { code: g.code, approval_id: approval.id, resumed: true, operator_release: true });
        return true;
      }
    }
    return false;
  }

  /**
   * A call.ended whose call has no message row: the process died after dialing and before
   * recording it. Rebuilt from the outbox claim (its provider_ref, or the one open call claim to
   * that pinned number), so the transcript is read like any other and the call is never redialed.
   */
  private async recoverPlacedCall(call: { callId: string; remoteNumber?: string; direction?: string }): Promise<MessageRow | null> {
    const num = call.remoteNumber?.replace(/[\s().-]/g, "");
    let o = await this.repo.findOutboxByProviderRef(call.callId);
    let job: JobRow | null = null;
    let b: JobBusinessRow | undefined;
    const one = <T>(xs: T[]) => (xs.length === 1 ? xs[0] : undefined);
    if (o?.kind === "call" && o.job_id) {
      job = await this.repo.getJob(o.job_id);
      const bs = job ? await this.repo.getBusinesses(job.id) : [];
      b = bs.find((x) => o!.key.includes(`:${x.business_id}`)) ?? (num ? one(bs.filter((x) => x.phone === num)) : undefined);
      if (!b && o.key.startsWith("confirm:")) {
        const a = await this.repo.getApproval(o.key.slice("confirm:".length));
        b = bs.find((x) => x.business_id === a?.business_id);
      }
    } else if (!o && num && call.direction !== "inbound") {
      const hits: { j: JobRow; r: OutboxRow; b: JobBusinessRow }[] = [];
      for (const j of await this.repo.listOpenJobs()) {
        const bs = (await this.repo.getBusinesses(j.id)).filter((x) => x.phone === num);
        if (bs.length !== 1) continue;
        for (const r of await this.repo.listOutbox({ jobId: j.id, statuses: ["pending", "unknown"] })) if (r.kind === "call") hits.push({ j, r, b: bs[0]! });
      }
      const h = one(hits);
      if (h) ({ r: o, j: job, b } = h);
    }
    if (!o || !job || !b) return null;
    await this.repo.insertMessage({
      job_id: job.id, business_id: b.business_id, approval_id: null, direction: "out", kind: "call", channel: "phone", provider_email_id: call.callId, idempotency_key: o.key,
      rfc_message_id: null, thread_id: null, from_address: job.inbox, to_address: b.phone, subject: null, body_text: "(Call record rebuilt after a crash: the call was placed but not recorded.)", attachments: [], attachments_download_url: null,
      sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none", quarantine_reason: null, round: null, simulated: job.mode === "mock",
    });
    await this.repo.finishOutbox(o.key, "sent", call.callId, this.now().toISOString()).catch((e) => this.log("outbox_record_failed", { job_id: job!.id, error: redactError(e) }));
    await this.repo.appendEvent(job.id, "recovered", { from: "call_record_lost", key: o.key, call_id: call.callId });
    this.log("call_record_recovered", { job_id: job.id, business_id: b.business_id });
    return this.repo.findMessageByProviderId(call.callId);
  }

  /**
   * Replies to a closed deal (paid, confirmed, cancelled, failed), hours or days late: stored as
   * they arrived, never read into the deal (no quote, revision, question or payment step), shown on
   * the board, and the human is texted once for a deal that went ahead (a business answering the
   * booking confirmation, or backing out, is theirs to read). Not an operator matter by itself.
   */
  private async surfaceLateReplies(job: JobRow) {
    const pending = await this.repo.getPendingMessages(job.id);
    if (!pending.length) return;
    const businesses = await this.repo.getBusinesses(job.id);
    const names: string[] = [];
    for (const m of pending) {
      const name = businesses.find((x) => x.business_id === m.business_id)?.name ?? "A business";
      names.push(name);
      // Events first: a crash before the status change repeats them, never loses them.
      await this.repo.appendEvent(job.id, "late_reply", { message_id: m.id, business_id: m.business_id, channel: m.channel, job_state: job.state });
      await this.repo.appendEvent(job.id, "reply", { business_id: m.business_id, channel: m.channel, kind: "late_reply", summary: `${name} replied after this deal was ${job.state}; kept for the record, not read into the deal`, ...snippet(messageSnippet(m.body_text)) });
      await this.repo.updateMessage(m.id, { parse_status: "none" });
    }
    if (job.state === "paid" || job.state === "confirmed") await this.notifyHuman(job, `late:${pending[0]!.id}`, `${clip(names[0]!, 30)} replied after this deal closed; check the deal board.`);
    await this.repo.touchJob(job.id);
  }

  /**
   * Re-sends an operator asked for (job-ops retry --override-obligation): one `operator_retry`
   * event, run once. Only through the normal step, which re-checks the approval it rests on; the
   * outbox was re-armed by the script, so the claim allows exactly one more attempt.
   */
  private async runOperatorRetries(job: JobRow) {
    if (job.state !== "paying" && job.state !== "paid" && job.state !== "confirmed") return;
    const events = await this.repo.listEvents(job.id);
    const done = new Set(events.filter((e) => e.type === "operator_retry_done").map((e) => Number(e.data.retry_seq)));
    for (const e of events.filter((x) => x.type === "operator_retry" && !done.has(x.seq))) {
      const key = String(e.data.key);
      const confirm = /^confirm:/.test(key) && (job.state === "paid" || job.state === "confirmed");
      const accept = /^(?:accept|handoff):/.test(key) && job.state === "paying";
      await this.repo.appendEvent(job.id, "operator_retry_done", { retry_seq: e.seq, key, ran: confirm || accept });
      try {
        if (confirm) await this.sendConfirmation(job);
        else if (accept) await this.sendAccept(job);
      } catch (err) {
        this.log("operator_retry_failed", { job_id: job.id, key, error: redactError(err) });
      }
    }
  }

  /**
   * Operator gate on every open job's advance (ops/operator.ts): a suspended workspace's deal doesn't
   * advance at all (true: stop here), even without its hold; otherwise the operator's reviewed
   * requests (job-ops callback, quarantine release-text) run through the engine's own checks.
   */
  private async operatorGate(job: JobRow, open: OperatorReviewRow[]): Promise<boolean> {
    if (await workspaceSuspension(this.repo, job.workspace_id)) {
      this.log("advance_suspended", { job_id: job.id });
      return true;
    }
    await runOperatorRequests({
      repo: this.repo, now: () => this.now(), log: (e, d) => this.log(e, d),
      callback: (j, b, op) => this.operatorCallback(j, b, op), releaseText: (m, j, op) => this.releaseHeldText(m, j, op),
      isRefusal: (e): e is EngineError => e instanceof EngineError,
    }, job, open);
    return false;
  }

  /**
   * An operator's fail-safe close (job-ops fail-safe-close, deadLetter.planFailSafeClose), run by the
   * lease holder: the job ends `failed` (closed by the operator), a pending or unpaid approval
   * expires, an unpaid booking or handoff is withdrawn on Haggle's side, and the human is texted
   * exactly that. No business is contacted. While money may be moving it waits; after the customer
   * reported paying it is refused (resolved with the reason). True: this advance stops here.
   */
  private async runOperatorClose(job: JobRow, req: OperatorReviewRow): Promise<boolean> {
    const at = this.now().toISOString();
    const done = (resolution: string) => this.repo.resolveReview(req.id, { resolution, resolved_by: "haggle-server" }, at);
    const pay = await this.repo.getPaymentForJob(job.id);
    if (pay && ["charging", "signed", "sent"].includes(pay.status)) {
      this.log("operator_close_deferred", { job_id: job.id, payment_status: pay.status });
      return true;
    }
    const a = await this.repo.getLatestApproval(job.id);
    const h = a ? await this.repo.getHandoffByApproval(a.id) : null;
    if (h?.status === "human_confirmed" || pay?.status === "settled") {
      await done("refused by the server: money already moved (the customer reported paying, or a charge settled); handle it with the customer");
      await this.repo.appendEvent(job.id, "operator_attention", { reason: "close_refused_money_moved", review_id: req.id });
      return true;
    }
    const events = await this.repo.listEvents(job.id);
    const ask = events.filter((e) => e.type === "operator_close_requested").at(-1)?.data ?? {};
    const reason = clip(typeof ask.reason === "string" ? ask.reason : "closed by the operator", 80);
    const closed = await this.repo.casJob(job.id, job.version, { state: "failed", failure_reason: "operator_closed", ready: false });
    if (!closed) return true; // changed meanwhile: the next advance decides again
    await this.repo.appendEvent(job.id, "state", { from: job.state, to: "failed", cause: "operator_close", reason: "operator_closed" });
    let booking: "confirmed" | "requested" | null = null;
    if (a && (a.status === "pending" || a.status === "approved")) {
      await this.repo.transitionApproval(a.id, a.status, { status: "expired", decided_at: at });
      const bk = await this.repo.getBookingByApproval(a.id);
      if (bk && (await this.repo.updateBooking(bk.id, ["awaiting_vendor_confirmation", "confirmed", "not_in_writing"], { status: "cancelled", cancel_reason: "closed by the operator" }))) booking = bk.status === "awaiting_vendor_confirmation" ? "requested" : "confirmed";
      if (h) await this.repo.updateHandoff(h.id, ["instructions_requested", "instructions_received"], { status: "cancelled" });
    }
    const businesses = await this.repo.getBusinesses(job.id);
    const winner = a && booking ? clip(businesses.find((b) => b.business_id === a.business_id)?.name ?? "The business", 30) : null;
    const replied = businesses.filter((b) => ["replied", "quoted", "question"].includes(b.status) && b.business_id !== a?.business_id).map((b) => clip(b.name, 24));
    const who = booking === "confirmed" ? ` ${winner} had confirmed the booking and wasn't told it's off: contact them directly.`
      : booking === "requested" ? ` ${winner} was asked to confirm a booking and wasn't told it's off: let them know.`
      : replied.length ? ` Businesses that replied (${replied.slice(0, 3).join(", ")}${replied.length > 3 ? ", ..." : ""}) weren't told.` : "";
    const text = `an operator closed this deal (${reason}). Haggle won't contact any business about it again, and nothing was paid through Haggle.${who}`;
    await this.repo.appendEvent(job.id, "operator_closed", { by: typeof ask.by === "string" ? ask.by : null, reason, booking, businesses_told: false, at });
    await this.repo.appendEvent(job.id, "reply", { business_id: "", summary: `Closed by the operator (${reason}); no business was contacted` });
    await this.notifyHuman(closed, "operator-closed", text);
    await done("closed by the server: job failed (operator_closed), the human texted, no business contacted");
    const hold = await this.repo.findOpenReview("stuck_job", holdSubject(job.id));
    if (hold) await this.repo.resolveReview(hold.id, { resolution: "job closed by the operator", resolved_by: "haggle-server" }, at);
    this.log("operator_closed", { job_id: job.id, booking });
    return true;
  }

  private async recoverySnapshot(job: JobRow) {
    const [businesses, approval, payment, outbox, pending] = await Promise.all([
      this.repo.getBusinesses(job.id), this.repo.getLatestApproval(job.id), this.repo.getPaymentForJob(job.id), this.repo.listOutbox({ jobId: job.id }), this.repo.getPendingMessages(job.id),
    ]);
    const [booking, handoff] = approval && job.state === "paying" ? await Promise.all([this.repo.getBookingByApproval(approval.id), this.repo.getHandoffByApproval(approval.id)]) : [null, null];
    return { job, businesses, approval, payment, outbox, pendingMessages: pending.length, booking, handoff };
  }

  /**
   * Stuck-job recovery (the backup tick; workflow/recovery.ts): every open job and recently closed
   * one is checked against its deadlines. What an advance can move on is advanced (always safe:
   * keyed sends, CAS transitions); a call claim left by a crash is recorded as unknown (never
   * redialed); what still isn't moving goes to operator review, once.
   */
  async recoverStuck(opts: { advanceOpen?: boolean; limit?: number } = {}): Promise<{ findings: StuckFinding[]; reviewed: number }> {
    const now = this.now().getTime();
    const open = (await this.repo.listOpenJobs()).slice(0, opts.limit ?? 200);
    const closed = (await this.repo.listRecentJobs(30)).filter((j) => TERMINAL.has(j.state) && now - Date.parse(j.updated_at) < 3 * 86_400_000);
    const findings: StuckFinding[] = [];
    let reviewed = 0;
    for (const job of [...open, ...closed]) {
      try {
        // On an operator hold: the operator is already looking; nothing is advanced or re-reviewed.
        if (!TERMINAL.has(job.state) && (await this.repo.findOpenReview("stuck_job", holdSubject(job.id)))) continue;
        let f = planRecovery(await this.recoverySnapshot(job), now);
        if (f.some((x) => x.action === "advance") && (opts.advanceOpen !== false || TERMINAL.has(job.state))) {
          await this.advanceJob(job.id);
          f = planRecovery(await this.recoverySnapshot((await this.repo.getJob(job.id)) ?? job), now);
        }
        for (const x of f) {
          if (x.action === "advance") continue;
          const kind: OperatorReviewRow["kind"] = x.issue === "confirmation_not_sent" ? "confirmation" : x.subject && x.issue !== "charge_stale" ? "outbox" : "stuck_job";
          const subject = kind === "stuck_job" ? `${job.id}:${x.issue}` : x.subject!;
          if (x.action === "mark_unknown") await this.repo.finishOutbox(subject, "unknown", null, this.now().toISOString());
          if (await this.repo.findOpenReview(kind, subject)) continue;
          if (await this.deadLetter({ kind, subject, job_id: job.id, reason: x.detail, attempts: 0 })) reviewed++;
        }
        findings.push(...f);
      } catch (e) {
        this.log("recovery_failed", { job_id: job.id, error: redactError(e) });
      }
    }
    return { findings, reviewed };
  }

  /** The inbound reconciler gave up on an item (its maxAttempts): an operator looks; it is not retried silently. */
  async reportReconcileGaveUp(item: { key: string; attempts: number; error: unknown; jobId?: string | null }) {
    await this.deadLetter({ kind: "reconcile", subject: item.key, job_id: item.jobId ?? null, reason: "an inbound item couldn't be ingested; the reconciler gave up on it", attempts: item.attempts, error: item.error });
  }

  private async advanceJobOnce(jobId: string): Promise<void> {
    let first = await this.repo.getJob(jobId);
    if (!first) return;
    if (TERMINAL.has(first.state)) {
      // Closed: nothing advances, but a reply that arrived since is surfaced (never read into the
      // deal), and an operator's re-send of a failed confirmation runs.
      await this.surfaceLateReplies(first);
      await this.runOperatorRetries(first);
      return;
    }
    // Operator actions (job-ops): a requested fail-safe close runs first; a hold stops everything else.
    // One read for both (this runs on every advance): the job's open stuck_job reviews.
    const operator = (await this.repo.listReviews({ status: "open", jobId, limit: 1000 })).filter((r) => r.kind === "stuck_job");
    const closeReq = operator.find((r) => r.subject === closeSubject(jobId));
    if (closeReq && (await this.runOperatorClose(first, closeReq))) return;
    if (operator.some((r) => r.subject === holdSubject(jobId))) {
      this.log("advance_held", { job_id: jobId });
      return;
    }
    if (await this.operatorGate(first, operator)) return;
    if (first.state === "created") {
      await this.recoverCreated(first);
      first = (await this.repo.getJob(jobId)) ?? first;
    }
    // A lost lease (fenced) ends the advance at the next step: another instance has the job.
    const phases: ((j: JobRow) => Promise<unknown>)[] = [
      (j) => this.pollA2a(j), (j) => this.dueCalls(j), (j) => this.dueScheduledCalls(j), (j) => this.parsePending(j),
      (j) => this.runDueContacts(j), (j) => this.surfaceQuestions(j), () => this.processPayment(jobId), () => this.purchaseTick(jobId), (j) => this.runOperatorRetries(j),
    ];
    for (const [i, phase] of phases.entries()) {
      if (this.fenced(jobId)) return;
      await phase(i < 4 ? first : ((await this.repo.getJob(jobId)) ?? first));
    }
    let swept = false;
    for (let step = 0; step < 6; step++) {
      if (this.fenced(jobId)) return;
      const job = await this.repo.getJob(jobId);
      if (!job || TERMINAL.has(job.state)) return;
      const event = await this.dueEvent(job);
      if (!event) break;
      // Before quotes become final (collection or a negotiation round closes): pick up a reply whose
      // webhook was lost (live HG-2QAM: Sunset Kitchen's $2,660 counter answer), read it, decide again.
      if (event.type === "window_closed" && !swept && !job.ready && (job.state === "collecting" || job.state === "negotiating")) {
        swept = true;
        if (await this.reconcileJob(jobId)) {
          await this.parsePending((await this.repo.getJob(jobId)) ?? job);
          continue;
        }
      }
      // Applied only to the state it was decided for: if another advance (another process) moved the
      // job meanwhile, decide again from the new state instead.
      const r = await this.fire(jobId, event, event.type, job);
      if (!r.ok && r.reason === STALE_EVENT) continue;
      if (!r.ok) break;
    }
    if (this.fenced(jobId)) return;
    await this.offerReady(jobId);
    await this.reviseSuggestion(jobId);
  }

  private async dueEvent(job: JobRow): Promise<JobEvent | null> {
    const now = this.now().getTime();
    const deadlinePassed = now > Date.parse(job.collect_until);
    const businesses = await this.repo.getBusinesses(job.id);
    if (job.state === "contacting") return businesses.every((b) => b.status !== "pending") ? { type: "rfqs_sent" } : null;
    if ((job.state === "collecting" || job.state === "negotiating") && !job.ready) {
      if (job.state === "collecting") {
        // Every contacted business has answered (a quote, a decline, no reply, a bounce): close now
        // and negotiate or finish, instead of sitting out the whole collection window.
        if (businesses.length > 0 && (await this.collectionWaiting(job, businesses)).length === 0) return { type: "window_closed" };
      } else {
        const events = await this.repo.listEvents(job.id);
        const sent = events.some((e) => e.type === "counteroffers_sent" && Number(e.data.round) === job.round);
        // The round can't close before its counteroffers are planned and sent (counteroffers_sent,
        // recorded by the advance that opened the round once every counter went out; zero planned
        // closes it at once). Until then it waits, even past the window: the sender may be another
        // process, or a strategist call that outlasted a short window. Only a send that evidently
        // died lets the round close without them.
        if (!sent) return now > Date.parse(job.collect_until) + COUNTERS_LOST_AFTER_MS ? { type: "window_closed" } : null;
        const outstanding = await this.awaitingCounterAnswers(job, businesses, events);
        if (outstanding.waiting.length === 0) return { type: "window_closed" };
        // A counteroffer call already ringing when the window ends gets a short grace to finish.
        if (deadlinePassed && outstanding.onCall && now - Date.parse(job.collect_until) < COUNTER_CALL_GRACE_MS) return null;
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
  /**
   * Countered businesses this negotiation round still waits for. The round closes when every
   * countered business answered or the window ends, whichever is first. A counteroffer that never
   * went out (a dropped call, a call scheduled past the window) waits for nothing.
   */
  private async awaitingCounterAnswers(job: JobRow, businesses: JobBusinessRow[], events: JobEventRow[]): Promise<{ waiting: JobBusinessRow[]; onCall: boolean }> {
    // Who was countered in this round (a manual round may counter only some businesses).
    const start = events.findLastIndex((e) => e.type === "state" && e.data.to === "negotiating");
    const roundEvents = events.slice(start + 1);
    const counteredIds = new Set(roundEvents.filter((e) => e.type === "counteroffer").map((e) => String(e.data.business_id)));
    const countered = businesses.filter((b) => counteredIds.has(b.business_id) || (b.countered_round > 0 && b.countered_round === job.round));
    const msgs = await this.repo.listMessages(job.id);
    const quotes = (await this.repo.listQuotes(job.id)).filter((q) => q.status === "current");
    const dropped = new Set(events.filter((e) => e.type === "call_dropped").map((e) => String(e.data.key)));
    const waiting: JobBusinessRow[] = [];
    let onCall = false;
    for (const b of countered) {
      if (b.status === "bounced" || b.status === "declined") continue;
      const key = sendKeys.counter(job.id, b.business_id, b.countered_round);
      const out = msgs.find((m) => m.direction === "out" && m.idempotency_key === key);
      if (!out) {
        // A counteroffer call not placed yet waits only while it can still be placed in this window.
        if (dropped.has(key)) continue;
        const sched = roundEvents.filter((e) => e.type === "call_scheduled" && e.data.key === key).at(-1);
        if (sched && Date.parse(String(sched.data.at)) <= Date.parse(job.collect_until)) waiting.push(b);
        continue;
      }
      // Answered: the business replied (any parsed reply: a new total, a "can't do better", the
      // counter call's transcript) after the counteroffer actually went out. A counter call that
      // ended without anything to read (no answer, declined, failed: stored with nothing to parse)
      // is over too; only a reply still being read keeps the round open.
      const replied = msgs.some((m) => m.direction === "in" && m.business_id === b.business_id && m.kind === "reply" && m.created_at > out.created_at && m.parse_status !== "pending")
        || quotes.some((q) => q.business_id === b.business_id && q.round >= b.countered_round && q.created_at > out.created_at);
      if (replied) continue;
      waiting.push(b);
      if (out.channel === "phone") onCall = true;
    }
    return { waiting, onCall };
  }

  /**
   * The businesses the collection window still waits for: one contacted and not yet answered, a
   * call on the line or due, a reply still being read, and, briefly (holdMs), one Haggle just asked
   * for something (a follow-up, the answer to its question) or that asked a question the human
   * hasn't answered. A business with a current priced quote has answered, whatever its status row
   * says (the status can lag or be overwritten; the quote is the fact). Custom-ask requests also
   * hold for a business owing its missing required answers (owingFollowUp).
   */
  private async collectionWaiting(job: JobRow, businesses: JobBusinessRow[]): Promise<JobBusinessRow[]> {
    const now = this.now().getTime();
    const holdMs = this.d.config.questionHoldMs ?? this.d.config.replyGraceMs ?? Math.min(this.d.config.collectionWindowMs, 15 * 60_000);
    const owesFollowUp = await this.owingFollowUp(job);
    const questions = (await this.repo.listQuestions(job.id)).filter((q) => q.status === "pending");
    const askingRecently = new Set(questions.filter((q) => now - Date.parse(q.created_at) < holdMs).map((q) => q.business_id));
    const quoted = answeredByQuote(await this.repo.listQuotes(job.id));
    const msgs = await this.repo.listMessages(job.id);
    const chased = chasedRecently(msgs, await this.repo.listEvents(job.id), now, this.d.config.followUpHoldMs ?? Math.min(holdMs, DEFAULT_FOLLOW_UP_HOLD_MS));
    const reading = new Set(msgs.filter((m) => m.direction === "in" && m.parse_status === "pending" && m.business_id).map((m) => m.business_id!));
    return businesses.filter((b) => {
      const id = b.business_id;
      if (b.status === "ringing" || (b.status === "pending" && b.next_attempt_at !== null) || owesFollowUp.has(id) || chased.has(id) || reading.has(id)) return true;
      if (quoted.has(id)) return false;
      if (b.status === "contacted") return true;
      // Replied without a price (and nothing asked back): give it a moment, not the whole window.
      if (b.status === "replied") return now - Date.parse(b.last_reply_at ?? b.contacted_at ?? job.created_at) < holdMs;
      if (b.status === "question") return askingRecently.has(id) || !questions.some((q) => q.business_id === id);
      return false;
    });
  }

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
    const pending = await this.repo.getPendingMessages(job.id);
    // Transient provider failures already retried (job events, so the count survives restarts).
    const retries = pending.length ? (await this.repo.listEvents(job.id)).filter((e) => e.type === "parse_retry") : [];
    for (const msg of pending) {
      // Parsed meanwhile by another advance (another process; an old engine after a hot reload).
      if ((await this.repo.getMessage(msg.id))?.parse_status !== "pending") continue;
      const tried = retries.filter((e) => e.data.message_id === msg.id);
      const waitUntil = tried.at(-1)?.data.retry_after;
      if (typeof waitUntil === "string" && this.now().getTime() < Date.parse(waitUntil)) continue; // backing off
      let phase: "read" | "store" = "read";
      const b = businesses.find((x) => x.business_id === msg.business_id);
      if (!b) {
        await this.repo.updateMessage(msg.id, { parse_status: "failed" });
        continue;
      }
      // Unauthenticated mail is kept for audit but never parsed: no LLM call, no attachment
      // download, no quote, question or payment step can come from it.
      if (msg.sender_trusted !== true) {
        await this.repo.updateMessage(msg.id, { parse_status: "done" });
        const why = explainQuarantine(msg.trust_reason);
        await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "unverified_sender", summary: `ignored an unauthenticated email claiming to be ${b.name}${why.known ? `. ${why.action}` : ""}`, ...(why.known ? quarantineEventData(why, msg.id) : {}) });
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
        let structuredQuote = false;
        const qj = files.find((f) => f.kind === "json" && /quote\.json$/i.test(f.filename));
        if (qj) {
          try {
            const parsed = quotePartToExtraction(JSON.parse(Buffer.from(qj.data).toString("utf8")), job.id, reqs, job.request.quantity);
            if (parsed.ok) { extraction = parsed.extraction; structuredQuote = true; }
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
        const history = await this.conversationHistory(job, b, msg);
        extraction ??= await this.d.extractor.extract({
          request: {
            what: r.what, ...(r.date ? { date: r.date } : {}), ...(r.quantity !== undefined ? { headcount: r.quantity } : {}), location: r.area,
            dietary: reqs.filter((x) => x.kind === "dietary" && x.need).map((x) => ({ need: x.need!, count: x.min_count ?? 0 })), requirements: r.requirements.map((x) => x.text),
            ...(r.details?.length ? { details: r.details } : {}), ...(r.ask?.length ? { ask: r.ask } : {}), channel: msg.channel,
            ...(r.requirements.length ? { requirementList: r.requirements.map((x) => ({ id: x.id, kind: x.kind, text: x.text, ...(x.min_count !== undefined ? { min_count: x.min_count } : {}) })) } : {}),
            ...history,
          },
          bodyText, pdfs: files.filter((f): f is typeof f & { kind: "pdf" } => f.kind === "pdf"), ...(images.length ? { images } : {}), message: msg,
        });
        // On a call, a price only Haggle's voice agent said (a cited quote, the buyer's target) is not the business's.
        if (msg.channel === "phone") extraction = dropAgentOnlyAmounts(extraction, bodyText, r.ask ?? []);
        // Silence about a requirement is unknown, not a refusal: a "no" stands only when the business said
        // it somewhere in this conversation, in this reply or an earlier one (decision 29). Only checkable
        // when every word is text (no PDF or image the text can't show).
        if (!qj && !files.some((f) => f.kind === "pdf" || f.kind === "image")) {
          const own = msg.channel === "email" ? cleanEmailBody(msg.body_text ?? "") : msg.body_text ?? "";
          const said = [...(history.history ?? []).filter((h) => h.from === "business").map((h) => h.text), own].join("\n");
          extraction = dropUnsupportedRequirementAnswers(dropUnstatedDietaryRefusals(extraction, said), said);
        }
        // The extractor only knows email wording ("email body"); figures from a call or a text say so.
        const channelSource = msg.channel === "a2a" ? "a2a task" : msg.channel === "phone" ? "call transcript" : msg.channel === "imessage" ? "iMessage text" : null;
        // A keyword-fallback reading keeps its "(heuristic)" label (it is what makes the quote non-approvable).
        if (channelSource) for (const src of extraction.sources) if (msg.channel === "a2a" || !/^pdf\b/i.test(src.source)) src.source = /\(heuristic\)/.test(src.source) ? `${channelSource} (heuristic)` : channelSource;
        phase = "store"; // from here a retry could store twice: errors are final
        await this.storeExtraction(job, b, msg, extraction, channelSource ?? (qj ? "quote.json" : files.some((f) => f.kind === "pdf") ? "pdf" : images.length ? "image" : "email body"), { structured: structuredQuote });
        await this.repo.updateMessage(msg.id, { parse_status: "done" });
      } catch (err) {
        const transient = phase === "read" && isTransientParseError(err);
        this.log(transient ? "parse_retry" : "parse_failed", { job_id: job.id, message_id: msg.id, error: (err as Error).message, attempt: tried.length + 1 });
        if (transient && tried.length < MAX_PARSE_RETRIES) {
          // Busy or unreachable provider: stays pending, read again on a later tick (bounded, backing off).
          const attempt = tried.length + 1;
          await this.repo.appendEvent(job.id, "parse_retry", { message_id: msg.id, business_id: b.business_id, attempt, max_attempts: MAX_PARSE_RETRIES, error: parseErrorKind(err), retry_after: new Date(this.now().getTime() + parseRetryDelayMs(attempt)).toISOString() });
          continue;
        }
        await this.repo.updateMessage(msg.id, { parse_status: "failed" });
        await this.repo.appendEvent(job.id, "parse_failed", { message_id: msg.id, business_id: b.business_id, error: parseErrorKind(err), retried: tried.length });
        await this.deadLetter({ kind: "parse", subject: msg.id, job_id: job.id, reason: `reply from ${clip(b.name, 40)} couldn't be read (${parseErrorKind(err)})`, attempts: tried.length + 1, error: err });
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: UNREADABLE_REPLY });
        await this.repo.touchJob(job.id);
      }
    }
  }

  /**
   * What this business and Haggle said before this reply, on every channel (email, texts, call
   * transcripts, A2A), oldest first: Claude judges each requirement from the whole conversation,
   * so "20 veg or more" on a text and a later "correct" on a call both count. The RFQ and our call
   * briefs are left out (the request itself is given separately).
   */
  private async conversationHistory(job: JobRow, b: JobBusinessRow, msg: MessageRow): Promise<{ history?: NonNullable<ExtractionRequest["history"]> }> {
    const earlier = (await this.repo.listMessages(job.id)).filter((m) => m.business_id === b.business_id && m.id !== msg.id && m.created_at <= msg.created_at && m.body_text?.trim()
      && (m.direction === "in" ? m.kind === "reply" && m.sender_trusted === true : m.kind !== "rfq" && !isPlacedCall(m)));
    const history = earlier.slice(-8).map((m) => ({
      from: m.direction === "in" ? ("business" as const) : ("haggle" as const), channel: m.channel,
      text: m.direction === "in" && m.channel === "email" ? cleanEmailBody(m.body_text ?? "") : m.body_text ?? "",
    }));
    return history.length ? { history } : {};
  }

  private async storeExtraction(job: JobRow, b: JobBusinessRow, msg: MessageRow, x: Parameters<typeof validateQuote>[0], kind: string, opts: { structured?: boolean } = {}) {
    // Mail that fails sender authentication never becomes a quote or a question: it can't win, and
    // it must not supersede (knock out) the business's genuine quote either. Kept for audit only.
    if (msg.sender_trusted !== true) {
      await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: "unverified_sender", summary: `ignored an unauthenticated email claiming to be ${b.name}` });
      await this.repo.touchJob(job.id);
      return;
    }
    const reqs = this.requirements(job);
    const followupsBefore = b.followups_sent;
    const { ask, compare, moneyCompare, payable } = askInfo(job.request);
    const prior = (await this.repo.listQuotes(job.id)).filter((q) => q.business_id === b.business_id);
    const priorCurrent = prior.find((q) => q.status === "current");
    // A reply that answers only part (e.g. the follow-up) keeps everything stated before: unstated
    // facts carry over from the business's current quote (never across a decline).
    const needs = reqs.filter((r) => r.kind === "dietary" && r.need).map((r) => r.need!);
    const priorRecord = priorCurrent?.sender_trusted ? priorCurrent.record : null;
    const ownText = msg.channel === "email" ? cleanEmailBody(msg.body_text ?? "") : msg.body_text ?? "";
    let fresh = validateQuote(x, job.request.quantity, ask, { needs, requirementIds: reqs.map((r) => r.id), prior: priorRecord });
    // "prolly around 1300", "approximately twelve hundred": the business's own words hedge the total.
    // Deterministic, from its text (a structured quote.json is firm by construction).
    if (!opts.structured && fresh.total_cents !== null && isApproximateTotal({ totalCents: fresh.total_cents, excerpts: [(fresh.sources.total?.excerpt ?? "").split(" + ")[0]!], text: msg.body_text ?? "", channel: msg.channel })) {
      fresh = { ...fresh, flags: [...fresh.flags, APPROXIMATE_FLAG] };
    }
    // The attached PDF's total and the total the email itself states disagree: the human must see it.
    if (msg.channel === "email" && !fresh.flags.includes("conflicting_numbers") && pdfBodyTotalConflict(x, ownText)) fresh = { ...fresh, flags: [...fresh.flags, "conflicting_numbers"] };
    // Another date, a delivery window that misses the time, a reply written as another business
    // (parsing/termsCheck.ts): flagged, and approval waits for the human to sort it out. A call
    // transcript is checked only through what the reader extracted (it holds the agent's words too).
    const terms = termsMismatch({ own: msg.channel === "phone" ? null : ownText, x, request: job.request, businessName: b.name });
    if (terms.flags.length) fresh = { ...fresh, flags: [...new Set([...fresh.flags, ...terms.flags])], terms_mismatch: { notes: terms.notes, ...(terms.offered_date ? { offered_date: terms.offered_date } : {}), ...(terms.delivery_window ? { delivery_window: terms.delivery_window } : {}), ...(terms.signed_as ? { signed_as: terms.signed_as } : {}) } };
    let record = mergeCarryOver(fresh, priorRecord);
    // An answer to "can you confirm X?" ("yes, 45 vegetarian", "$250 extra for delivery") carries no
    // price: it revises the business's current quote with what it now states, keeping that quote's own
    // figures. A newly stated extra the earlier total didn't include is added to it, with its source.
    const statesTerms = Object.keys(fresh.dietary_coverage).length > 0 || fresh.delivery_included !== null || fresh.delivery_fee_cents !== null || fresh.tax_cents !== null || Object.keys(fresh.requirement_answers ?? {}).length > 0 || (fresh.other_fees?.length ?? 0) > 0 || !!fresh.terms || fresh.deposit_cents !== null;
    // "Yes, that's firm" to Haggle's one request for a firm total: the approximate figure becomes firm.
    const firmed = !!priorRecord && isApproximate(priorRecord) && fresh.total_cents === null && confirmsFirm(ownText, msg.channel);
    if (priorRecord && fresh.total_cents === null && fresh.available && priorRecord.available && priorRecord.total_cents !== null && fresh.questions.length === 0 && (statesTerms || firmed)) {
      const p = priorRecord;
      const extras = ([["delivery_fee", "delivery_fee_cents", p.delivery_included !== true], ["tax", "tax_cents", p.tax_included !== true]] as const)
        .filter(([, k, notIncluded]) => notIncluded && p[k] === null && fresh[k] !== null && fresh[k]! > 0);
      // A fee disclosed later as not included ("plus $300 staffing") is added the same way.
      const knownFees = new Set((p.other_fees ?? []).map((f) => f.label.toLowerCase()));
      const newFees = (fresh.other_fees ?? []).filter((f) => f.included_in_total === false && f.amount_cents !== null && f.amount_cents > 0 && !knownFees.has(f.label.toLowerCase()));
      const added = extras.reduce((sum, [, k]) => sum + fresh[k]!, 0) + newFees.reduce((sum, f) => sum + f.amount_cents!, 0);
      // Gap flags are recomputed from the merged facts, never copied from a short answer that simply
      // didn't repeat them (e.g. "Yes, 45 vegetarian" doesn't make an included delivery unclear again).
      const deliveryKnown = record.delivery_included !== null || record.delivery_fee_cents !== null;
      const feesKnown = !fresh.flags.includes("fees_unclear") && (fresh.other_fees?.length ?? 0) > 0;
      const taxKnown = record.tax?.status === "included" || record.tax_cents !== null;
      const flags = [...new Set([...p.flags, ...record.flags])].filter((f) => !(f === "delivery_unclear" && deliveryKnown) && !(f === "fees_unclear" && feesKnown) && !(f === "tax_excluded" && taxKnown) && f !== "question_pending");
      const statedTotal = p.sources.total;
      record = {
        ...record,
        ...(p.requirement_answers || fresh.requirement_answers ? { requirement_answers: { ...p.requirement_answers, ...fresh.requirement_answers } } : {}),
        ...(fresh.terms || p.terms ? { terms: fresh.terms ?? p.terms } : {}),
        ...(fresh.other_fees?.length || p.other_fees?.length ? { other_fees: [...(p.other_fees ?? []), ...(fresh.other_fees ?? []).filter((f) => !knownFees.has(f.label.toLowerCase()))] } : {}),
        ...(added ? {
          total_cents: p.total_cents! + added,
          sources: {
            ...record.sources,
            total: { source: `computed from stated total + ${[...extras.map(([f]) => f.replace("_", " ")), ...newFees.map((f) => f.label)].join(" + ")}${statedTotal ? ` (${statedTotal.source})` : ""}`, excerpt: [statedTotal?.excerpt, ...extras.map(([f]) => fresh.sources[f]?.excerpt), ...newFees.map((f) => f.excerpt)].filter(Boolean).join(" + ").slice(0, 200) },
          },
        } : {}),
        flags, confidence: Math.min(p.confidence, fresh.confidence),
      };
      // A deposit stated in the answer ("$200 deposit") completes the quote only when it fits within the total.
      if (fresh.deposit_cents !== null && fresh.deposit_cents > record.total_cents!) {
        record = { ...record, deposit_cents: p.deposit_cents, sources: { ...record.sources, ...(p.sources.deposit ? { deposit: p.sources.deposit } : {}) } };
      }
      if (firmed) {
        const t = record.sources.total;
        record = { ...record, flags: record.flags.filter((f) => f !== APPROXIMATE_FLAG), sources: { ...record.sources, total: { source: `${t?.source ?? "stated"}; confirmed firm by the business`, excerpt: `${t?.excerpt ?? ""} / ${ownText.trim().slice(0, 80)}`.slice(0, 200) } } };
      }
    }
    // A carried-over estimate stays an estimate until the business confirms a firm figure.
    if (priorRecord && isApproximate(priorRecord) && fresh.total_cents === null && !firmed && record.total_cents === priorRecord.total_cents && !record.flags.includes(APPROXIMATE_FLAG)) {
      record = { ...record, flags: [...record.flags, APPROXIMATE_FLAG] };
    }
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
    // Delivery said only in prose ("we'll bring everything to the office"): a delivery requirement the
    // business met (Claude's requirement check, decision 11) means delivery is not unclear, so the
    // all-in total isn't held back for it (no all-in ask, no all_in_unknown block).
    if (record.flags.includes("delivery_unclear") && reqs.some((r) => r.kind === "delivery" && results.find((x) => x.requirement_id === r.id)?.met === true)) {
      record = { ...record, flags: record.flags.filter((f) => f !== "delivery_unclear") };
    }
    // Already stored from this very message: another parse of it won (another process, an old
    // engine after a hot reload). Storing again would duplicate its questions and, worse, write a
    // stale status over the winner's ("replied" over "quoted": live 2026-10-18, HG-2QAM).
    if (prior.some((q) => q.message_id === msg.id) || (await this.repo.listQuestions(job.id)).some((q) => q.message_id === msg.id)) {
      this.log("parse_duplicate", { job_id: job.id, message_id: msg.id });
      return;
    }
    let quoteRow: QuoteRow | null = null;
    // Every priced reply is reported as a quote, even without a single stated total (flagged; Haggle
    // asks for the exact total below when it can).
    const priced = record.total_cents !== null || record.subtotal_cents !== null || record.price_per_head_cents !== null || record.deposit_cents !== null;
    const statedField = Object.values(record.fields ?? {}).some((v) => v !== null);
    if (priced || !record.available || statedField) {
      const source = record.sources.total?.source ?? (kind === "quote.json" ? "quote.json" : kind);
      // The quote's round is the negotiation round it answers (1 until the business is countered),
      // not its reply count: a clarification before any counteroffer (the exact total, a confirmed
      // requirement) stays round 1, so it never uses up the business's negotiation round.
      const counteredRound = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === b.business_id)?.countered_round ?? b.countered_round;
      quoteRow = await this.repo.insertCurrentQuote({
        job_id: job.id, business_id: b.business_id, message_id: msg.id, round: Math.max(1, counteredRound), record, total_cents: record.total_cents,
        // The quotes table requires a total for a compliant row (quotes_check1: not compliant or total_cents
        // is not null): a decline or a reply priced without a total is stored as not (yet) compliant; its
        // requirement results stay as evaluated, and ranking re-derives compliance from them.
        deposit_cents: record.deposit_cents, compliant: compliant && record.total_cents !== null, requirement_results: results, sender_trusted: msg.sender_trusted === true, source,
      });
      // A concurrent parse of the same message stored it first (and set the status): nothing more to do.
      if (!quoteRow) {
        this.log("parse_duplicate", { job_id: job.id, message_id: msg.id });
        return;
      }
    }
    // A business question never stops the deal: it is recorded here, answered from the request when
    // the request plainly answers it (below), and otherwise texted to the human together with the
    // other open questions (surfaceQuestions) while every business keeps quoting. Courtesy questions
    // ("so, will you be using us?") need no answer: kept on the record and the board, never relayed.
    const questionIds: string[] = [];
    const asked: QuestionRow[] = [];
    for (const text of record.questions) {
      const q = await this.repo.insertQuestion({ job_id: job.id, business_id: b.business_id, message_id: msg.id, text });
      questionIds.push(q.id);
      asked.push(q);
      await this.repo.appendEvent(job.id, "question", { question_id: q.id, business_id: b.business_id, text });
    }
    if (record.courtesy_questions?.length) {
      await this.repo.appendEvent(job.id, "reply", {
        business_id: b.business_id, kind: "courtesy_question",
        summary: `${b.name} asked "${clip(record.courtesy_questions.join(" "), 140)}" (no answer needed for the quote; not passed on)`,
      });
    }
    // No stated total (missing or worked out from parts): ask once for the exact figure, on the
    // channel the business was first contacted on (email, text, a follow-up call, A2A). Vague replies
    // ("~900ish", a call that ended without a price) too, instead of guessing a number.
    // A total Haggle worked out from parts the business stated (per person x headcount, stated
    // delivery and fees, a stated tax rate) is trusted as firm when every part is known (decision 47):
    // no "we worked it out as $X, please confirm" ask. Parts missing (delivery or tax unstated) still ask.
    const computed = /^computed/.test(record.sources.total?.source ?? "");
    const stated = record.total_cents !== null && (!computed || (allInKnown(record, this.needsDelivery(job)) && !isApproximate(record)));
    // A request compared on a non-money answer (e.g. earliest date) needs that answer, not a total.
    const needExact = record.available && record.questions.length === 0 && !(quoteRow && stated) && !nonMoneyCompare(job.request);
    // One automatic follow-up for whatever the quote still lacks (required answers, unstated hard
    // requirements), with the total ask folded in: one message, not two.
    const chase = record.available && job.request.auto_follow_up !== false && !TERMINAL.has(job.state) && !job.ready;
    const missing = quoteRow && chase ? this.missingLabels(job, quoteRow) : [];
    // On a stated total: an approximate one asks for the firm all-in figure (and the deposit when
    // unknown), which also covers the all-in question; otherwise an unconfirmed all-in total (delivery,
    // tax or fees not stated) asks for it.
    // Never by a new call (main): a phone vendor's firm figure needs a callback only the human authorizes.
    const approx = !!quoteRow && record.available && isApproximate(record) && record.total_cents !== null && b.channel !== "phone";
    const firmAsk = approx ? `your firm all-in total (you said about $${centsToUsd(record.total_cents!).toLocaleString("en-US")})${record.deposit_cents === null ? " and the deposit" : ""}` : null;
    // A delivery requirement already being asked about covers delivery: the all-in ask isn't repeated for it.
    const deliveryAsked = missing.some((m) => reqs.some((r) => r.kind === "delivery" && r.text === m));
    const allInAsk = !firmAsk && !needExact && quoteRow && record.available && b.channel !== "phone" && !(isApproximate(record)) && !allInKnown(record, this.needsDelivery(job) && !deliveryAsked) ? "the all-in total including delivery, tax and any fees" : null;
    const totalAsk = needExact ? exactTotalAsk(record.total_cents) : firmAsk ?? allInAsk;
    if (quoteRow) {
      // No text to the human per quote: the deal board and wait_for_update show it; the human is
      // texted once quotes are final (offerReady) or when they must answer something.
      await this.repo.appendEvent(job.id, "quote", { quote_id: quoteRow.id, business_id: b.business_id, total_usd: record.total_cents === null ? null : centsToUsd(record.total_cents), round: quoteRow.round });
      for (const f of record.flags) await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: f });
      // "Doesn't meet" (the business said no) is told apart from "not confirmed yet" (it didn't say).
      if (!compliant) await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: results.some((r) => r.met === false) ? "requirement_unmet" : "requirement_unknown" });
      if (priorCurrent) await this.onRevision(job, priorCurrent);
    } else if (record.questions.length === 0) {
      // A reply that adds nothing to a quote we already have ("ok", the reference code) is not news.
      if (!priorCurrent) for (const f of record.flags) await this.repo.appendEvent(job.id, "flag", { business_id: b.business_id, flag: f });
    }
    if (needExact && missing.length === 0) await this.askExactTotal(job, b, record.total_cents);
    const status = !record.available ? "declined" : quoteRow ? "quoted" : record.questions.length ? "question" : followupsBefore >= 1 ? "silent" : "replied";
    await this.repo.updateBusiness(job.id, b.business_id, { status });
    if (asked.length && record.available && !record.flags.some((f) => f === "external_payment_link" || f === "prompt_injection")) await this.answerFromRequest(job, b, asked);
    // The window waits briefly for the answer (collectionWaiting), never past the deadline. One
    // batched follow-up: the missing answers plus the total ask (exact, firm or all-in), once.
    if (missing.length) await this.sendMissingFollowUp(job, { ...b, status }, missing, totalAsk && followupsBefore < 1 ? { totalAsk, firmTotal: firmAsk !== null } : {});
    else if (!needExact && totalAsk && chase && followupsBefore < 1) await this.sendMissingFollowUp(job, { ...b, status }, [], { totalAsk, firmTotal: firmAsk !== null });
    // Partner's brain learns from every parsed reply; a brain failure never blocks the deal. Profiles are
    // shared across workspaces (until the brain is tenant-scoped), so only trustworthy readings teach
    // it: never an unverified sender, a keyword-fallback reading, or a simulated reply on a live job.
    const teaches = msg.sender_trusted === true && !heuristicReading(record) && !(job.mode === "live" && msg.simulated);
    if (teaches) try {
      const contractQuote = quoteRow ? toContractQuote(quoteRow, b, { budgetCents: job.budget_cents }) : null;
      await this.d.brain.learnFromReply(b.business_id, toParsedReply(x, contractQuote, questionIds), {
        job_id: job.id, business_id: b.business_id, business_name: b.name, business_email: b.email ?? `tel:${b.phone ?? ""}`, message_id: msg.id, thread_id: msg.thread_id ?? "",
        received_at: msg.created_at, rfq_sent_at: b.contacted_at ?? job.created_at, channel: kind === "quote.json" ? "quote.json" : kind === "pdf" ? "pdf" : kind === "a2a task" ? "a2a" : kind === "call transcript" ? "transcript" : "text", reply_channel: msg.channel,
        sender_trusted: msg.sender_trusted === true, sender_trust_reason: msg.trust_reason ?? "unknown", request: job.request, simulated: b.simulated,
      });
    } catch (err) {
      this.log("brain_learn_failed", { job_id: job.id, business_id: b.business_id, error: (err as Error).message });
    }
    await this.repo.touchJob(job.id);
  }

  /**
   * What the customer already told every business (the request) and answered on this deal: the only
   * facts Haggle may answer a business's question from. Never the budget, the cap or contact details.
   */
  private async questionFacts(job: JobRow): Promise<{ label: string; value: string }[]> {
    const r = job.request;
    const facts: { label: string; value: string }[] = [
      { label: "What", value: r.what },
      ...(r.quantity !== undefined ? [{ label: "Quantity", value: `${r.quantity}${r.unit ? ` ${r.unit}` : ""}` }] : []),
      ...(r.date ? [{ label: "Date", value: r.date }] : []),
      { label: "Location", value: r.area },
      ...(r.details ?? []).filter((d) => !/budget|price|cap|pay|card|phone|email/i.test(d.label)),
      ...r.requirements.map((x) => ({ label: x.hard ? "Must have" : "Preferred", value: x.text })),
    ];
    for (const q of await this.repo.listQuestions(job.id)) {
      if (q.status === "answered" && q.answer) facts.push({ label: `The customer's earlier answer to "${q.text.replace(/\s+/g, " ").slice(0, 160)}"`, value: q.answer.slice(0, 300) });
    }
    return facts;
  }

  /**
   * Answer what the request plainly answers (Claude decides, from the listed facts only), on the
   * business's own channel. Anything else (a preference nobody stated, a refusal, an error) is left
   * for the human: surfaceQuestions texts it with the other open questions.
   */
  private async answerFromRequest(job: JobRow, b: JobBusinessRow, asked: QuestionRow[]) {
    if (!this.d.extractor.answerQuestion || TERMINAL.has(job.state)) return;
    for (const q of asked) {
      try {
        const facts = await this.questionFacts(job);
        const raw = await this.d.extractor.answerQuestion({ business: b.name, question: q.text, facts });
        // Grounded or not at all: a time, number or detail that isn't in the request leaves the question for the human.
        const a = raw ? groundedAnswer(raw, facts, q.text) : null;
        if (raw && !a) this.log("auto_answer_ungrounded", { job_id: job.id, question_id: q.id });
        if (!a) continue;
        await this.answerSeller(job.id, q.id, a.answer);
        await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, kind: "question_auto_answered", question_id: q.id, summary: `Answered ${b.name}'s question from the request: "${a.answer.slice(0, 160)}" (from: ${a.basis.slice(0, 120)})`, channel: b.channel });
      } catch (err) {
        // Not sent (guard, channel, model): the human answers it instead.
        this.log("auto_answer_skipped", { job_id: job.id, question_id: q.id, error: (err as Error).message.slice(0, 200) });
      }
    }
  }

  /**
   * Text the human the open business questions together (one text, numbered, with how to reply),
   * once no other business is still to reply, the oldest unsent one has waited questionBatchMs, or
   * the quotes are final. The same list goes on the deal (wait_for_update / get_quotes) for the agent.
   * Collection never waits on it.
   */
  private async surfaceQuestions(job: JobRow) {
    if (TERMINAL.has(job.state)) return;
    const pending = (await this.repo.listQuestions(job.id)).filter((q) => q.status === "pending");
    if (!pending.length) return;
    const events = await this.repo.listEvents(job.id);
    const surfaced = new Set(events.filter((e) => e.type === "reply" && e.data.kind === "questions_surfaced").flatMap((e) => (Array.isArray(e.data.question_ids) ? e.data.question_ids.map(String) : [])));
    const fresh = pending.filter((q) => !surfaced.has(q.id));
    if (!fresh.length) return;
    const businesses = await this.repo.getBusinesses(job.id);
    const asking = new Set(pending.map((q) => q.business_id));
    const answered = answeredByQuote(await this.repo.listQuotes(job.id));
    const othersWaiting = businesses.some((x) => !asking.has(x.business_id) && ["pending", "contacted", "ringing", "replied"].includes(x.status) && (x.status === "ringing" || !answered.has(x.business_id)));
    const now = this.now().getTime();
    const oldest = Math.min(...fresh.map((q) => Date.parse(q.created_at)));
    const due = !othersWaiting || job.ready || now - oldest >= (this.d.config.questionBatchMs ?? DEFAULT_QUESTION_BATCH_MS) || now >= Date.parse(job.collect_until);
    if (!due) return;
    // One entry per business and question (a resent email asks the same thing twice).
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const groups: { business: string; business_id: string; text: string; ids: string[] }[] = [];
    for (const q of pending) {
      const name = businesses.find((x) => x.business_id === q.business_id)?.name ?? "A business";
      const g = groups.find((x) => x.business_id === q.business_id && norm(x.text) === norm(q.text));
      if (g) g.ids.push(q.id);
      else groups.push({ business: name, business_id: q.business_id, text: q.text.replace(/\s+/g, " ").trim(), ids: [q.id] });
    }
    const shown = groups.slice(0, 3);
    const quote = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
    // Fits one SMS (320 with the "Haggle: " prefix and the HG reference): the questions share what's left.
    const more = groups.length > shown.length ? ` (+${groups.length - shown.length} more on the deal board)` : "";
    const head = `${groups.length} questions from businesses${othersWaiting ? " (other quotes keep coming in)" : ""}: `;
    const tail = `${more} Reply with the number and your answer, e.g. "1: ... 2: ...".`;
    const frame = shown.map((g, i) => `${i + 1}) ${quote(g.business, 18)}: ""`).join(" ").length;
    const per = Math.max(30, Math.floor((300 - head.length - tail.length - frame) / shown.length));
    const text = groups.length === 1
      ? `${shown[0]!.business} asks: "${quote(shown[0]!.text, 180)}" Reply to this text to answer.`
      : `${head}${shown.map((g, i) => `${i + 1}) ${quote(g.business, 18)}: "${quote(g.text, per)}"`).join(" ")}${tail}`;
    await this.repo.appendEvent(job.id, "reply", {
      business_id: null, kind: "questions_surfaced", question_ids: pending.map((q) => q.id), numbers: shown.map((g) => g.ids),
      summary: `${groups.length} open question${groups.length === 1 ? "" : "s"} for the user: ${groups.map((g, i) => `${i + 1}) ${g.business}: "${quote(g.text, 120)}"`).join(" ")}. Ask the user, then answer_business for each; collection continues.`,
    });
    await this.notifyHuman(job, `questions:${createHash("sha256").update(pending.map((q) => q.id).join(",")).digest("hex").slice(0, 12)}`, text, shown[0]!.ids[0]);
  }

  /** The numbered question list Haggle texted this human last (for "1: ..., 2: ..." replies). */
  private async lastQuestionBatch(open: JobRow[], from: string): Promise<{ jobId: string; numbers: string[][]; at: string } | null> {
    let best: { jobId: string; numbers: string[][]; at: string } | null = null;
    for (const job of open) {
      if (from !== (await this.notifyTarget(job))) continue;
      const e = (await this.repo.listEvents(job.id)).filter((x) => x.type === "reply" && x.data.kind === "questions_surfaced").at(-1);
      if (!e || !Array.isArray(e.data.numbers)) continue;
      if (!best || e.at > best.at) best = { jobId: job.id, numbers: (e.data.numbers as unknown[]).map((g) => (Array.isArray(g) ? g.map(String) : [])), at: e.at };
    }
    return best;
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
   * cooldown say wait), or in its A2A context. Never switches channel. `totalAsk` (the exact, firm or
   * all-in total) is folded into the same message: one follow-up, never two.
   */
  private async sendMissingFollowUp(job: JobRow, b: JobBusinessRow, missingAnswers: string[], opts: { totalAsk?: string | null; firmTotal?: boolean } = {}) {
    const key = `followup:${job.id}:${b.business_id}:missing`;
    if (await this.repo.findMessageByIdempotencyKey(key)) return;
    if (!this.canReach(b)) return;
    const missing = opts.totalAsk ? [opts.totalAsk, ...missingAnswers] : missingAnswers;
    if (missing.length === 0) return;
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
        // Within the text limit: the asks are shortened, never the reference code; the total ask (last) stays whole.
        const text = HaggleEngine.confirmIMessageText(opts.totalAsk ? [...missingAnswers, opts.totalAsk] : missingAnswers, job.short_code);
        if (!(await this.sendIMessageToBusiness(job, b, "followup", key, text, null))) return;
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
      await this.repo.appendEvent(job.id, "reply", { business_id: b.business_id, summary: `Asked ${b.name} for: ${missing.join(", ")} (${how})`, channel: b.channel, ...(opts.firmTotal ? { asked: "firm_total" } : {}) });
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
      await this.repo.appendEvent(job.id, "approval_void", { approval_id: a.id, reason: "quote revised after approval", old_quote_id: old.id, old_total_usd: old.total_cents === null ? null : centsToUsd(old.total_cents) });
      // Never charge an obsolete quote: the job goes back to choosing; a fresh approval is required.
      const now = await this.repo.getJob(job.id);
      if (now && (now.state === "paying" || now.state === "awaiting_approval")) await this.fire(job.id, { type: "approval_void" });
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
        challenge_trusted: provesSenderIdentity(msg), challenge_thread_matched: threadMatched, pay_to: parsed.parsed.payTo, // a thread-only (reply token) sender never names a payee
      });
      if (updated) await this.repo.appendEvent(job.id, "payment", { status: "invoice_received" });
      return;
    }
    if (envelope.step === "receipt") {
      // NOT VERIFIED against a live receipt: accept only a trusted, in-thread receipt for our step with a tx hash.
      const p = envelope.payload ?? {};
      const tx = typeof p.settle_tx === "string" ? p.settle_tx : typeof p.transaction === "string" ? p.transaction : null;
      const ok = provesSenderIdentity(msg) && threadMatched && pay.status === "sent" && tx !== null && p.status !== "rejected";
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
      knownPayTo: null, existingPayment: null, spendCapCents: Math.min(job.payment_cap_cents, this.d.config.globalPaymentCapCents, (await this.getSettings(job.workspace_id)).spending_cap_cents), now: this.now(),
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
    if (pay && pay.approval_id === approval.id && pay.status === "charging" && !pay.reason?.startsWith("retryable:") && this.now().getTime() - Date.parse(pay.updated_at) < 60_000) return {};
    // Too old to resume under Stripe's idempotency window, failing over and over, or held for an
    // operator: not charged (workflow/deadLetter.ts decideChargeResume).
    if (pay && pay.approval_id === approval.id && pay.status === "charging" && (await this.holdCharge(job, approval, pay))) return {};
    // Resuming a charge Stripe hasn't seen yet: revalidate everything (the cap, the quote, the
    // approval may have changed while it sat). One that has a PaymentIntent is reconciled as is.
    if (pay && pay.approval_id === approval.id && pay.status === "charging" && !pay.stripe_payment_intent_id) {
      const v = await this.paymentVerdict(job, approval);
      if (!v.ok) {
        await this.repo.transitionPayment(pay.id, ["charging"], { status: "failed", reason: `refused:${v.code}` });
        await this.repo.appendEvent(jobId, "payment_refused", { code: v.code, approval_id: approval.id, resumed: true });
        return { refused: v.code };
      }
    }
    if (!pay || pay.approval_id !== approval.id) {
      if (!job.pay_intent) return {};
      // The workspace cap as it is now: lowering it after an approval still stops the charge.
      const verdict = await this.paymentVerdict(job, approval);
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
    if (!(await this.stillLeased(jobId))) return {}; // another instance has the job; it resumes this charge
    const r = await stripe.charge({
      amountCents: pay.amount_cents, idempotencyKey: pay.idempotency_key!,
      description: `Haggle deposit to ${b?.name ?? "business"} (job HG-${job.short_code})${stripe.simulated ? " [DEMO]" : " [TEST MODE]"}`,
      metadata: { job_id: jobId, approval_id: pay.approval_id, quote_id: approval.quote_id, business_id: pay.business_id, business: b?.name ?? "" },
    });
    if (r.ok) {
      const done = await this.repo.transitionPayment(pay.id, ["charging"], { status: "settled", stripe_payment_intent_id: r.paymentIntentId, reason: null });
      if (done) {
        await this.repo.transitionApproval(pay.approval_id, "approved", { status: "used" });
        await this.repo.appendEvent(jobId, "payment", { status: "settled", rail: "stripe", payment_intent_id: r.paymentIntentId, simulated: done.simulated, ...(r.receiptUrl ? { receipt_url: r.receiptUrl } : {}) });
      }
    } else if (r.retryable) {
      // Stays `charging` and marked resumable; the next advance retries with the same key.
      await this.repo.transitionPayment(pay.id, ["charging"], { reason: `retryable:${r.reason}`.slice(0, 200), ...(r.paymentIntentId ? { stripe_payment_intent_id: r.paymentIntentId } : {}) });
      await this.repo.appendEvent(jobId, "payment_retry", { payment_id: pay.id, reason: r.reason.slice(0, 120) }); // counted by holdCharge
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
    if (!job) throw new EngineError("job_not_found", `No job ${jobId}.`, "Use a job_id returned by deal or list_deals; call list_deals to find the deal the user means (a new request is a new deal).", "list_deals");
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

  /** Operator only (scripts/workspace-admin.ts): authorize a vendor contact for one workspace, recording the consent. */
  async addWorkspaceVendor(v: { workspace_id: string; contact: string; name: string; consent: string; added_by: string; channel?: Channel | null }) {
    const contact = v.contact.includes("@") ? normalizeAddress(v.contact) : v.contact.replace(/[\s().-]/g, "");
    if (!EMAIL_RE.test(contact) && !E164_RE.test(contact)) throw new EngineError("bad_contact", "A vendor contact is an email address or an E.164 phone number.", "Fix the contact.", "none");
    if (v.channel && (v.channel === "email") !== contact.includes("@")) throw new EngineError("bad_channel", `Channel ${v.channel} doesn't fit ${contact}.`, "Email for an address; phone (a call) or imessage (a text) for a number.", "none");
    if (v.consent.trim().length < 3) throw new EngineError("consent_required", "Record how the vendor agreed to be contacted.", "Pass the consent (who agreed, how, when).", "none");
    return this.repo.addWorkspaceVendor({ ...v, contact, consent: v.consent.trim() });
  }

  /** Operator only: withdraw a vendor's authorization for one workspace. */
  async removeWorkspaceVendor(workspaceId: string, contact: string) {
    return this.repo.removeWorkspaceVendor(workspaceId, contact.includes("@") ? normalizeAddress(contact) : contact.replace(/[\s().-]/g, ""));
  }

  /** May this workspace contact the business: every contact on the server allowlist or the workspace's vendors, none suppressed. */
  async mayContact(b: { email?: string | null; phone?: string | null; a2a_card_url?: string | null }, workspaceId: string): Promise<boolean> {
    const contacts = [b.email ? normalizeAddress(b.email) : null, b.phone?.replace(/[\s().-]/g, "") ?? null, b.a2a_card_url ?? null].filter((c): c is string => !!c);
    if (!contacts.length) return false;
    const ws = new Set((await this.repo.listWorkspaceVendors(workspaceId)).map((v) => v.contact));
    if ((await this.repo.findSuppressions(contacts)).length) return false;
    return contacts.every((c) => this.allowedRecipient(c) || ws.has(c.toLowerCase()));
  }

  /** Operator only (scripts/workspace-admin.ts): revoke a workspace, so its token and connector URL stop working. */
  async revokeWorkspace(id: string) {
    const w = await this.repo.setWorkspaceCredentials(id, { revoked: true });
    if (!w) throw new EngineError("workspace_not_found", `No workspace ${id}.`, "Check the workspace id.", "none");
    return w;
  }

  /** A workspace's suspension (scripts/workspace-admin.ts suspend; ops/operator.ts), or null: the MCP endpoint refuses tools while it is set. */
  async workspaceSuspension(id: string) {
    return workspaceSuspension(this.repo, id);
  }

  /** Operator only: new credential hashes for a workspace (clears a revocation). */
  async rotateWorkspaceCredentials(id: string, tokenHash: string, connectorSecretHash: string) {
    const w = await this.repo.setWorkspaceCredentials(id, { token_hash: tokenHash, connector_secret_hash: connectorSecretHash, revoked: false });
    if (!w) throw new EngineError("workspace_not_found", `No workspace ${id}.`, "Check the workspace id.", "none");
    return w;
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
    // Then what an advance can't fix by itself: stale claims, unsent confirmations, replies to
    // closed deals, jobs overdue past their deadline (workflow/recovery.ts). At most every 2 minutes.
    if (this.now().getTime() - this.recoveredAt >= RECOVERY_SWEEP_MS) {
      this.recoveredAt = this.now().getTime();
      await this.recoverStuck({ advanceOpen: false }).catch((e) => this.log("recovery_failed", { error: redactError(e) }));
    }
    return { advanced, failed };
  }

  private recoveredAt = 0;

  /**
   * Long-poll. `until` (from haggle-testing wait_for_request): any_change (default) returns on the
   * next event; ready when quotes are final (or the job ends); approval_decided when no approval is
   * waiting on the human any more; done when the job is finished.
   */
  async waitForUpdate(jobId: string, cursor: number, timeoutMs: number, signal?: AbortSignal, until: WaitUntil = "any_change"): Promise<WaitResult> {
    await this.loadJob(jobId);
    // A cursor past this job's last event (another deal's, or made up) would hide every update: start over.
    const head = (await this.repo.listEvents(jobId)).at(-1)?.seq ?? 0;
    const reset = !Number.isFinite(cursor) || cursor < 0 || cursor > head;
    if (reset) cursor = 0;
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 60_000); // wall-clock: a wait timeout is real time
    for (;;) {
      await this.d.onTick?.();
      await this.advanceForRead(jobId);
      const events = await this.repo.listEvents(jobId, cursor);
      const job = (await this.repo.getJob(jobId))!;
      const done = TERMINAL.has(job.state);
      const met = until === "any_change" ? events.length > 0 : until === "ready" ? job.ready || job.state !== "collecting" && job.state !== "negotiating" && job.state !== "contacting" && job.state !== "created"
        : until === "approval_decided" ? job.state !== "awaiting_approval" : done;
      if (met || done || Date.now() >= deadline || signal?.aborted) {
        const updates = events.map(toUpdate).filter((u): u is JobUpdate => u !== null);
        const newCursor = events.length ? events[events.length - 1]!.seq : cursor;
        const hint = await this.nextHint(job);
        return { ok: true, mode: job.mode, job_id: jobId, state: job.state, cursor: String(newCursor), updates, timed_out: !met && !done, next: reset ? `The cursor you passed isn't from this deal, so these are all of its updates from the start; use this cursor from now on. ${hint}` : hint };
      }
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, deadline - Date.now()))));
    }
  }

  private async nextHint(job: JobRow): Promise<string> {
    const pending = (await this.repo.listQuestions(job.id)).filter((q) => q.status === "pending");
    const purchase = job.state === "paying" || job.state === "paid" ? await this.purchaseFor(job) : null;
    if (purchase) return `${purchase.summary} Next: ${purchase.next}`;
    if (TERMINAL.has(job.state)) return job.state === "paid" ? "Done. get_quotes shows the receipt." : job.state === "confirmed" ? "Done: the business was told to go ahead (nothing was paid)." : `Job ${job.state}${job.failure_reason ? ` (${job.failure_reason})` : ""}.`;
    const latest = job.state === "awaiting_approval" ? await this.repo.getLatestApproval(job.id) : null;
    const suggestion = latest?.status === "pending" && (await this.isAutoApproval(job.id, latest.id)) ? latest : null;
    if (pending.length && (job.state !== "awaiting_approval" || suggestion) && job.state !== "paying") {
      const n = pending.length;
      const after = suggestion ? `Quotes are final otherwise: Haggle texted the user its recommendation (quote_id ${suggestion.quote_id}; a reply YES <code> approves it, ${this.afterYes()}); approve(job_id, quote_id) for another quote the user picks replaces it.`
        : job.ready ? "Quotes are final otherwise: get_quotes, then approve(job_id, quote_id) for its recommended_quote_id." : "The other businesses keep quoting; call wait_for_update.";
      const texted = this.d.sms && (await this.notifyTarget(job)) ? " Haggle texts the user these questions and sends their reply to each business, so you can simply leave them." : " Ask the user.";
      return `${n} business question${n === 1 ? "" : "s"} Haggle couldn't answer from the request (open_questions in get_quotes). Answer one with answer_business(job_id, question_id='${pending[0]!.id}', answer) only from the request or what the user told you; never guess a time, an entrance, set-up/serving or any preference.${texted} ${after}`;
    }
    if (job.state === "awaiting_approval") {
      if (suggestion) {
        return `Quotes are final. Haggle texted the user its recommendation (quote_id ${suggestion.quote_id}; their reply YES <code> approves it; ${this.manualPayments ? "then the business confirms the booking and the human pays them directly; Haggle charges nothing" : "nothing is charged until they text PAY <code> or you call pay"}). Tell the user they can reply to that text or choose any option on the deal board. To approve a different quote the user picked, call approve(job_id, quote_id): it replaces the texted suggestion. Call wait_for_update with until=approval_decided.`;
      }
      return "Waiting for the human to approve (a text reply YES <code>, an email reply APPROVE <code>, the approval card or form, whichever they got). Call wait_for_update with until=approval_decided; once approved, call pay(job_id, quote_id).";
    }
    if (job.state === "paying") {
      if (!this.d.stripe && this.d.payer.disabledReason) return "Approved. Payments are off on this server, so nothing can be charged yet; tell the user. The approval stays valid until it expires.";
      const p = await this.repo.getPaymentForJob(job.id);
      if (p && ["charging", "signed", "sent", "awaiting_invoice", "invoice_received"].includes(p.status)) return "Payment in progress. Call wait_for_update.";
      if (p && ["failed", "rejected", "expired"].includes(p.status)) return `The payment didn't go through (${p.reason ?? p.status}); see get_quotes. Call pay(job_id, quote_id) to retry.`;
      // Approve, then pay (decision 2): the human's approval charged nothing; pay is the real charge.
      return "Approved by the human. Call pay(job_id, quote_id) to charge the approved amount (the deposit, or the full total when no deposit was stated); if the human approved by text, their texted PAY <code> charges it too (one charge either way).";
    }
    if (job.ready) return "Quotes are final. Call get_quotes, then approve(job_id, quote_id) for its recommended_quote_id (the best quote the human can approve).";
    if (job.state === "negotiating") {
      const { waiting } = await this.awaitingCounterAnswers(job, await this.repo.getBusinesses(job.id), await this.repo.listEvents(job.id));
      const by = `${new Date(job.collect_until).toISOString().slice(11, 16)} UTC`;
      const who = waiting.length ? `waiting for ${waiting.map((b) => b.name).join(", ")} to answer the counteroffer` : "counteroffers answered";
      return `Negotiating round ${job.round}: ${who}; quotes are final when every countered business has answered or at ${by}, whichever is first (Haggle then texts the user the recommendation). The user may already approve any current quote (approve). Call wait_for_update.`;
    }
    if (job.state === "collecting") {
      const waiting = await this.collectionWaiting(job, await this.repo.getBusinesses(job.id));
      const by = `${new Date(job.collect_until).toISOString().slice(11, 16)} UTC`;
      if (waiting.length) return `Still collecting: waiting for ${waiting.map((b) => b.name).join(", ")}; quotes close as soon as every business has answered, at ${by} at the latest. Call wait_for_update(job_id) again with the latest cursor you have (wait_for_update returns one).`;
    }
    return "Still collecting. Call wait_for_update(job_id) again with the latest cursor you have (wait_for_update returns one).";
  }

  /**
   * The deal board read model (get_quotes / open_haggle): every contacted business with its channel,
   * live status and latest event; every current quote with eligibility and the reason it can't win;
   * negotiation history; open questions; approval and payment. Superset of the v3 QuotesResult.
   */
  async getQuotes(jobId: string): Promise<DealBoardData> {
    await this.advanceForRead(jobId);
    const job = await this.loadJob(jobId);
    // One read of each table, in parallel, shared by every part of the board (each read is a database
    // round trip in live mode).
    const [businesses, all, approval, payment, events, questionRows, messages] = await Promise.all([
      this.repo.getBusinesses(jobId), this.repo.listQuotes(jobId), this.repo.getLatestApproval(jobId), this.repo.getPaymentForJob(jobId), this.repo.listEvents(jobId), this.repo.listQuestions(jobId), this.repo.listMessages(jobId),
    ]);
    const byId = new Map(businesses.map((b) => [b.business_id, b]));
    const { quotes, ranking, capCents } = await this.rankRows(job, all);
    const order = new Map(ranking.ranked.map((r, i) => [r.quoteId, i]));
    const rejectedBy = new Map(ranking.rejected.map((r) => [r.quoteId, r.reason]));
    const sorted = [...quotes].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || (a.total_cents ?? 1e12) - (b.total_cents ?? 1e12));
    // The brain's price check for every priced quote, in parallel (optional: a failure shows none).
    const priceChecks = await Promise.all(sorted.map(async (q): Promise<Quote["price_check"]> => {
      if (q.total_cents === null) return undefined;
      try {
        const v = await this.d.brain.checkPrice({ business_id: q.business_id, request: { what: job.request.what, quantity: job.request.quantity, area: job.request.area, date: job.request.date }, total_usd: centsToUsd(q.total_cents) });
        return v.verdict !== "unknown" ? v.verdict : undefined;
      } catch { return undefined; /* brain optional */ }
    }));
    const out: BoardQuote[] = [];
    const unknownOnly = new Map<string, { met: boolean | null }[]>();
    const askedFirm = new Set(events.filter((e) => e.type === "reply" && e.data.asked === "firm_total").map((e) => String(e.data.business_id)));
    for (const [i, q] of sorted.entries()) {
      const b = byId.get(q.business_id)!;
      // "Negotiated from" only from this business's own earlier firm figure (an estimate was never a price).
      const prev = all.filter((x) => x.business_id === q.business_id && x.id !== q.id && x.total_cents !== null).sort((x, y) => y.round - x.round || y.created_at.localeCompare(x.created_at))[0];
      const prevFirm = prev && !isApproximate(prev.record) ? prev : undefined;
      const price_check = priceChecks[i];
      const cq = toContractQuote(q, b, { budgetCents: job.budget_cents, ...(prevFirm?.total_cents != null && prevFirm.total_cents !== q.total_cents ? { negotiatedFromCents: prevFirm.total_cents } : {}), ...(price_check ? { price_check } : {}) });
      const reason = rejectedBy.get(q.id);
      const hard = this.approvability(job, q).hard;
      const block = this.approvalBlock(job, q, b, askedFirm.has(q.business_id));
      const { ask } = askInfo(job.request);
      const fields = ask.length ? Object.fromEntries(ask.map((f) => { const v = q.record.fields?.[f.key] ?? null; return [f.key, f.type === "money" && typeof v === "number" ? centsToUsd(v) : v]; })) : undefined;
      const missingFields = ask.filter((f) => f.required && (q.record.fields?.[f.key] ?? null) === null).map((f) => f.label);
      out.push({
        ...cq, total_usd: q.total_cents === null ? null : cq.total_usd, channel: b.channel, eligible: order.has(q.id),
        // "rejected" only for safety (or a business that declined); every other gap is "incomplete" (flagged, still approvable).
        // Soft preferences (decision 1): a ranked quote that misses one is "incomplete", never "rejected";
        // "rejected" is only for an unsafe quote or one that declined. approvable/approval_block say whether it can be approved now.
        verdict: order.has(q.id) ? (ranking.caveats.some((c) => c.quoteId === q.id) ? "incomplete" : "compliant")
          : hard && !["no_total", "zero_total", "total_not_firm", "missing_info", "all_in_unknown"].includes(hard) ? "rejected" : "incomplete",
        ...(reason ? { excluded_reason: excludedText(reason, cq.requirement_results) } : {}),
        ...(isApproximate(q.record) ? { total_approximate: true as const } : {}),
        approvable: block === null, ...(block ? { approval_block: block } : {}),
        ...(fields ? { fields, missing_fields: missingFields } : {}),
        compliance: this.complianceOf(job, q, capCents), freshness: this.freshnessOf(q, events),
      });
      if (reason) unknownOnly.set(q.id, cq.requirement_results);
    }
    const questions = questionRows.filter((q) => q.status === "pending");
    const lastEvent = new Map<string, string>();
    const transcripts = new Map<string, string>();
    for (const e of events) {
      const bid = typeof e.data.business_id === "string" ? e.data.business_id : null;
      if (!bid) continue;
      const summary = e.type === "quote" ? (e.data.total_usd == null ? "Replied without a total" : `Quoted $${Number(e.data.total_usd).toLocaleString("en-US")} (round ${e.data.round})`)
        : e.type === "question" ? `Asked: ${String(e.data.text).slice(0, 120)}` : e.type === "flag" ? (typeof e.data.board_line === "string" ? e.data.board_line : `Flagged: ${String(e.data.flag).replace(/_/g, " ")}`)
        : e.type === "reply" ? String(e.data.summary ?? "") : null;
      if (summary) lastEvent.set(bid, summary);
      if (typeof e.data.transcript_snippet === "string" && e.data.transcript_snippet) transcripts.set(bid, e.data.transcript_snippet);
    }
    // "won" only once paid; an approved, unpaid quote is shown as chosen on its quote row instead.
    const wonBusiness = job.state === "paid" && payment ? payment.business_id : null;
    // A business whose latest trusted reply couldn't be read (and that has no quote): say so, plainly.
    const unreadable = this.unreadableReplies(messages, all);
    const answered = answeredByQuote(all);
    const board: BoardBusiness[] = businesses.map((b) => {
      const transcript = transcripts.get(b.business_id);
      return {
        id: b.business_id, business_id: b.business_id, name: b.name, business: b.name, channel: b.channel, status: this.boardStatus(b, job, wonBusiness, all, answered), engine_status: b.status,
        simulated: b.simulated, last_event: unreadable.has(b.business_id) ? UNREADABLE_REPLY : lastEvent.get(b.business_id) ?? null, ...(transcript ? { transcript_snippet: transcript } : {}),
        ...(b.status === "unavailable" ? { unavailable_reason: this.route(b).reason } : {}),
      };
    });
    const sentKeys = new Set(messages.filter((m) => m.direction === "out" && m.idempotency_key).map((m) => m.idempotency_key!));
    const negotiation: NegotiationStep[] = events.filter((e) => e.type === "counteroffer").map((e) => {
      const bid = String(e.data.business_id);
      // Live-demo's detection (decision 16): a quote's round is the countered round, so the answer is
      // the business's first quote of that round or later; main's basis_approximate is kept.
      const round = Number(e.data.round);
      const answer = all.filter((q) => q.business_id === bid && q.round >= round).sort((x, y) => x.round - y.round || y.created_at.localeCompare(x.created_at))[0];
      const before = all.filter((q) => q.business_id === bid && q.round < round && q.total_cents !== null).sort((x, y) => y.round - x.round || y.created_at.localeCompare(x.created_at))[0];
      const counterKey = sendKeys.counter(jobId, bid, round);
      const key = sentKeys.has(counterKey) ? null : counterKey;
      const scheduled = key ? events.find((x) => x.type === "call_scheduled" && x.data.key === key) : undefined;
      const b = byId.get(bid);
      return {
        business_id: bid, business: b?.name ?? bid, round, target_total_usd: Number(e.data.target_total_usd), basis_quote_id: String(e.data.basis_quote_id),
        ...(e.data.basis_approximate === true ? { basis_approximate: true } : {}), outcome_total_usd: answer?.total_cents == null ? null : centsToUsd(answer.total_cents),
        ...(b ? { channel: b.channel } : {}), ...(scheduled && !answer ? { scheduled_for: String(scheduled.data.at) } : {}), ...(before ? { from_total_usd: centsToUsd(before.total_cents!) } : {}),
      };
    });
    const openQuestions = questions.map((q) => ({ question_id: q.id, business_id: q.business_id, business: byId.get(q.business_id)?.name ?? q.business_id, text: q.text }));
    // Excluded = its current quote can't win (the same ranking rejections the card shows as "Can't win"),
    // except a requirement the business simply hasn't confirmed yet. Over a soft target never rejects.
    const excludedBiz = new Set(out.filter((q) => {
      const reason = rejectedBy.get(q.quote_id);
      if (q.status !== "current" || !reason || reason === "not_current") return false;
      const res = unknownOnly.get(q.quote_id) ?? [];
      return !(reason === "requirement_unmet" && res.some((x) => x.met === null) && !res.some((x) => x.met === false));
    }).map((q) => q.business_id));
    // Asked a follow-up (the batched one) and no reply since: the board says "clarifying" while it's "quoted".
    const msgsAll = messages;
    const lastAt = (id: string, pred: (m: MessageRow) => boolean) => msgsAll.filter((m) => m.business_id === id && pred(m)).reduce((a, m) => (m.created_at > a ? m.created_at : a), "");
    const clarifying = new Set(businesses.filter((b) => { const f = lastAt(b.business_id, (m) => m.direction === "out" && m.kind === "followup"); return f !== "" && f > lastAt(b.business_id, (m) => m.direction === "in" && m.kind === "reply"); }).map((b) => b.business_id));
    const stages = this.stages(job, businesses, all, negotiation, questions.map((q) => q.business_id), approval, excludedBiz, unreadable, clarifying);
    // Best value among the eligible (safe, priced) quotes, in soft-preference tiers: deterministic and explained.
    const value = await this.valueRanking(job, quotes.filter((q) => order.has(q.id) && q.total_cents !== null), all, byId, ranking.caveats);
    const valueOrder = new Map(value.ranked.map((r, i) => [r.quoteId, i]));
    out.sort((a, b) => (valueOrder.get(a.quote_id) ?? 1e6 + (order.get(a.quote_id) ?? 1e6)) - (valueOrder.get(b.quote_id) ?? 1e6 + (order.get(b.quote_id) ?? 1e6)));
    // Recommend only what the human can actually approve: the best-value quote that passes every hard
    // rule and the per-payment ceiling. A better-value quote that can't be approved stays on the board
    // with its reason; nothing is dropped silently, and the ceiling is never weakened.
    // Per-business contact status (inbound/contactStatus.ts) from the rows already read; only the ones
    // the agent must act on or explain are listed (bounced, failed, opted out, held reply, deferred).
    const contactRows = businesses.flatMap((b) => [b.email ? normalizeAddress(b.email) : null, b.phone].filter((c): c is string => !!c));
    const contactSuppressions = contactRows.length ? await this.repo.findSuppressions(contactRows) : [];
    const vendorContact = Object.fromEntries(businesses.map((business) => contactStatusOf({ business, messages, suppressions: contactSuppressions, events }))
      .filter((c) => NOTABLE_CONTACT.has(c.contact_status))
      .map((c) => [c.business_id, { status: c.contact_status as BusinessContactStatus["contact_status"] | ExclusionStatus, detail: c.line, ...(c.next_contact_at ? { next_contact_at: c.next_contact_at } : {}) }]));
    // Every other contacted vendor that isn't compared says why, in plain words (ranking/exclusion.ts).
    const pricedNow = new Set(quotes.filter((q) => q.total_cents !== null && q.record.available).map((q) => q.business_id));
    const quotesFinal = job.ready || !["created", "contacting", "collecting", "negotiating"].includes(job.state);
    for (const b of businesses) {
      if (vendorContact[b.business_id]) continue;
      const x = exclusionOf({
        name: b.name, channel: b.channel, compared: pricedNow.has(b.business_id), declined: b.status === "declined" || quotes.some((q) => q.business_id === b.business_id && !q.record.available),
        unreachable: b.status === "unavailable" ? this.route(b).reason ?? "no usable channel" : null, question: questions.find((q) => q.business_id === b.business_id)?.text ?? null,
        unreadable: unreadable.has(b.business_id), quotesFinal, replied: !!b.last_reply_at,
      });
      if (x) vendorContact[b.business_id] = { status: x.status, detail: x.detail };
    }
    const notCompared = exclusionLine(businesses.filter((b) => vendorContact[b.business_id] && !pricedNow.has(b.business_id)).map((b) => ({ name: b.name, status: vendorContact[b.business_id]!.status })));
    const boardById = new Map(out.map((q) => [q.quote_id, q]));
    // A request compared on a non-money answer (earliest date) recommends in the ranker's compare_by order.
    const recommendOrder = nonMoneyCompare(job.request) ? ranking.ranked.map((r) => r.quoteId) : value.ranked.map((r) => r.quoteId);
    // ...and that misses no must: a quote with an unmet or unconfirmed requirement, over the budget or
    // with a pay-now amount over the cap never wins by default (best_available names the closest one).
    // ...and never a stale real quote (it is re-confirmed with the business before any approval).
    const fresh = (q: BoardQuote) => !q.freshness?.stale || byId.get(q.business_id)?.simulated === true;
    const recommended = recommendOrder.map((id) => boardById.get(id)).find((q) => q?.approvable && q.compliance?.status === "compliant" && fresh(q)) ?? null;
    const bestAvailable = recommended ? null : recommendOrder.map((id) => boardById.get(id)).find((q) => q?.approvable) ?? null;
    const bestValue = nonMoneyCompare(job.request) ? recommended : value.recommendedQuoteId ? boardById.get(value.recommendedQuoteId) ?? null : null;
    // Current quotes held back by a rule the human can act on (the per-payment ceiling, a missing total):
    // named with their fix, so a cheaper option isn't hidden just because it can't be approved as is.
    // Unsafe or rejected quotes stay out.
    const fixable = out.filter((q) => q.status === "current" && !q.approvable && q.approval_block && q.approval_block.code !== "quote_not_eligible" && q.verdict !== "rejected");
    const fixableLine = fixable.length ? ` Also, not approvable yet: ${fixable.map((q) => `${q.business}${q.total_usd === null ? "" : ` $${q.total_usd}`} (${q.approval_block!.reason})`).join("; ")}` : "";
    const recommendation_note = bestAvailable
      ? `No quote meets every requirement, so Haggle recommends none. Closest: ${bestAvailable.business} (${complianceSummary(bestAvailable.compliance!)}). The human may still approve any option knowingly; the caveats go with the approval.${fixableLine}`
      : bestValue && bestValue !== recommended
      ? `Best value is ${bestValue.business} but it can't be approved yet: ${bestValue.approval_block?.reason ?? (bestValue.compliance?.status !== "compliant" ? complianceSummary(bestValue.compliance!) : "not approvable")}${recommended ? ` Recommended instead: ${recommended.business}, the best quote that can be approved and meets every requirement.` : " No quote can be approved yet."}`
      : undefined;
    // Why each quote was selected or can't be (ranking/selection.ts): one line per quote for the agent and the board.
    for (const q of out) {
      q.selection = selectionOf({
        current: q.status === "current", rejected: q.verdict === "rejected" ? (q.excluded_reason ?? "unsafe or declined") : null, approvalBlock: q.approval_block ?? null, compliance: q.compliance ?? null,
        freshness: byId.get(q.business_id)?.simulated ? null : q.freshness ?? null, recommended: recommended?.quote_id === q.quote_id, recommendedBusiness: recommended?.business ?? null,
      });
    }
    const pendingQuestions = questions.length > 0;
    const finalNext = job.ready && !TERMINAL.has(job.state) && (job.state === "collecting" || job.state === "negotiating") && !pendingQuestions;
    // The slower parts (cross-job contact learning, callback evidence, the next hint) run together.
    const [contactLearning, callbacks, hint, paymentOut] = await Promise.all([
      Promise.all(businesses.map(async (b) => [b.business_id, await this.contactLearning(b.business_id, await this.businessAliases(b)).catch(() => ({ channels: {} }))] as const)),
      this.callbackProposals(jobId),
      finalNext ? Promise.resolve("") : this.nextHint(job),
      payment ? this.withReceipt(jobId, paymentStatus(payment), events) : this.handoffFor(job, events),
    ]);
    const purchase = payment ? null : await this.purchaseFor(job, events);
    const next = finalNext
      ? recommended
        ? `Quotes are final. Call approve(job_id, quote_id='${recommended.quote_id}') for ${recommended.business}, the recommended quote the human can approve${recommendation_note ? ` (${bestValue!.business} is better value but blocked: ${bestValue!.approval_block?.code})` : ""}.`
        : bestAvailable
        ? `Quotes are final, but none meets every requirement, so Haggle recommends none: ${out.filter((q) => q.approvable && q.status === "current").map((q) => `${q.business} ${q.total_usd === null ? "" : `$${q.total_usd}`} (${complianceSummary(q.compliance!)})`).join("; ").slice(0, 600)}. Tell the user and ask which, if any, to approve knowingly (approve(job_id, quote_id) shows the human these caveats); don't pick one for them.${fixableLine.slice(0, 400)}`
        : `Quotes are final, but none can be approved yet: ${out.filter((q) => q.approval_block && q.status === "current").map((q) => `${q.business}: ${q.approval_block!.reason}`).join(" ").slice(0, 600) || "no priced quote"}. Tell the user; they may ask a business for a firm total or a smaller deposit.`
      : hint;
    return {
      ok: true, mode: job.mode, job_id: jobId, state: job.state,
      job: { id: job.id, request: job.request, state: job.state, budget_usd: job.budget_cents === null ? null : centsToUsd(job.budget_cents), created_at: job.created_at, updated_at: job.updated_at },
      quotes: out,
      ...(recommended ? { recommended_quote_id: recommended.quote_id } : {}),
      ...(bestValue && bestValue !== recommended ? { best_value_quote_id: bestValue.quote_id } : {}),
      ...(bestAvailable ? { best_available_quote_id: bestAvailable.quote_id } : {}),
      ...(recommendation_note ? { recommendation_note } : {}),
      ...(value.ranked.length ? { value } : {}),
      stages,
      contact_learning: Object.fromEntries(contactLearning),
      terms: Object.fromEntries(quotes.filter((q) => q.record.terms || q.record.other_fees?.length).map((q) => [q.id, {
        ...(q.record.other_fees?.length ? { fees: q.record.other_fees.map((f) => ({ label: f.label, ...(f.amount_cents !== null ? { amount_usd: centsToUsd(f.amount_cents) } : {}), included: f.included_in_total, excerpt: f.excerpt })) } : {}),
        ...(q.record.terms ?? {}),
      }])),
      callbacks,
      rejected: ranking.rejected.map((r) => {
        const res = unknownOnly.get(r.quoteId) ?? [];
        const unconfirmed = r.reason === "requirement_unmet" && res.some((x) => x.met === null) && !res.some((x) => x.met === false);
        return { business_id: r.businessId, quote_id: r.quoteId, reason: unconfirmed ? "requirement_unknown" as const : rejectToFlag(r.reason), detail: excludedText(r.reason, res) };
      }),
      open_questions: openQuestions,
      pending_questions: openQuestions,
      negotiation,
      business_names: Object.fromEntries(businesses.map((b) => [b.business_id, b.name])),
      businesses: board,
      ...(Object.keys(vendorContact).length ? { vendor_contact: vendorContact } : {}),
      approval: approval ? { ...approvalRecord(approval, job), ...(approval.status === "pending" && isAutoIn(events, approval.id) ? { replaceable: true } : {}) } : null,
      payment: paymentOut ?? (job.state === "awaiting_approval" ? this.noPayment() : null),
      ...(purchase ? { purchase } : {}),
      ready: job.ready, inbox: job.inbox, request: job.request, budget_usd: job.budget_cents === null ? null : centsToUsd(job.budget_cents),
      payment_ceiling_usd: centsToUsd(Math.min(job.payment_cap_cents, this.d.config.globalPaymentCapCents)),
      payments_enabled: this.paymentsEnabled,
      next: notCompared && job.ready && ["collecting", "negotiating", "awaiting_approval"].includes(job.state) ? `${next} ${notCompared}` : next,
    };
  }

  /**
   * Where each business is in the deal, in words the board and agents can use (the shared status enum
   * is coarser): waiting, responded, clarifying, quoted, countered, revised, held firm, final, …, plus
   * the negotiation outcome so a counteroffer is never mistaken for an accepted price.
   */
  /** Businesses whose latest trusted inbound reply failed to parse and that have no quote on this job. */
  private unreadableReplies(messages: MessageRow[], quotes: QuoteRow[]): Set<string> {
    const latest = new Map<string, MessageRow>();
    for (const m of messages) {
      if (m.direction !== "in" || m.kind !== "reply" || m.sender_trusted !== true || !m.business_id) continue;
      if (m.parse_status === "none") continue; // nothing to read (e.g. a call that reached voicemail)
      const cur = latest.get(m.business_id);
      if (!cur || m.created_at >= cur.created_at) latest.set(m.business_id, m);
    }
    const quoted = new Set(quotes.map((q) => q.business_id));
    return new Set([...latest].filter(([bid, m]) => m.parse_status === "failed" && !quoted.has(bid)).map(([bid]) => bid));
  }

  private stages(job: JobRow, businesses: JobBusinessRow[], all: QuoteRow[], negotiation: NegotiationStep[], questionFrom: string[], approval: ApprovalRow | null, excluded: Set<string> = new Set(), unreadable: Set<string> = new Set(), clarifying: Set<string> = new Set()): Record<string, BusinessStage> {
    const out: Record<string, BusinessStage> = {};
    for (const b of businesses) {
      const mine = all.filter((q) => q.business_id === b.business_id && q.total_cents !== null).sort((x, y) => x.round - y.round);
      const current = mine.at(-1);
      const first = mine[0];
      const firstFirm = mine.find((q) => !isApproximate(q.record));
      const steps = negotiation.filter((n) => n.business_id === b.business_id).sort((x, y) => x.round - y.round);
      const last = steps.at(-1);
      let negotiationState: BusinessStage["negotiation"] = "none";
      if (last && last.outcome_total_usd === null) negotiationState = "countered";
      // Revised or held firm is measured against the business's first FIRM price: "about $1,300" followed
      // by a firm $1,250 is a clarification, and holding at $1,250 after a counter is holding firm.
      else if (last && firstFirm?.total_cents != null && last.outcome_total_usd !== null) negotiationState = last.outcome_total_usd < centsToUsd(firstFirm.total_cents) ? "vendor_revised" : "held_firm";
      const approved = approval && ["approved", "used"].includes(approval.status) && approval.business_id === b.business_id;
      const stage: BusinessStage["stage"] =
        job.state === "paid" && approved ? "paid"
        : approved ? "buyer_approved"
        : b.status === "pending" ? "sending"
        : b.status === "ringing" ? "calling"
        : b.status === "declined" ? "declined"
        : b.status === "bounced" || b.status === "unavailable" ? "unreachable"
        : unreadable.has(b.business_id) && !current ? "reply_unreadable"
        : b.status === "silent" || b.status === "no_reply" ? "no_reply"
        : questionFrom.includes(b.business_id) || b.status === "question" ? "asked_question"
        : negotiationState === "countered" ? "countered"
        : (b.status === "replied" || clarifying.has(b.business_id)) && current ? "clarifying"
        : b.status === "replied" ? "responded"
        // Shown "quoted" at once (decision 12) but with no total yet: it answered, without a price to compare.
        : b.status === "quoted" && !current ? "responded"
        : current && excluded.has(b.business_id) ? "excluded"
        : current ? (negotiationState === "vendor_revised" ? "vendor_revised" : negotiationState === "held_firm" ? "held_firm" : job.ready ? "final" : "quoted")
        : job.ready && b.status === "contacted" ? "no_reply" // the deadline passed without an answer
        : "waiting";
      out[b.business_id] = {
        stage, negotiation: negotiationState,
        ...((firstFirm ?? first)?.total_cents != null ? { first_total_usd: centsToUsd((firstFirm ?? first)!.total_cents!) } : {}),
        ...(current?.total_cents != null ? { current_total_usd: centsToUsd(current.total_cents), quote_version: current.round } : {}),
        // Savings only against this business's own earlier firm figure (an estimate was never a price).
        ...(firstFirm?.total_cents != null && current?.total_cents != null && current.total_cents < firstFirm.total_cents ? { saved_usd: centsToUsd(firstFirm.total_cents - current.total_cents) } : {}),
      };
    }
    return out;
  }

  private boardStatus(b: JobBusinessRow, job: JobRow, wonBusiness: string | null, quotes: QuoteRow[], answered: Set<string>): BoardStatus {
    if (wonBusiness === b.business_id) return "won";
    if (b.status === "ringing") return "ringing";
    // A current priced quote is the fact: the business quoted, whatever its status row says (a
    // stale write, a follow-up call that went unanswered, a later message that bounced).
    if (b.status === "quoted" || answered.has(b.business_id)) {
      const latest = Math.max(0, ...quotes.filter((q) => q.business_id === b.business_id).map((q) => q.round));
      return job.state === "negotiating" && b.countered_round > 0 && latest < b.countered_round ? "negotiating" : "quoted";
    }
    switch (b.status) {
      case "declined": case "bounced": return "declined";
      case "silent": case "no_reply": return "no_reply";
      case "unavailable": return "unavailable";
      // Once quotes are final, a business that never answered is "no reply", not still "contacted".
      case "contacted": return job.ready && !quotes.some((q) => q.business_id === b.business_id) ? "no_reply" : "contacted";
      default: return "contacted"; // pending (sending now), replied, question
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
    await this.refuseIfOptedOut(job, b);
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
    // The same business asking the same thing again (a resent email) is covered by this one answer;
    // its other questions stay open for their own answers.
    const same = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const other of await this.repo.listQuestions(jobId)) if (other.status === "pending" && other.business_id === q.business_id && same(other.text) === same(q.text)) await this.repo.answerQuestion(other.id, text);
    // A business that already quoted stays "quoted" (its revision is a new quote); otherwise Haggle waits for its quote again.
    await this.repo.updateBusiness(jobId, b.business_id, { status: b.channel === "phone" && m ? "ringing" : b.status === "quoted" ? "quoted" : "contacted" });
    {
      // Keep the window open long enough for the business to quote after the answer.
      const grace = this.d.config.replyGraceMs ?? Math.min(this.d.config.collectionWindowMs, 15 * 60_000);
      const until = new Date(this.now().getTime() + grace).toISOString();
      const fresh = await this.repo.getJob(jobId);
      if (fresh && !fresh.ready && ["collecting", "negotiating"].includes(fresh.state) && fresh.collect_until < until) await this.repo.touchJob(jobId, { collect_until: until });
    }
    await this.repo.appendEvent(jobId, "reply", { business_id: b.business_id, summary: `Answered ${b.name}'s question (${b.channel === "phone" ? (scheduledFor ? "call, scheduled" : "call") : b.channel === "imessage" ? "text" : b.channel})`, channel: b.channel });
    await this.repo.touchJob(jobId);
    return {
      ok: true as const, mode: job.mode, question_id: q.id, sent: !scheduledFor, ...(scheduledFor ? { scheduled_for: scheduledFor } : {}), ...(m?.id ? { message_id: m.id } : {}),
      next: scheduledFor ? `The answer goes to ${b.name} on a call at ${scheduledFor} (call hours or a recent call). Call wait_for_update.` : "Call wait_for_update for their quote.",
    };
  }

  /**
   * A business that asked not to be contacted (a STOP on this deal, verified or not, or an opt-out
   * suppression of any of its contacts) gets no agent-written message on any channel: an email STOP
   * suppresses only the address, never permission to call or text instead (S5-D F10).
   */
  private async optedOut(job: JobRow, b: JobBusinessRow): Promise<boolean> {
    if ((await this.repo.listEvents(job.id)).some((e) => e.data.business_id === b.business_id && e.data.opt_out !== undefined)) return true;
    const contacts = [b.email ? normalizeAddress(b.email) : null, b.phone, b.a2a_card_url?.toLowerCase() ?? null].filter((c): c is string => !!c);
    return contacts.length ? (await this.repo.findSuppressions(contacts)).some((s) => s.reason === "opt_out") : false;
  }

  private async refuseIfOptedOut(job: JobRow, b: JobBusinessRow) {
    if (await this.optedOut(job, b)) throw new EngineError("business_opted_out", `${b.name} asked not to be contacted; Haggle won't message it on any channel.`, "Choose among the other businesses (get_quotes).", "get_quotes");
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
    for (const d of job.request.details ?? []) if (!citesCompetingOffer(`${d.label}: ${d.value}`)) for (const c of findDollarAmounts(d.value)) verified.add(c);
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
    await this.refuseIfOptedOut(job, b);
    // Default: the channel it was first contacted on. Another channel only when the agent asks for it.
    const channel: Channel = opts.channel ?? b.channel;
    const reachable = channel === "email" ? !!b.email : channel === "phone" ? !!(b.phone && this.d.phone) : channel === "imessage" ? !!(b.phone && (this.d.imessage || this.d.sms)) : !!(this.d.a2a && b.a2a_card_url && b.thread_id);
    if (!reachable) throw new EngineError("no_contact_method", `${b.name} can't be reached by ${channel} here.`, opts.channel ? "Pick a channel the business has (see get_quotes), or omit channel." : "Its own channel isn't available here; pass channel explicitly with one the business has (see get_quotes).", "get_quotes");
    if (channel === "phone" && this.callbacksNeedApproverText) {
      // A Voice AI call the agent asks for rings a real person: on a live server it is never a switch from
      // another channel, never a price discussion (that is a callback: call_back, the approver's CALL
      // code and recorded consent), and at most one per business per deal (S5-D F11).
      if (b.channel !== "phone") throw new EngineError("call_needs_approver", `${b.name} was contacted by ${b.channel}; switching it to a Voice AI call needs the approver.`, "Message it on its own channel, or use call_back (the approver authorizes calls by text).", "call_back");
      if (opts.text && amountsIn(opts.text).length) throw new EngineError("call_cites_price", "A call that discusses prices is a callback the approver authorizes.", "Use call_back when get_quotes offers one, or negotiate.", "call_back");
      const called = (await this.repo.listMessages(jobId)).some((m) => m.direction === "out" && m.kind === "call" && m.business_id === b.business_id && !!m.idempotency_key?.startsWith("msg:"));
      if (called) throw new EngineError("call_limit", `Haggle already called ${b.name} once for you on this deal.`, "Wait for its answer (wait_for_update), or use call_back for an approver-authorized call.", "wait_for_update");
    }
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
      const t = await this.a2aSend(job.id, key, { cardUrl: b.a2a_card_url!, text, data: { haggle: "message/1", protocol: "haggle.v0", type: "message", job_id: job.id }, messageId: `haggle-${key.replace(/:/g, "-")}`, contextId: b.thread_id! });
      messageId = (await this.recordA2aOutbound(job, b, "message", key, t.taskId, text, job.round))?.id;
    } else {
      const blocked = await this.callBlockedUntil(job, b.phone!);
      if (blocked) return { ok: true, mode: job.mode, business_id: b.business_id, channel, sent: false, scheduled_for: blocked.toISOString(), next: `Calls to ${b.name} are paused until ${blocked.toISOString()} (call hours or a recent call). Try again then, or email if it has an address.` };
      const { callId } = await this.placeCallOnce(job.id, { jobId: job.id, businessId: b.business_id, toNumber: b.phone!, reason: this.taskBrief(job, b, opts.askMissing ? "followup" : "message", text), idempotencyKey: key });
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
    let job = await this.loadJob(jobId);
    // The round cap (decision 14) is checked first: a refused round replaces nothing (the texted suggestion stands).
    if (job.round >= MAX_ROUND) throw new EngineError("no_rounds_left", `Round ${job.round} of ${MAX_ROUND} already ran; negotiation is capped at ${MAX_ROUND} rounds.`, "Choose among the current quotes (get_quotes, then approve), or call_back a phone vendor when one is offered.", "get_quotes");
    if (job.state === "awaiting_approval") {
      // Haggle's own texted suggestion never blocks another round (one the human or agent asked for does).
      const latest = await this.repo.getLatestApproval(jobId);
      if (latest?.status === "pending" && (await this.isAutoApproval(jobId, latest.id))) {
        await this.supersedeAutoApproval(job, latest, "Haggle started another negotiation round");
        job = await this.loadJob(jobId);
      }
    }
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
      next: "Start a deal with deal(...). The approver and the spending cap are the operator's to change, not the agent's: if they're wrong, tell the user.",
    };
  }

  /**
   * Keep the Voice AI answering instructions in sync with the open requests (fire and forget), so
   * a business calling back is matched to its request. A no-op without a voice port.
   */
  syncVoiceContext() {
    if (!this.d.voice) return;
    void (async () => {
      // One shared voice line: only the voice workspace's requests, never another tenant's.
      const voiceWs = this.d.config.voiceWorkspaceId ?? DEFAULT_WORKSPACE_ID;
      const jobs = (await this.repo.listOpenJobs()).filter((j) => j.workspace_id === voiceWs).slice(-20).reverse();
      const voiceJobs = await Promise.all(jobs.map(async (j) => ({ shortCode: j.short_code, request: j.request, businesses: (await this.repo.getBusinesses(j.id)).map((b) => ({ name: b.name, phone: b.phone })) })));
      await this.d.voice!.setInstructions(buildVoiceInstructions(customerOf({}, this.d.config.customerName), voiceJobs));
    })().catch((err) => this.log("voice_sync_failed", { error: (err as Error).message }));
  }

  /**
   * Start an approval for one exact quote. The decision comes from a human channel, never from this
   * call. `action`: "pay" (default) approves the pay-now amount (the deposit, or the full total when
   * no deposit was stated; payable_field for custom asks); the human's approval charges nothing and a
   * separate pay() charges it (decision 2). "confirm" tells the business to go ahead and pays
   * nothing (the job ends "confirmed"). The legacy "confirm_and_pay" means "pay".
   */
  async requestApproval(jobId: string, quoteId: string, channel: ApprovalRow["channel"], action?: ApprovalAction, offer?: ApprovalOffer): Promise<ApprovalRow> {
    await this.advanceJob(jobId);
    return this.openApproval(jobId, quoteId, channel, action, offer);
  }

  /**
   * requestApproval without the advance (offerReady runs inside one). `auto`: Haggle's own "all
   * quotes are in" suggestion, texted by SMS only (its own wording), replaceable until claimed.
   * Asking for another quote (or another action) while that suggestion is pending replaces it;
   * asking for the same quote claims it (it then holds the job like any requested approval).
   */
  private async openApproval(jobId: string, quoteId: string, channel: ApprovalRow["channel"], action?: ApprovalAction, offer?: ApprovalOffer, auto = false, update?: string): Promise<ApprovalRow> {
    let job = await this.loadJob(jobId);
    if (!auto && job.state === "awaiting_approval") {
      const latest = await this.repo.getLatestApproval(jobId);
      if (latest?.status === "pending" && (await this.isAutoApproval(jobId, latest.id))) {
        if (latest.quote_id === quoteId && (!action || latest.action === normalizeAction(action))) {
          // Same quote: one approval, one code. It now holds the job like any requested approval, and
          // the channels asked for now (iMessage, email) get the same code; the text already went.
          await this.repo.appendEvent(jobId, "approval_claimed", { approval_id: latest.id, channel });
          await this.deliverClaimed(job, latest, channel, offer);
          return (await this.repo.getApproval(latest.id)) ?? latest;
        }
        await this.supersedeAutoApproval(job, latest, "you chose another option");
        job = await this.loadJob(jobId);
      }
    }
    if (!auto && job.state === "paying" && this.d.config.manualPaymentHandoff) {
      // A booking the vendor never confirmed (after Haggle's reminder) or a handoff the payment checks
      // refused is a dead end otherwise: the agent may ask the human to approve another quote (or the
      // same one again). The old approval is withdrawn first; nothing was paid on it.
      if (await this.withdrawStuckBooking(job, quoteId)) job = await this.loadJob(jobId);
    }
    if (job.state !== "collecting" && job.state !== "negotiating") {
      const latest = await this.repo.getLatestApproval(jobId);
      if (job.state === "awaiting_approval" && latest?.status === "pending" && latest.quote_id === quoteId && (!action || latest.action === normalizeAction(action))) return latest;
      const [fix, next] = job.state === "paying" ? ["Already approved by the human; call pay(job_id, quote_id) to charge it (get_quotes shows any payment).", "pay"]
        : job.state === "paid" ? ["This deal is already paid and closed; nothing more to approve. Start a new deal for another purchase.", "deal"]
        : job.state === "confirmed" ? ["This order was already confirmed with the business (nothing was paid); nothing more to approve. Start a new deal for another purchase.", "deal"]
        : job.state === "cancelled" ? ["This deal was cancelled; nothing can be approved on it. Start a new deal.", "deal"]
        : job.state === "failed" ? [`This deal is closed (${job.failure_reason ?? "failed"}); nothing can be approved on it. Start a new deal.`, "deal"]
        : job.state === "awaiting_approval" ? ["Another approval is already waiting for the human; wait for it or let it expire.", "wait_for_update"]
        : ["Wait until quotes are in.", "wait_for_update"];
      throw new EngineError("not_approvable", `Job is ${job.state}.`, fix, next);
    }
    const q = await this.repo.getQuote(quoteId);
    if (!q || q.job_id !== jobId) throw new EngineError("quote_not_found", "No such quote on this job.", "Use a quote_id from get_quotes.", "get_quotes");
    // A live deal approves only a real business's reply (never a simulated one, never a quote with no source message).
    const src = await this.repo.getMessage(q.message_id);
    if (job.mode === "live" && (!src || src.simulated)) throw new EngineError("quote_not_eligible", "That quote can't be approved: simulated_reply.", "Only a real business's reply can be approved on a live deal.", "get_quotes");
    // A business that asked not to be contacted after quoting gets no booking request (S5 review H9).
    const quoted = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === q.business_id);
    if (quoted) await this.refuseIfOptedOut(job, quoted);
    // Only safety, no firm positive amount, or an unconfirmed all-in total refuses, for confirm-only
    // approvals too (decision 19); everything else is a caveat on the approval.
    const { hard: reason } = this.approvability(job, q);
    if (reason === "zero_total") throw new EngineError("zero_total", "That quote's total is $0; there is nothing to approve or pay.", "Ask the business for its actual total, or approve another quote.", "get_quotes");
    if (reason === "total_not_firm") {
      const b = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === q.business_id);
      throw new EngineError("total_not_firm", `${b?.name ?? "The business"} only gave an approximate total (about $${centsToUsd(q.total_cents!).toLocaleString("en-US")}); nothing can be approved or charged on an estimate.`,
        b?.channel === "phone" ? "A firm figure needs a callback to the business, which only the human can authorize; or approve another quote." : "Wait for the business to confirm a firm total (Haggle asked once), then approve the revised quote; or approve another quote.", "get_quotes");
    }
    // pay_now_basis: the deposit; with no deposit stated, the full total (the approval says so), never
    // $0. "pay" approves that amount for payment (pay then charges it); "confirm" only confirms the
    // order with the business and pays nothing.
    const payNow = q.deposit_cents && q.deposit_cents > 0 ? q.deposit_cents : q.total_cents;
    const act: ApprovalAction = action ? normalizeAction(action) : "pay"; // decision 40
    const pays = act === "pay";
    if (reason) {
      const fix = reason === "no_total" ? "Ask the business for its total (answer_business, or wait for the follow-up Haggle sent); every approval, confirm-only too, needs a firm total."
        : reason === "all_in_unknown" ? "Wait for the business to confirm its all-in total (delivery, tax and fees; Haggle asked), or pick another quote from get_quotes."
        : reason === "missing_info" ? "Wait for the business's answer (Haggle asked), or pick another quote from get_quotes." : "Pick another quote from get_quotes.";
      throw new EngineError("quote_not_eligible", `That quote can't be approved: ${reason}.`, fix, "get_quotes");
    }
    if (pays && !payNow) throw new EngineError("no_deposit", "This quote has no amount to pay now.", "Ask the business for its price first, or approve with action 'confirm' (no payment).", "get_quotes");
    if (!pays && this.d.config.manualPaymentHandoff) {
      // Manual rail: a confirm-only order is "confirmed" only by the business's own written yes, which
      // Haggle can read from email or a text, never from a call or an A2A task.
      const cb = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === q.business_id);
      if (!cb || !((cb.channel === "email" && cb.email) || (cb.channel === "imessage" && this.canReach(cb)))) {
        throw new EngineError("confirm_needs_written_reply", `${cb?.name ?? "This business"} is reached by ${cb?.channel === "phone" ? "a Voice AI call" : cb?.channel ?? "a channel"} Haggle can't get a written confirmation from, so a confirm-only approval could never be confirmed.`,
          "Approve with action 'pay' instead (the human confirms the booking with the business directly before paying it), or choose a business Haggle reaches by email or text.", "get_quotes");
      }
    }
    const payment = pays ? payNow! : 0;
    // A stale quote (past the business's valid-until date, or older than the validity window) is never
    // approved as is: the business is asked to re-confirm it, and the approval opens once it confirms
    // the same terms. Simulated demo vendors carry fixed sample dates and are never real offers.
    const qb = (await this.repo.getBusinesses(jobId)).find((x) => x.business_id === q.business_id);
    if (qb && !qb.simulated) {
      const fresh = this.freshnessOf(q, await this.repo.listEvents(jobId));
      if (fresh.stale) {
        const why = fresh.reason === "expired" ? `past its valid-until date (${q.record.valid_until?.slice(0, 10)})` : "older than Haggle's quote validity window";
        if (auto) throw new EngineError("quote_stale", `${qb.name}'s quote is ${why}.`, "Approve it explicitly (Haggle re-confirms it with the business first), or choose another quote.", "get_quotes");
        await this.requestReconfirmation(job, qb, q, channel, act, offer, why);
        throw new EngineError("quote_reconfirming", `${qb.name}'s ${usdText(q.total_cents!)} quote is ${why}, so it can't be approved as is. Haggle asked ${qb.name} to confirm it still stands; nothing was sent to the human yet.`,
          "Wait (wait_for_update). If the business confirms the same total and terms, Haggle sends the approval to the human automatically; a changed total arrives as a new quote that needs its own approval. Don't approve again meanwhile.", "wait_for_update");
      }
    }
    // Hard money limits (CLAUDE.md §7: amount ≤ approved ≤ cap): the operator's per-payment ceiling and
    // the workspace spending cap, whichever is lower.
    const settings = await this.getSettings(job.workspace_id);
    const ceiling = this.d.config.globalPaymentCapCents;
    const cap = Math.min(ceiling, settings.spending_cap_cents);
    if (payment > cap) {
      throw cap < ceiling
        ? new EngineError("over_cap", `The $${centsToUsd(payment).toFixed(2)} payment is over this workspace's $${centsToUsd(cap).toFixed(2)} spending cap.`, "Ask the business for a smaller deposit, or ask the operator to raise the workspace spending cap.", "get_quotes")
        : new EngineError("over_cap", `The $${centsToUsd(payment).toFixed(2)} payment is over this server's $${centsToUsd(cap).toFixed(2)} per-payment safety ceiling.`, "Ask the business for a smaller deposit, or ask the operator to raise HAGGLE_GLOBAL_PAYMENT_CAP_CENTS.", "get_quotes");
    }
    // Every human channel can be offered at once (form/card + text + email); the first human decision wins.
    const approverEmail = job.approver_email ?? (settings.approver_email ? normalizeAddress(settings.approver_email) : null);
    const iMessageApprover = Boolean(this.d.imessage && settings.approver_phone);
    const textTo = await this.notifyTarget(job);
    if (channel === "email" && !approverEmail) throw new EngineError("no_approver", "No approver email for this job.", "Approve by text instead, or ask the operator to set the approver's email (agents can't change the approver).", "settings.read");
    if (channel === "imessage" && !iMessageApprover && !textTo) throw new EngineError("no_imessage_approver", "Text approval isn't available: no number to text (the operator's notify number or the settings approver phone), or texting is off.", "Ask the operator to set the approver's phone (agents can't change the approver) and enable SMS or iMessage on the server), or approve on the approval card.", "settings.read");
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
    await this.repo.appendEvent(jobId, "approval_requested", { approval_id: approval.id, quote_id: q.id, channel, ...(auto ? { auto: "ready" } : {}), ...(auto && update ? { update } : {}) });
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
    if (channel === "imessage" && iMessageApprover && !auto) {
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
    const ask = HaggleEngine.approvalAsk(b.name, job.request.what, a.quote_total_cents, a.payment_cents, HaggleEngine.orderFacts(job.request));
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
  static approvalAsk(business: string, what: string, quoteTotalCents: number, paymentCents: number, facts?: string | null): string {
    const name = business.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 40) || "the business";
    // The order's headcount and date ride along (facts, ≤ 40 chars), so the human approves what they asked for.
    const w = `${what.replace(/\s+/g, " ").trim().slice(0, 60)}${facts ? ` (${facts.slice(0, 40)})` : ""}`;
    if (paymentCents <= 0) return `Confirm the order with ${name} for ${w} (total ${usdText(quoteTotalCents)}, nothing paid now)`;
    if (paymentCents < quoteTotalCents) return `Approve ${usdText(paymentCents)} deposit to ${name} for ${w} (total ${usdText(quoteTotalCents)})`;
    return `Approve paying ${usdText(paymentCents)} to ${name} for ${w} (the full total)`;
  }

  /** The approval text: "Haggle: Approve $250 deposit to … (total $1,760)? Reply YES 1234 or NO 1234. (HG-…)". */
  static approvalSmsText(business: string, what: string, quoteTotalCents: number, paymentCents: number, code: string, shortCode: string, facts?: string | null): string {
    return `Haggle: ${HaggleEngine.approvalAsk(business, what, quoteTotalCents, paymentCents, facts)}? Reply YES ${code} or NO ${code}. (HG-${shortCode})`.slice(0, SMS_LIMIT);
  }

  /** "60 people, Sat Nov 14" (headcount and day, for the human's approval texts), or null. */
  static orderFacts(r: { quantity?: number; unit?: string; date?: string }): string | null {
    const day = r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? new Date(`${r.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : null;
    const parts = [quantityText(r.quantity, r.unit), day].filter(Boolean);
    return parts.length ? parts.join(", ") : null;
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
    // Haggle's own "all quotes are in" suggestion has its own wording (it also says quotes are final).
    const text = (await this.isAutoApproval(job.id, a.id)) ? await this.readyApprovalText(job, a) : HaggleEngine.approvalSmsText(b.name, job.request.what, a.quote_total_cents, a.payment_cents, a.code, job.short_code, HaggleEngine.orderFacts(job.request));
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
    // Under the out-of-band policy an emailed code from an unauthenticated mailbox approves only when the operator enabled it.
    const emailCounts = !this.outOfBandApprovalsOnly || this.d.config.emailApprovalByCode === true;
    return { text: Boolean(await this.notifyTarget(job)), email: emailCounts && Boolean(job.approver_email ?? settings.approver_email) };
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
    if (!this.d.imessage || !to) throw new EngineError("no_imessage_approver", "No iMessage approver configured.", "Ask the operator to set the approver's phone and enable iMessage (agents can't change the approver).", "settings.read");
    const b = (await this.repo.getBusinesses(job.id)).find((x) => x.business_id === a.business_id)!;
    const key = `imsg:${sendKeys.approvalRequest(a.id)}`;
    if (await this.repo.findMessageByIdempotencyKey(key)) return;
    const text = HaggleEngine.approvalIMessageText(b.name, a.quote_total_cents, a.payment_cents, a.code);
    await this.claimSend(key, job.id, "text");
    let sent;
    try {
      sent = await this.d.imessage.send({ to, text, idempotencyKey: key });
    } catch (err) {
      await this.outboxFailed(key, job.id, "text", "not_sent", err);
      throw err;
    }
    await this.repo.finishOutbox(key, "sent", sent.messageId, this.now().toISOString());
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
    // Two pending approvals under one code (another deal or another workspace): never pick one.
    if (code && new Set(pending.filter((a) => a.code === code).map((a) => a.id)).size > 1) return { jobId: null, outcome: "ambiguous_code" };
    const target = code ? pending.find((a) => a.code === code) : !yes && pending.length === 1 ? pending[0] : undefined;
    if (!target && code && yes && pending.length >= 1) {
      // A wrong code counts toward the lockout of every approval pending for this approver, so several
      // pending approvals never allow unlimited guesses (S5-D F5; the CALL path does the same).
      let locked = false;
      for (const a of pending) {
        const w = await this.repo.recordWrongApprovalCode(a.id, this.d.config.maxApprovalAttempts ?? DEFAULT_MAX_APPROVAL_ATTEMPTS);
        if (w?.locked) {
          locked = true;
          await this.repo.appendEvent(a.job_id, "approval_locked", { approval_id: a.id, attempts: w.attempts });
          await this.advanceJob(a.job_id);
        }
      }
      return { jobId: pending.length === 1 ? pending[0]!.job_id : null, outcome: locked ? "approval_locked" : "wrong_code" };
    }
    if (!target) return { jobId: null, outcome: code ? "no_matching_approval" : yes ? "code_required" : "ambiguous" };
    const stored = await this.repo.insertMessage({
      job_id: target.job_id, business_id: null, approval_id: target.id, direction: "in", kind: "approval_reply", channel: "imessage", provider_email_id: m.providerId, idempotency_key: null,
      rfc_message_id: null, thread_id: null, from_address: from, to_address: null, subject: null, body_text: m.text.slice(0, 500), attachments: [], attachments_download_url: null,
      sender_trusted: true, trust_reason: m.trustReason, matched_via: "approval_code", parse_status: "none", quarantine_reason: null, round: null, simulated: false,
    });
    if (!stored) return { jobId: target.job_id, outcome: "duplicate" };
    // A YES by SMS is answered with how to pay by text: "Reply PAY <code>" (decision 48).
    const ok = await this.decideApproval(target.id, yes ? "approve" : "decline", "imessage", approver, { payByText: m.providerId.startsWith("sms-in:") });
    return { jobId: target.job_id, outcome: ok ? (yes ? "approved" : "declined") : "approval_not_pending" };
  }

  /** Record a human decision from a verified channel (email verifier, MCP elicitation, or mock-mode simulation). */
  /**
   * Operator correction: void an approval whose recorded terms are no longer right (e.g. an all-in total
   * the business disclosed but the stored quote missed). Refused once money is moving. Records why,
   * reopens the job, and never touches the quote's evidence; a fresh human approval is required.
   */
  async revokeApproval(jobId: string, approvalId: string, reason: string): Promise<boolean> {
    const a = await this.repo.getApproval(approvalId);
    if (!a || a.job_id !== jobId || (a.status !== "approved" && a.status !== "pending")) return false;
    const pay = await this.repo.getPaymentForJob(jobId);
    if (pay && ["signed", "sent", "settled", "charging"].includes(pay.status)) throw new EngineError("payment_in_flight", "A payment for this approval is already moving.", "Let it settle or fail first.", "get_quotes");
    if (!(await this.repo.transitionApproval(a.id, a.status, { status: "expired", decided_at: this.now().toISOString() }))) return false;
    await this.repo.appendEvent(jobId, "approval_void", { approval_id: a.id, reason: reason.slice(0, 300), by: "operator" });
    const job = await this.repo.getJob(jobId);
    if (job && (job.state === "paying" || job.state === "awaiting_approval")) await this.fire(jobId, { type: "approval_void" });
    return true;
  }

  async decideApproval(approvalId: string, decision: "approve" | "decline", channel: ApprovalRow["channel"], approver: string | null, opts: { payByText?: boolean } = {}) {
    const a = await this.repo.getApproval(approvalId);
    if (!a) return false;
    if (channel === "simulated" && this.d.config.mode !== "mock") throw new EngineError("simulation_disabled", "Simulated approval is only available in mock mode.", "Approve through the form or by email.", "approve");
    if (decision === "approve" && this.outOfBandApprovalsOnly && IN_BAND_CHANNELS.has(channel)) throw needsHumanChannel();
    if (this.now().getTime() > Date.parse(a.expires_at)) {
      await this.repo.transitionApproval(a.id, "pending", { status: "expired", decided_at: this.now().toISOString() });
      await this.advanceJob(a.job_id);
      return false;
    }
    const ok = await this.repo.transitionApproval(a.id, "pending", { status: decision === "approve" ? "approved" : "declined", decided_at: this.now().toISOString(), channel, approver });
    if (ok) {
      await this.repo.appendEvent(a.job_id, decision === "approve" ? "approval_verified" : "approval_declined", { approval_id: a.id, channel });
      await this.advanceJob(a.job_id);
      // Approve, then pay (decision 2): the approval records the human's OK and charges nothing; the
      // agent's pay() is the charge. The human is told so on every approval channel (decision 36),
      // through the normal notify path (SMS port and notify number; nothing real in mock mode).
      if (decision === "approve") await this.notifyApproved(a, opts.payByText === true);
    }
    return ok;
  }

  /**
   * "Approved: $250 deposit to Mission Eats. Nothing is charged until your assistant completes the
   * payment." After a texted YES with a payment rail on (decision 48): "approved: Mission Eats $250
   * deposit. Reply PAY 4821 to charge it now." (the same code; ingestPayText charges it).
   */
  private async notifyApproved(a: ApprovalRow, payByText = false) {
    const job = await this.repo.getJob(a.job_id);
    if (!job) return;
    const name = clip(await this.businessName(job.id, a.business_id), 30);
    const deposit = a.payment_cents < a.quote_total_cents;
    const text = (a.action === "confirm" || a.payment_cents <= 0) && this.d.config.manualPaymentHandoff
      ? `approved: Haggle asked ${name} to confirm the order (${usdText(a.quote_total_cents)} total). Nothing is paid through Haggle; you'll get a text when they confirm.`
      : a.action === "confirm" || a.payment_cents <= 0
      ? `confirmed: ${name} was told to go ahead with ${usdText(a.quote_total_cents)}. Nothing was paid.`
      : this.d.config.manualPaymentHandoff ? await this.approvedHandoffText(job, a, name, deposit)
      : payByText && this.paymentsEnabled ? `approved: ${name} ${usdText(a.payment_cents)} ${deposit ? "deposit" : "total"}. Reply PAY ${a.code} to charge it now.`
      : `approved: ${usdText(a.payment_cents)}${deposit ? " deposit" : ""} to ${name}. Nothing is charged until your assistant completes the payment; you'll get a text when it's paid.`;
    await this.notifyHuman(job, `approved:${a.id}`, text);
  }

  /** The approval text under the manual handoff: never "pay now" before the business confirmed the booking. */
  private async approvedHandoffText(job: JobRow, a: ApprovalRow, name: string, deposit: boolean): Promise<string> {
    const amount = `${usdText(a.payment_cents)} ${deposit ? "deposit" : "total"}`;
    const bk = await this.repo.getBookingByApproval(a.id);
    if (bk?.status === "not_in_writing") return `approved: ${amount} to ${name}. Haggle can't get their confirmation in writing: confirm the booking with them directly (date, ${usdText(a.quote_total_cents)} total, must-haves), then reply BOOKED ${a.code}. Don't pay before that.`;
    return `approved: ${amount} to ${name}. Haggle asked ${name} to confirm the booking; don't pay yet. You'll get a text when they confirm, with how to pay (Haggle never moves money).`;
  }

  private async businessName(jobId: string, businessId: string) {
    return (await this.repo.getBusinesses(jobId)).find((b) => b.business_id === businessId)?.name ?? "the business";
  }

  private async notifyPayFailed(job: JobRow, a: Pick<ApprovalRow, "id" | "business_id" | "payment_cents">, reason: string) {
    await this.notifyHuman(job, `pay-failed:${a.id}`, `approved, but the ${usdText(a.payment_cents)} payment to ${await this.businessName(job.id, a.business_id)} didn't go through: ${reason.slice(0, 120)}. Nothing was charged; see the deal board.`);
  }

  /** "6:45 PM" in the workspace's timezone (for texts to the human). */
  private async clockTime(iso: string | null, workspaceId: string): Promise<string> {
    const d = iso ? new Date(iso) : this.now();
    const tz = (await this.repo.getWorkspace(workspaceId))?.timezone ?? "America/Los_Angeles";
    try {
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).replace(/\s/g, " ");
    } catch {
      return d.toISOString().slice(11, 16) + " UTC";
    }
  }

  /**
   * The truthful answer to a YES/NO the human texted for an approval that was already decided
   * (usually on the card a few seconds earlier). Nothing is charged by the text (approve, then pay):
   * the reply says what actually happened.
   */
  private async alreadyDecidedText(job: JobRow, a: ApprovalRow): Promise<string> {
    const where = a.channel === "view" ? " on the card" : a.channel === "elicitation" ? " in the chat's approval form" : a.channel === "email" ? " by email" : a.channel === "imessage" ? " by text" : a.channel === "simulated" ? " (simulated, DEMO)" : "";
    const at = await this.clockTime(a.decided_at, job.workspace_id);
    const replaced = (await this.repo.listEvents(job.id)).find((e) => e.type === "approval_superseded" && e.data.approval_id === a.id);
    if (replaced) return `that suggestion was replaced at ${at} (${String(replaced.data.reason).slice(0, 60)}). Nothing was paid; see the deal board.`;
    if (a.status !== "approved" && a.status !== "used") return `that approval was already ${a.status}${where}${a.decided_at ? ` at ${at}` : ""}. Nothing was paid.`;
    if ((a.action === "confirm" || a.payment_cents <= 0) && job.state === "paying") return `already approved${where} at ${at}; Haggle is waiting for the business to confirm the order. Nothing to pay through Haggle.`;
    if (a.action === "confirm" || a.payment_cents <= 0) return `that order was already confirmed${where} at ${at}; the business was told to go ahead. Nothing to pay.`;
    const amount = usdText(a.payment_cents);
    const name = await this.businessName(job.id, a.business_id);
    const pay = await this.repo.getPaymentForJob(job.id);
    const mine = pay && pay.approval_id === a.id ? pay : null;
    if (mine?.status === "settled") return `already approved${where} at ${at} and paid ${amount} to ${name}${mine.simulated ? " (simulated, DEMO: no money moved)" : " (Stripe test mode)"}. Nothing else to do.`;
    if (mine && ["failed", "rejected", "expired"].includes(mine.status)) return `approved${where} at ${at}, but the ${amount} payment to ${name} didn't go through (${(mine.reason ?? mine.status).slice(0, 80)}). See the deal board.`;
    if (!mine) {
      // The guard refused the charge (nothing was charged): say so, never "paying".
      const refused = (await this.repo.listEvents(job.id)).filter((e) => e.type === "payment_refused" && e.data.approval_id === a.id).at(-1);
      if (refused) return `approved${where} at ${at}, but the ${amount} payment to ${name} was refused (${String(refused.data.code).slice(0, 40)}); nothing was charged. See the deal board.`;
    }
    if (mine?.status === "charging") return `already approved${where} at ${at}; the ${amount} payment to ${name} is in progress. You'll get a text when it's paid.`;
    if (a.status === "approved" && this.paymentsEnabled) return `already approved${where} at ${at}. The ${amount} payment to ${name} isn't charged yet: reply PAY ${a.code} to charge it now, or your assistant completes it.`;
    if (a.status === "approved") return `already approved${where} at ${at}. The ${amount} payment to ${name} isn't charged yet: your assistant completes it. Nothing more is needed from you.`;
    return `already approved${where} at ${at}. The ${amount} payment to ${name} is on the deal board.`;
  }

  async pay(jobId: string, quoteId: string): Promise<EnginePaymentStatus> {
    await this.advanceJob(jobId);
    const job = await this.loadJob(jobId);
    const approval = await this.repo.getLatestApproval(jobId);
    if (!approval || approval.quote_id !== quoteId) throw new EngineError("no_approval", "There's no human approval for that quote.", "Call approve(job_id, quote_id) first; the human must confirm.", "approve");
    if (approval.status === "pending") return { ...this.noPayment(), reason: "the human hasn't approved yet" };
    if (approval.status === "declined" || approval.status === "expired" || approval.status === "locked") throw new EngineError("approval_" + approval.status, `The approval was ${approval.status}.`, "Request a new approval.", "approve");
    if (approval.action === "confirm") {
      throw job.state === "paying"
        ? new EngineError("confirm_only", "The human approved confirming this order, not a payment: nothing to pay through Haggle.", "Haggle is waiting for the business to confirm the order in writing; call wait_for_update. The customer arranges payment with the business directly.", "wait_for_update")
        : new EngineError("confirm_only", "The human approved confirming this order, not a payment: nothing to pay.", "Done: the business was told to go ahead. Call approve with action 'pay' for a payment.", "get_quotes");
    }
    if (job.state !== "paying" && job.state !== "paid") throw new EngineError("not_payable", `Job is ${job.state}.`, "Wait for approval.", "wait_for_update");
    // Defense in depth: an approximate total is never charged (requestApproval already refuses it).
    if (isApproximate((await this.repo.getQuote(quoteId))?.record) && job.state !== "paid") throw new EngineError("total_not_firm", "That quote's total is only approximate; nothing is charged on an estimate.", "Wait for the business to confirm a firm total, then approve the revised quote.", "get_quotes");
    if (this.d.config.manualPaymentHandoff) {
      // Nothing is charged: the business confirms the booking, the human pays it directly and texts
      // PAID <code> (ingestPaidText). pay only reports where that stands.
      if (!(await this.repo.getBookingByApproval(approval.id)) && job.state === "paying") await this.startBooking(job, approval);
      const line = await this.handoffFor((await this.repo.getJob(jobId)) ?? job);
      if (line?.status === "handoff_refused") throw new EngineError("handoff_refused", line.reason ?? "The approval no longer passes the payment checks.", "Tell the user not to pay. The operator was flagged; a fresh approval (approve) may be needed, e.g. if the spending cap was lowered.", "get_quotes");
      if (!line) {
        const refused = (await this.repo.listEvents(jobId)).filter((e) => e.type === "payment_refused" && e.data.approval_id === approval.id && e.data.rail === "manual").at(-1);
        if (refused) throw new EngineError("handoff_refused", `The approval no longer passes the payment checks (${String(refused.data.code)}), so Haggle didn't ask the business to book or how to be paid. Nothing was paid.`, "Tell the user not to pay. The operator was flagged; a fresh approval (approve) may be needed, e.g. if the spending cap was lowered.", "get_quotes");
        throw new EngineError("handoff_unavailable", "The booking and payment handoff couldn't be started.", "Call get_quotes, then pay again.", "get_quotes");
      }
      return line;
    }
    if (!this.d.stripe && this.d.payer.disabledReason) throw new EngineError("payments_disabled", this.d.payer.disabledReason, "Nothing was charged. The operator must enable Stripe test mode (HAGGLE_ENABLE_PAYMENTS=true with STRIPE_* set); the approval stays valid until it expires.", "get_quotes");
    if (!job.pay_intent) await this.repo.touchJob(jobId, { pay_intent: true });
    if (this.d.stripe) {
      const { refused } = await this.processStripePayment(jobId);
      if (refused) throw stripeRefusal(refused);
      await this.advanceJob(jobId); // a settled charge moves the job to paid
      const p = await this.repo.getPaymentForJob(jobId);
      if (!p) throw new EngineError("payment_not_started", "The payment didn't start.", "Call get_quotes to check the job, then pay again.", "get_quotes");
      return this.withReceipt(jobId, paymentStatus(p));
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
    return this.d.config.manualPaymentHandoff === true || this.d.stripe !== undefined || !this.d.payer.disabledReason;
  }

  /** The pilot (HAGGLE_PAYMENTS=manual): no money moves through Haggle; the human pays the business directly. */
  get manualPayments(): boolean {
    return this.d.config.manualPaymentHandoff === true;
  }

  /** What follows the human's YES on this server, for the agent's hints (never "charged" in the pilot). */
  private afterYes(): string {
    return this.manualPayments
      ? "then the business confirms the booking and the human pays them directly (PAID <code>); Haggle charges nothing"
      : "then their texted PAY <code> or your pay charges it";
  }

  /**
   * Only out-of-band human answers approve (EngineConfig.outOfBandApprovalsOnly; on in live mode): a
   * tool call (the client's form, the card's button) can't prove a human made it, so it never approves.
   */
  get outOfBandApprovalsOnly(): boolean {
    return this.d.config.outOfBandApprovalsOnly ?? this.d.config.mode === "live";
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

  /**
   * Recent deals for an agent that doesn't hold job ids (new conversation, reconnect): compact rows,
   * newest first, open ones first. Read-only: never advances a job or contacts anyone.
   */
  async recentDeals(limit = 10, workspaceId?: string): Promise<{ job_id: string; what: string; quantity?: number; unit?: string; date?: string; area: string; state: JobState; ready: boolean; created_at: string; updated_at: string; businesses: number; quotes: number; leading?: { business: string; total_usd: number } }[]> {
    const jobs = (await this.repo.listRecentJobs(Math.min(Math.max(limit, 1), 50), workspaceId)).sort((a, b) => Number(TERMINAL.has(a.state)) - Number(TERMINAL.has(b.state)) || b.created_at.localeCompare(a.created_at));
    // Deals are read in parallel, two reads each; never a whole board per deal (live: 5 boards took ~21 s).
    return Promise.all(jobs.map(async (j) => {
      const [all, businesses] = await Promise.all([this.repo.listQuotes(j.id), this.repo.getBusinesses(j.id)]);
      const { quotes } = await this.rankRows(j, all);
      // "Leading" is the board's recommendation (best value the human can actually approve: the same
      // recommendedQuote as recommended_quote_id), never a raw-ranking pick such as an approximate total.
      const lead = quotes.some((q) => q.total_cents !== null) ? await this.recommendedQuote(j, { all, businesses }).catch(() => null) : null;
      return {
        job_id: j.id, what: j.request.what, ...(j.request.quantity !== undefined ? { quantity: j.request.quantity } : {}), ...(j.request.unit ? { unit: j.request.unit } : {}), ...(j.request.date ? { date: j.request.date } : {}), area: j.request.area, state: j.state, ready: j.ready,
        created_at: j.created_at, updated_at: j.updated_at, businesses: businesses.length, quotes: quotes.filter((q) => q.total_cents !== null).length,
        ...(lead?.total_cents != null ? { leading: { business: businesses.find((b) => b.business_id === lead.business_id)?.name ?? lead.business_id, total_usd: centsToUsd(lead.total_cents) } } : {}),
      };
    }));
  }

  /** Business names on a deal (wait_for_update names whose quote is whose without building the board). */
  /**
   * Where a deal stands after quotes, for list_deals (resume in a new conversation without a board
   * read): the purchase stage in honest words, the vendor's payment instructions as untrusted text, and
   * the next step. Null before an approval exists. No advance (a list must stay a few reads per deal);
   * purchase rows change when replies and texts arrive, not on advance.
   */
  async dealSummary(jobId: string): Promise<{ stage: string; summary: string; next: string; instructions?: PurchaseView["instructions"] } | null> {
    const job = await this.loadJob(jobId);
    if (!["awaiting_approval", "paying", "paid", "confirmed"].includes(job.state)) return null;
    const v = await this.purchaseFor(job);
    if (v) return { stage: v.stage, summary: v.summary, next: v.next, ...(v.instructions ? { instructions: { ...v.instructions, text: clip(v.instructions.text, 300) } } : {}) };
    const hint = await this.nextHint(job);
    return { stage: job.state, summary: job.state === "awaiting_approval" ? "Waiting for the human's approval." : `Deal ${job.state}.`, next: hint };
  }

  async businessNames(jobId: string): Promise<Map<string, string>> {
    return new Map((await this.repo.getBusinesses(jobId)).map((b) => [b.business_id, b.name]));
  }

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
  async updateSettings(patch: Partial<Omit<SettingsRow, "updated_at">>, workspaceId: string = DEFAULT_WORKSPACE_ID, by: "operator" | "agent" = "operator"): Promise<SettingsRow> {
    const cur = await this.getSettings(workspaceId);
    const next = { ...cur, ...patch };
    if (by === "agent") {
      // Who approves and how much may be spent are the operator's (workspace-create / workspace-admin),
      // never a tool call's: a model that could set them could approve its own purchases.
      const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null);
      if (patch.approver_phone !== undefined && !same(patch.approver_phone, cur.approver_phone)) throw approverChangeRefused();
      if (patch.approver_email !== undefined && !same(patch.approver_email ? normalizeAddress(patch.approver_email) : null, cur.approver_email)) throw approverChangeRefused();
      if (next.spending_cap_cents > cur.spending_cap_cents) throw new EngineError("cap_increase_requires_operator", "The spending cap can only be raised by the operator.", "Ask the operator to raise it (scripts/workspace-admin.ts); lowering it is allowed here.", "settings");
    }
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
    // A code the card sends back proves nothing in live mode: any client can make this call.
    if (this.outOfBandApprovalsOnly) throw needsHumanChannel();
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

  /**
   * Cancel a deal (the cancel_deal tool). A booking the business already confirmed is cancelled only on
   * the approver's CANCEL <code> (decision H3): here it is only asked for (`needs_approver`).
   */
  async cancel(jobId: string): Promise<{ ok: true; state: JobState; flagged?: true; needs_approver?: true; note?: string }> {
    return this.cancelJob(jobId, null);
  }

  /** `authorizedBy`: the approver's coded text (ingestCancelText); null for a tool call. */
  private async cancelJob(jobId: string, authorizedBy: string | null): Promise<{ ok: true; state: JobState; flagged?: true; needs_approver?: true; note?: string }> {
    const job = await this.loadJob(jobId);
    if (job.state === "cancelled") return { ok: true as const, state: job.state };
    // After the customer reported paying the business directly: Haggle can't reverse a payment it never
    // made. Nothing is claimed or promised to anyone; the human and the operator handle it.
    if (job.state === "paid" && this.d.config.manualPaymentHandoff) {
      const a = await this.repo.getLatestApproval(jobId);
      const h = a ? await this.repo.getHandoffByApproval(a.id) : null;
      if (a && h?.status === "human_confirmed") {
        const name = await this.businessName(jobId, a.business_id);
        const note = `The customer reported paying ${name} ${usdText(h.amount_cents)} directly, so Haggle can't cancel or refund it: contact ${name} about cancelling and any refund under their terms. The operator was flagged; nothing was sent to ${name}.`;
        if (!(await this.repo.listEvents(jobId)).some((e) => e.type === "cancel_after_payment" && e.data.approval_id === a.id)) {
          await this.repo.appendEvent(jobId, "cancel_after_payment", { approval_id: a.id, at: this.now().toISOString() });
          await this.repo.appendEvent(jobId, "operator_attention", { reason: "cancel_after_reported_payment", approval_id: a.id, business_id: a.business_id });
          this.log("operator_attention", { job_id: jobId, reason: "cancel_after_reported_payment" });
          await this.notifyHuman(job, `cancel-after-paid:${a.id}`, `you asked to cancel after reporting a direct payment to ${clip(name, 30)}. Haggle can't refund it: contact them directly. The operator was flagged.`);
          await this.repo.touchJob(jobId);
        }
        return { ok: true as const, state: job.state, flagged: true as const, note };
      }
    }
    if (!authorizedBy && this.callbacksNeedApproverText) {
      const held = await this.vendorConfirmedBooking(job);
      if (held) return this.requestCancelAuthorization(job, held.a);
    }
    if (authorizedBy) await this.repo.appendEvent(jobId, "cancel_authorized", { by: authorizedBy, at: this.now().toISOString() });
    if (job.state === "confirmed") {
      const a = await this.repo.getLatestApproval(jobId);
      const name = a ? await this.businessName(jobId, a.business_id) : "the business";
      throw new EngineError("cannot_cancel", `This order was already confirmed with ${name} in writing; Haggle can't undo that.`, `Tell the user to contact ${name} directly to cancel under its terms. Nothing was paid through Haggle and nothing was sent now.`, "none");
    }
    const r = await this.fire(jobId, { type: "cancelled" });
    if (!r.ok) throw new EngineError("cannot_cancel", r.reason ?? "conflict", job.state === "paid" ? "Settled payments can't be reversed." : "Wait for the payment to resolve.", "wait_for_update");
    return { ok: true as const, state: "cancelled" as JobState };
  }
}

export class RetryLater extends Error {
  override name = "RetryLater";
}

/** A send refused because this instance lost the job's lease (fence): another instance owns the job; nothing is recorded from here. */
export class LeaseLostError extends ChannelSendError {
  override name = "LeaseLostError";
  constructor() {
    super("provider_error", true, OUTBOX_STALE_MS, "this instance lost the job's lease (another instance is advancing it); not sent from here");
  }
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
    if (job.workspace_id !== this.workspaceId) throw new EngineError("job_not_found", `No job ${jobId}.`, "Use a job_id returned by deal or list_deals; call list_deals to find the deal the user means (a new request is a new deal).", "list_deals");
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
  get manualPayments() { return this.engine.manualPayments; }
  get outOfBandApprovalsOnly() { return this.engine.outOfBandApprovalsOnly; }
  get brainIsStub() { return this.engine.brainIsStub; }

  /** The approver comes from the workspace settings (the operator's), never from the agent's input. */
  async deal(input: DealInput) {
    const { approver_email: _ignored, ...rest } = input;
    const approver = (await this.engine.getSettings(this.workspaceId)).approver_email;
    return this.engine.deal({ ...rest, ...(approver ? { approver_email: approver } : {}), workspace_id: this.workspaceId });
  }
  async loadJob(jobId: string) { return this.own(jobId); }
  async waitForUpdate(jobId: string, cursor: number, timeoutMs: number, signal?: AbortSignal, until?: WaitUntil) { await this.own(jobId); return this.engine.waitForUpdate(jobId, cursor, timeoutMs, signal, until); }
  async getQuotes(jobId: string) { await this.own(jobId); return this.engine.getQuotes(jobId); }
  async businessNames(jobId: string) { await this.own(jobId); return this.engine.businessNames(jobId); }
  async answerSeller(jobId: string, questionId: string, answer: string) { await this.own(jobId); return this.engine.answerSeller(jobId, questionId, answer); }
  async sendMessage(jobId: string, businessId: string, opts: Parameters<HaggleEngine["sendMessage"]>[2]) { await this.own(jobId); return this.engine.sendMessage(jobId, businessId, opts); }
  async negotiate(jobId: string, businessIds?: string[]) { await this.own(jobId); return this.engine.negotiate(jobId, businessIds); }
  async getConversation(jobId: string, businessId: string, limit?: number) { await this.own(jobId); return this.engine.getConversation(jobId, businessId, limit); }
  async requestApproval(jobId: string, quoteId: string, channel: ApprovalRow["channel"], action?: ApprovalAction, offer?: ApprovalOffer) { await this.own(jobId); return this.engine.requestApproval(jobId, quoteId, channel, action, offer); }
  async approvalReach(jobId: string) { await this.own(jobId); return this.engine.approvalReach(jobId); }
  async approvalOffers(approvalId: string) { await this.ownApproval(approvalId); return this.engine.approvalOffers(approvalId); }
  /** Tool paths can only claim the in-band channels (a coded text or email is decided by ingest, never by a tool). */
  // A live job is never approved by a client form, a card's view-held code or a simulated human, whatever
  // the engine's approval config says: those are client-side signals, not proof a human decided.
  async decideApproval(approvalId: string, decision: "approve" | "decline", channel: "elicitation" | "view" | "simulated", approver: string | null) {
    const a = await this.ownApproval(approvalId);
    // (A simulated decision outside mock mode is refused by the engine itself: simulation_disabled.)
    if (decision === "approve" && (await this.engine.loadJob(a.job_id)).mode === "live" && (channel !== "simulated" || this.engine.mode === "mock")) throw needsHumanChannel();
    return this.engine.decideApproval(approvalId, decision, channel, approver);
  }
  async approveWithViewCode(approvalId: string, code: string) {
    const a = await this.ownApproval(approvalId);
    if ((await this.engine.loadJob(a.job_id)).mode === "live") throw needsHumanChannel();
    return this.engine.approveWithViewCode(approvalId, code);
  }
  async approvalIMessageSent(approvalId: string) { await this.ownApproval(approvalId); return this.engine.approvalIMessageSent(approvalId); }
  async pay(jobId: string, quoteId: string) { await this.own(jobId); return this.engine.pay(jobId, quoteId); }
  async cancel(jobId: string) { await this.own(jobId); return this.engine.cancel(jobId); }
  async quoteForCheck(jobId: string, quoteId: string) { await this.own(jobId); return this.engine.quoteForCheck(jobId, quoteId); }
  async approvalCaveats(jobId: string, quoteId: string) { await this.own(jobId); return this.engine.approvalCaveats(jobId, quoteId); }
  canContact(b: Parameters<HaggleEngine["canContact"]>[0]) { return this.engine.canContact(b); }
  /** canContact plus this workspace's operator-authorized vendors and the suppression list. */
  mayContact(b: Parameters<HaggleEngine["canContact"]>[0]) { return this.engine.mayContact(b, this.workspaceId); }
  latestJob() { return this.engine.latestJob(this.workspaceId); }
  getSettings() { return this.engine.getSettings(this.workspaceId); }
  updateSettings(patch: Parameters<HaggleEngine["updateSettings"]>[0]) { return this.engine.updateSettings(patch, this.workspaceId, "agent"); }
  knownBusinesses(query: string, limit?: number) { return this.engine.knownBusinesses(query, limit, this.workspaceId); }
  businessProfile(ref: string) { return this.engine.businessProfile(ref, this.workspaceId); }
  identity() { return this.engine.identity(this.workspaceId); }
  ask(req: Request) { return this.engine.ask(req); }
  discover(category: string, area: string, count: number) { return this.engine.discover(category, area, count); }
  checkPrice(input: Parameters<HaggleEngine["checkPrice"]>[0]) { return this.engine.checkPrice(input); }
  // Main's tools, workspace-scoped (decision 7).
  recentDeals(limit?: number) { return this.engine.recentDeals(limit, this.workspaceId); }
  async callbackProposals(jobId: string) { await this.own(jobId); return this.engine.callbackProposals(jobId); }
  /**
   * DEMO only (mock, in-band approvals): a callback the client's form or the board authorized. In live
   * mode a tool path never places a call (callbacksNeedApproverText): requestCallbackAuthorization texts the approver.
   */
  async placeCallback(jobId: string, businessId: string, authorizedBy: string) {
    await this.own(jobId);
    if (this.engine.callbacksNeedApproverText) throw new EngineError("callback_needs_approver_text", "On this server a callback is placed only after the workspace approver texts CALL <code> to Haggle (or an operator places it); a tool, form or board tap can't authorize it.", "Call call_back: Haggle texts the approver to ask.", "call_back");
    const consent = await this.engine.callbackConsentFor(jobId, businessId);
    if (!consent.ok) throw new EngineError("callback_no_consent", `Haggle won't call this business back: ${consent.reason}.`, "Negotiate by email or text (send_message) instead.", "get_quotes");
    return this.engine.placeCallback(jobId, businessId, authorizedBy);
  }
  get callbacksNeedApproverText() { return this.engine.callbacksNeedApproverText; }
  /** Text the workspace approver for one callback (they reply CALL <code>); the code never comes back here. */
  async requestCallbackAuthorization(jobId: string, businessId: string) {
    await this.own(jobId);
    const r = await this.engine.requestCallbackAuthorization(jobId, businessId);
    return { texted: r.texted, held: r.held, expires_at: r.expires_at, proposal: r.proposal };
  }
  async businessAliases(b: Parameters<HaggleEngine["businessAliases"]>[0]) { return this.engine.businessAliases(b); }
  /** Learning from this workspace's own deals only. */
  async contactLearning(businessId: string, aliases?: string[]) { return this.engine.contactLearning(businessId, aliases, this.workspaceId); }
  /** Which of these job ids are this workspace's (e.g. to show only its own history from a shared profile). */
  ownJobIds(jobIds: (string | null)[]) { return this.engine.jobsInWorkspace(jobIds, this.workspaceId); }
  /** The operator-authorized vendors of this workspace (read-only: an agent can't add or change them). */
  workspaceVendors() { return this.engine.workspaceVendors(this.workspaceId); }
  async revokeApproval(jobId: string, approvalId: string, reason: string) { await this.own(jobId); return this.engine.revokeApproval(jobId, approvalId, reason); }
  async approvalById(approvalId: string) { await this.ownApproval(approvalId); return this.engine.approvalById(approvalId); }
  async advanceJob(jobId: string) { await this.own(jobId); return this.engine.advanceJob(jobId); }
  async dealSummary(jobId: string) { await this.own(jobId); return this.engine.dealSummary(jobId); }
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
  OVER_SPEND_CAP: ["The deposit is over the spending cap.", "Lower the deposit with the business, or ask the operator to raise the cap (agents can't).", "get_quotes"],
  JOB_NOT_READY: ["The job is not ready to pay.", "Call get_quotes to see its state.", "get_quotes"],
  PAYEE_NOT_QUOTED: ["The payee isn't a business that quoted on this job from a verified sender.", "Pick a compliant quote from get_quotes.", "get_quotes"],
};

function stripeRefusal(code: StripeGuardCode): EngineError {
  const [message, fix, next] = STRIPE_REFUSALS[code];
  return new EngineError(`payment_refused_${code.toLowerCase()}`, message, fix, next);
}

/** Why a quote can't win, in words: an unconfirmed requirement is "not confirmed yet", never "not met". */
function excludedText(reason: import("../ranking/rank.ts").RejectReason, results: { met: boolean | null }[]): string {
  if (reason === "requirement_unmet" && results.some((x) => x.met === null) && !results.some((x) => x.met === false)) return "a hard requirement isn't confirmed yet";
  return REJECT_TEXT[reason];
}

/** The all-in total is known: delivery stated (included or priced) and tax not excluded without an amount. */
/**
 * The all-in total is known: tax isn't excluded without an amount, and, when the buyer's request
 * involves delivery (a delivery requirement, or one about delivery / an all-in total), delivery is
 * stated (included or priced). For a roof repair, "delivery not stated" means nothing and doesn't block.
 */
function allInKnown(r: import("../parsing/extraction.ts").QuoteRecord, needsDelivery = true): boolean {
  return !r.flags.includes("tax_excluded") && !r.flags.includes("fees_unclear") && !(needsDelivery && r.flags.includes("delivery_unclear"));
}


/** The business hedged its total in its own words (see parsing/approximate.ts). */
function isApproximate(r: QuoteRecord | undefined | null): boolean {
  return !!r && r.flags.includes(APPROXIMATE_FLAG);
}

/**
 * How much a ranked quote misses of what was asked (value ranking tier, lower first). Preferences are
 * soft (decision 1), but a quote that meets what was asked is recommended before one that doesn't: a
 * stated "no" to a hard requirement is worst, an unconfirmed one next, then a missing required answer
 * or being over the budget.
 */
function softTier(reasons: readonly string[]): number {
  return softTierOf(reasons);
}

/** What approval would pay now: the stated deposit, else the full total (null when there is no total). */
function payNowCents(q: Pick<QuoteRow, "deposit_cents" | "total_cents">): number | null {
  return q.deposit_cents !== null && q.deposit_cents > 0 ? q.deposit_cents : q.total_cents;
}

/** "confirm" stays confirm-only; "pay" and the legacy "confirm_and_pay" approve a payment (pay charges it). */
function normalizeAction(a: ApprovalAction): "confirm" | "pay" {
  return a === "confirm" ? "confirm" : "pay";
}

function rejectToFlag(r: string) {
  const m: Record<string, import("../contract.ts").QuoteFlag> = {
    unavailable: "requirement_unmet", unverified_sender: "unverified_sender", external_payment_link: "external_payment_link", prompt_injection: "prompt_injection",
    requirement_unmet: "requirement_unmet", missing_info: "requirement_unknown", no_total: "vague_price", all_in_unknown: "delivery_unclear", over_budget: "over_budget", not_current: "expired",
  };
  return m[r] ?? "low_confidence";
}

/** Contract ApprovalRecord, except `channel` reports the real human channel (incl. v5 view / iMessage). */
export type EngineApprovalRecord = Omit<ApprovalRecord, "channel"> & { channel: ApprovalRow["channel"]; status: ApprovalRow["status"]; action: ApprovalRow["action"]; attempts: number; /** Haggle's own texted "all quotes are in" suggestion: choosing another quote replaces it. */ replaceable?: boolean };

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
  /** + the manual purchase stages (payments/purchase.ts): never "settled" for money Haggle didn't see move. */
  status: PaymentStatus["status"] | "charging" | PurchaseStage;
  /** "manual": a handoff (the human pays the business directly; nothing moves through Haggle). */
  rail: PaymentRow["rail"] | "manual";
  network: PaymentRow["network"] | "manual";
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

/**
 * Businesses whose current quote is a real answer: available, from a verified sender, with a price
 * (or a stated custom field). The board shows them quoted and the window stops waiting for them.
 */
function answeredByQuote(quotes: QuoteRow[]): Set<string> {
  return new Set(quotes.filter((q) => q.status === "current" && q.record.available && q.sender_trusted
    && (q.total_cents !== null || q.record.subtotal_cents !== null || q.record.price_per_head_cents !== null || q.record.deposit_cents !== null || Object.values(q.record.fields ?? {}).some((v) => v !== null)))
    .map((q) => q.business_id));
}

/**
 * Businesses Haggle asked for something within holdMs (a follow-up, the answer to its question, a
 * message) that haven't replied since. A call scheduled for later counts from its time. Holding
 * for them is short: one that never answers doesn't keep the deal waiting for the whole window.
 */
function chasedRecently(msgs: MessageRow[], events: JobEventRow[], now: number, holdMs: number): Set<string> {
  const askedAt = new Map<string, number>();
  const note = (id: string, at: number) => { if (!Number.isNaN(at) && at > (askedAt.get(id) ?? -Infinity)) askedAt.set(id, at); };
  const ASKS = new Set(["followup", "answer", "message"]);
  const placed = new Set(msgs.filter((m) => m.direction === "out" && m.idempotency_key).map((m) => m.idempotency_key!));
  const dropped = new Set(events.filter((e) => e.type === "call_dropped").map((e) => String(e.data.key)));
  for (const m of msgs) if (m.direction === "out" && m.business_id && ASKS.has(m.kind)) note(m.business_id, Date.parse(m.created_at));
  for (const e of events) {
    const key = typeof e.data.key === "string" ? e.data.key : null;
    if (e.type === "call_scheduled" && key && ASKS.has(String(e.data.kind)) && typeof e.data.business_id === "string" && !placed.has(key) && !dropped.has(key)) note(e.data.business_id, Date.parse(String(e.data.at)));
  }
  const chased = new Set<string>();
  for (const [id, at] of askedAt) {
    const answered = msgs.some((m) => m.direction === "in" && m.kind === "reply" && m.business_id === id && Date.parse(m.created_at) > at);
    if (!answered && now - at < holdMs) chased.add(id);
  }
  return chased;
}

/** A vendor number on an open deal, for routing a text from it: when Haggle texted or contacted it, and the deal's messages. */
type TextDealCandidate = { job: JobRow; b: JobBusinessRow; at: number; msgs: MessageRow[] };
/** What Haggle sends a business that waits for its answer: the RFQ (text, email or call), a follow-up, a counteroffer, the agent's message. */
const ASK_KINDS = new Set<MessageRow["kind"]>(["rfq", "call", "followup", "counter", "message"]);

/**
 * Which deal a text from a vendor answers when its number is on several open deals (decision 46):
 * the HG-<code> it quotes; else the deal with an unanswered ask out to that vendor (newest ask
 * first); else the deal that texted it most recently. Live: Golden Grill's "1370 total and 100
 * deposit" went to the older deal and the new deal's exact-total follow-up never got its answer.
 */
export function pickTextDeal<T extends TextDealCandidate>(hits: T[], text: string): { hit: T; via: "code" | "open_ask" | "latest" } {
  const code = /\bHG-([A-Z0-9]{4,8})\b/i.exec(text)?.[1]?.toUpperCase();
  const byCode = code ? hits.find((h) => h.job.short_code.toUpperCase() === code) : undefined;
  if (byCode) return { hit: byCode, via: "code" };
  let best: { hit: T; at: number } | null = null;
  for (const h of hits) {
    const mine = h.msgs.filter((m) => m.business_id === h.b.business_id);
    // Answered by anything the business said since (a call that reached no one answers nothing).
    const answered = mine.filter((m) => m.direction === "in" && !(m.provider_email_id?.startsWith("call-ended:") && m.parse_status === "none")).reduce((a, m) => (m.created_at > a ? m.created_at : a), "");
    const ask = mine.filter((m) => m.direction === "out" && ASK_KINDS.has(m.kind) && m.created_at > answered).reduce((a, m) => (m.created_at > a ? m.created_at : a), "");
    if (ask && (!best || Date.parse(ask) > best.at)) best = { hit: h, at: Date.parse(ask) };
  }
  if (best) return { hit: best.hit, via: "open_ask" };
  return { hit: [...hits].sort((x, y) => y.at - x.at)[0]!, via: "latest" };
}

/** The stored-message fields of an inbound email before its job, business and trust are decided (ingest's `base`). */
type PurchaseBase = Omit<NewMessage, "job_id" | "business_id" | "kind" | "sender_trusted" | "trust_reason" | "matched_via" | "parse_status" | "quarantine_reason">;

/** A business's text as the purchase reader takes it (an InboundMessage with the text as its body; no thread, no attachments). */
function textInbound(m: { messageId: string; from: string; text: string }, job: JobRow, prefix: "imsg-in" | "sms-in"): InboundMessage {
  return { providerEventId: `${prefix}:${m.messageId}`, eventType: prefix === "imsg-in" ? "imessage.received" : "sms.received", providerEmailId: `${prefix}:${m.messageId}`, threadId: null, messageId: null, inReplyTo: [], references: [], from: m.from, to: [job.inbox], subject: null, bodyText: m.text, attachments: [], attachmentsDownloadUrl: null };
}

/** The stored-message fields of that text (the same shape the text paths store a reply with). */
function textBase(m: { messageId: string; from: string; text: string }, job: JobRow, prefix: "imsg-in" | "sms-in"): PurchaseBase {
  return { approval_id: null, direction: "in", channel: "imessage", provider_email_id: `${prefix}:${m.messageId}`, idempotency_key: null, rfc_message_id: null, thread_id: null, from_address: m.from, to_address: job.inbox, subject: null, body_text: m.text.slice(0, 5000) || null, attachments: [], attachments_download_url: null, round: null, simulated: false };
}

/** A re-confirmation asked for this quote and not resolved yet. */
function pendingReconfirm(events: JobEventRow[], quoteId: string): boolean {
  const asked = events.filter((e) => e.type === "reconfirm_requested" && e.data.quote_id === quoteId).at(-1);
  return !!asked && !events.some((e) => e.type === "reconfirm_resolved" && e.data.quote_id === quoteId && e.seq > asked.seq);
}

/** Haggle's own "all quotes are in" suggestion, unclaimed (see isAutoApproval), from the deal's events. */
function isAutoIn(events: JobEventRow[], approvalId: string): boolean {
  return events.some((e) => e.type === "approval_requested" && e.data.approval_id === approvalId && e.data.auto === "ready")
    && !events.some((e) => e.type === "approval_claimed" && e.data.approval_id === approvalId);
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
