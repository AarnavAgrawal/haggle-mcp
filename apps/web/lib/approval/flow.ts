// Approval, payment, callbacks and the purchase after approval, from a signed-in human's click
// (CLAUDE.md §7). Pure: the client is injected (lib/approval/deps.ts in the app, a fake in tests).
//
// The web backend is a first-party host that reaches the Haggle server's service routes
// (/internal/approvals/*, /internal/purchases/*, /internal/callbacks/*, apps/mcp/src/service/approvals.ts)
// with the service token, naming the signed-in user (x-haggle-actor). Those clicks are the human's own
// (approval channel "web"), on demo and live servers alike: one path for both. Pay and the board read
// still use the MCP tools (pay, get_quotes). Every result below is built field by field from the
// server's answer, never spread from it: no result type has a code field, and none is ever sent.
import { HaggleError, type ToolResult } from "../haggle.ts";

/** What the flows need: an MCP tool call (pay, get_quotes) and a service-route POST, both as the user's workspace. */
export interface ApprovalClient {
  callTool<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<ToolResult<T>>;
  /** POST /internal/<path> with the service token, the workspace and the actor; throws HaggleError on a refusal. */
  service<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T>;
}

export type Mode = "mock" | "live";
/** manual: the human pays the business directly (Haggle moves no money); charge: Pay charges the approved amount. */
export type Rail = "manual" | "charge";
export interface FlowError {
  ok: false;
  error: { code: string; message: string; fix: string };
  next: string | null;
  /** HTTP status of the server's refusal (400, 404, 409, 5xx); absent for a tool's own refusal. */
  status?: number;
}

/** The approval the human is about to confirm: exactly what the server opened (its terms never change). */
export interface PreviewOk {
  ok: true;
  mode?: Mode;
  rail?: Rail;
  approval_id: string;
  /** pending: waiting for this click; approved / used: already recorded (a repeated click). */
  status: "pending" | "approved" | "used" | "declined" | "expired" | "locked";
  action: "pay" | "confirm";
  amount_usd: number;
  quote_total_usd: number;
  business: string;
  caveats: string[];
  expires_at?: string;
  next: string;
}
export type PreviewResult = PreviewOk | FlowError;

export interface DecideOk {
  ok: true;
  mode?: Mode;
  rail?: Rail;
  status: "approved" | "declined" | "used";
  /** false: this decision was already recorded (a repeated click). */
  changed: boolean;
  action: "pay" | "confirm";
  amount_usd: number;
  quote_total_usd: number;
  state?: string;
  stage?: string;
  summary?: string;
  next: string;
}
export type DecideResult = DecideOk | FlowError;

export interface PayOk {
  ok: true;
  mode?: Mode;
  status: "pending_human" | "approved" | "paid" | "refused" | "confirmed";
  amount_usd: number;
  receipt_url?: string;
  simulated?: boolean;
  reason?: string;
  next: string;
}
export type PayResult = PayOk | FlowError;

export interface CallbackOk {
  ok: true;
  mode?: Mode;
  status: "placed" | "scheduled" | "declined";
  business?: string;
  scheduled_for?: string;
  next: string;
}
export type CallbackResult = CallbackOk | FlowError;

/** Business words: shown as plain text, labelled, never followed. */
export interface VendorText {
  text: string;
  has_link: boolean;
}
export interface PurchaseOk {
  ok: true;
  mode?: Mode;
  rail: Rail | null;
  state: string;
  /** The manual rail's stage (payments/purchase.ts words), when a booking exists. */
  stage?: string;
  booked?: boolean;
  money_verified?: boolean;
  confirm_only?: boolean;
  amount_usd?: number;
  total_usd?: number;
  summary?: string;
  /** The server's next step, when it reads right in the app (hints naming a texted code are left out). */
  next?: string;
  instructions?: VendorText;
  vendor_reply?: VendorText;
  payment?: { status: string; simulated?: boolean; receipt_url?: string };
  /** Which buttons make sense now (the server still decides). */
  can: { report_paid: boolean; accept_booking: boolean; cancel: boolean };
}
export type PurchaseResult = PurchaseOk | FlowError;

export type PurchaseAction = "paid" | "booked" | "cancel";
export interface PurchaseActionOk {
  ok: true;
  mode?: Mode;
  action: PurchaseAction;
  outcome?: string;
  state?: string;
  stage?: string;
  summary?: string;
  note?: string;
  next: string;
}
export type PurchaseActionResult = PurchaseActionOk | FlowError;

/** A HaggleError (tool refusal or HTTP refusal) or anything else, as the browser-safe error shape. */
export function toFlowError(e: unknown): FlowError {
  if (e instanceof HaggleError) {
    return { ok: false, error: { code: e.code, message: e.message, fix: e.fix }, next: e.next, ...(e.status ? { status: e.status } : {}) };
  }
  return { ok: false, error: { code: "unreachable", message: "The Haggle server couldn't be reached.", fix: "Try again in a moment." }, next: null, status: 502 };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const modeOf = (v: unknown): { mode?: Mode } => (v === "mock" || v === "live" ? { mode: v } : {});
const railOf = (v: unknown): { rail?: Rail } => (v === "manual" || v === "charge" ? { rail: v } : {});
const actionOf = (v: unknown): "pay" | "confirm" => (v === "confirm" ? "confirm" : "pay");
const opt = <K extends string, V>(k: K, v: V | undefined): Partial<Record<K, V>> => (v === undefined ? {} : ({ [k]: v } as Record<K, V>));
/** A server hint, unless it tells the human to text a code (the app has a button for that instead). */
const appHint = (v: unknown): string | undefined => {
  const s = str(v);
  return s && !/<code>|\b(?:PAID|BOOKED|CANCEL|CALL|YES) \d/.test(s) ? s : undefined;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 12) : []);
const vendorText = (v: unknown): VendorText | undefined => {
  const o = v as { text?: unknown; has_link?: unknown } | undefined;
  const text = str(o?.text);
  return text ? { text: text.slice(0, 4000), has_link: o?.has_link === true || /\bhttps?:\/\/|\bwww\./i.test(text) } : undefined;
};
const PREVIEW_STATUSES = ["pending", "approved", "used", "declined", "expired", "locked"] as const;

/**
 * The human clicked Approve: open (or reuse) the pending approval for this exact quote and return what
 * they are about to confirm (business, amount paid now, total, caveats). Nothing is decided yet.
 */
export async function previewApproval(c: ApprovalClient, jobId: string, quoteId: string, action?: "pay" | "confirm"): Promise<PreviewResult> {
  try {
    const d = await c.service<Record<string, unknown>>("/internal/approvals/request", { job_id: jobId, quote_id: quoteId, ...(action ? { action } : {}) });
    const approvalId = str(d.approval_id);
    if (!approvalId) return { ok: false, error: { code: "bad_answer", message: "The Haggle server sent an unexpected answer.", fix: "Reload the page and try again." }, next: null, status: 502 };
    return {
      ok: true, ...modeOf(d.mode), ...railOf(d.payment_rail), approval_id: approvalId,
      status: (PREVIEW_STATUSES as readonly string[]).includes(String(d.status)) ? (d.status as PreviewOk["status"]) : "pending",
      action: actionOf(d.action), amount_usd: num(d.amount_usd) ?? 0, quote_total_usd: num(d.quote_total_usd) ?? 0,
      business: str(d.business)?.slice(0, 120) ?? "the business", caveats: strings(d.caveats), ...opt("expires_at", str(d.expires_at)), next: str(d.next) ?? "",
    };
  } catch (e) {
    return toFlowError(e);
  }
}

/** The human confirmed (or declined) that exact approval: recorded as theirs (web:<actor>). */
export async function decideApproval(c: ApprovalClient, approvalId: string, decision: "approve" | "decline"): Promise<DecideResult> {
  try {
    const d = await c.service<Record<string, unknown>>("/internal/approvals/decide", { approval_id: approvalId, decision });
    const status = d.status === "declined" || d.status === "used" ? d.status : "approved";
    return {
      ok: true, ...modeOf(d.mode), ...railOf(d.payment_rail), status, changed: d.changed === true, action: actionOf(d.action),
      amount_usd: num(d.amount_usd) ?? 0, quote_total_usd: num(d.quote_total_usd) ?? 0,
      ...opt("state", str(d.state)), ...opt("stage", str(d.stage)), ...opt("summary", str(d.summary)),
      next: appHint(d.next) ?? (status === "declined" ? "Declined. Nothing was approved or paid." : "Approved. Nothing is charged until you pay."),
    };
  } catch (e) {
    return toFlowError(e);
  }
}

type PayData = { mode?: string; status?: string; amount_usd?: number; receipt_url?: string; reason?: string; next?: string; payment?: { simulated?: boolean } };
const PAY_STATUSES = ["pending_human", "approved", "paid", "refused", "confirmed"] as const;

/** The human clicked Pay (charge rail): charge the approved amount (the server never takes the amount as input). */
export async function payQuote(c: ApprovalClient, jobId: string, quoteId: string): Promise<PayResult> {
  try {
    const d = (await c.callTool<PayData>("pay", { job_id: jobId, quote_id: quoteId })).data;
    const status = (PAY_STATUSES as readonly string[]).includes(d.status ?? "") ? (d.status as PayOk["status"]) : "approved";
    const receipt = str(d.receipt_url);
    return {
      ok: true, ...modeOf(d.mode), status, amount_usd: num(d.amount_usd) ?? 0,
      ...opt("receipt_url", receipt && /^https:\/\//.test(receipt) ? receipt : undefined),
      ...opt("simulated", typeof d.payment?.simulated === "boolean" ? d.payment.simulated : undefined),
      ...opt("reason", str(d.reason)),
      next: str(d.next) ?? "",
    };
  } catch (e) {
    return toFlowError(e);
  }
}

/** The human authorized one callback (the callee's consent and a justified proposal are still required). */
export async function authorizeCallback(c: ApprovalClient, jobId: string, businessId: string): Promise<CallbackResult> {
  try {
    const d = await c.service<Record<string, unknown>>("/internal/callbacks/authorize", { job_id: jobId, business_id: businessId });
    const scheduled = str(d.scheduled_for);
    const status: CallbackOk["status"] = d.status === "placed" ? (scheduled ? "scheduled" : "placed") : "declined";
    return { ok: true, ...modeOf(d.mode), status, ...opt("business", str(d.business)), ...opt("scheduled_for", scheduled), next: appHint(d.next) ?? "" };
  } catch (e) {
    return toFlowError(e);
  }
}

type BoardData = {
  mode?: string; job?: { state?: string };
  purchase?: { stage?: string; booked?: boolean; money_verified?: boolean; confirm_only?: boolean; amount_usd?: number; total_usd?: number; summary?: string; next?: string; instructions?: unknown; vendor_reply?: unknown };
  payment?: { status?: string; simulated?: boolean; receipt_url?: string };
};
const PAYABLE = new Set(["instructions_requested", "instructions_received"]);
const CANCELLABLE = new Set(["awaiting_vendor_confirmation", "instructions_requested", "instructions_received", "handoff_refused"]);

/** Where the purchase stands after approval (from get_quotes), with the buttons that make sense now. */
export async function purchaseStatus(c: ApprovalClient, jobId: string): Promise<PurchaseResult> {
  try {
    const d = (await c.callTool<BoardData>("get_quotes", { job_id: jobId })).data;
    const p = d.purchase;
    const state = str(d.job?.state) ?? "unknown";
    const stage = str(p?.stage);
    const summary = str(p?.summary);
    const instructions = vendorText(p?.instructions);
    const vendorReply = vendorText(p?.vendor_reply);
    const pay = d.payment;
    const receipt = str(pay?.receipt_url);
    const waitingForHuman = stage === "awaiting_vendor_confirmation" && (/BOOKED/.test(`${summary ?? ""} ${p?.next ?? ""}`) || vendorReply !== undefined);
    return {
      ok: true, ...modeOf(d.mode), rail: p ? "manual" : pay ? "charge" : null, state,
      ...opt("stage", stage), ...opt("booked", bool(p?.booked)), ...opt("money_verified", bool(p?.money_verified)), ...opt("confirm_only", p?.confirm_only === true ? true : undefined),
      ...opt("amount_usd", num(p?.amount_usd)), ...opt("total_usd", num(p?.total_usd)), ...opt("summary", summary), ...opt("next", appHint(p?.next)),
      ...opt("instructions", instructions), ...opt("vendor_reply", vendorReply),
      ...(pay?.status ? { payment: { status: pay.status, ...opt("simulated", bool(pay.simulated)), ...opt("receipt_url", receipt && /^https:\/\//.test(receipt) ? receipt : undefined) } } : {}),
      can: {
        report_paid: state === "paying" && !!stage && PAYABLE.has(stage) && p?.confirm_only !== true,
        accept_booking: state === "paying" && waitingForHuman,
        cancel: state === "paying" && !!stage && CANCELLABLE.has(stage),
      },
    };
  } catch (e) {
    return toFlowError(e);
  }
}

const PURCHASE_PATHS: Record<PurchaseAction, string> = { paid: "/internal/purchases/paid", booked: "/internal/purchases/booked", cancel: "/internal/purchases/cancel" };

/** "I've paid the vendor", "The booking is confirmed", or "Cancel this booking", as the signed-in human. */
export async function purchaseAction(c: ApprovalClient, jobId: string, action: PurchaseAction): Promise<PurchaseActionResult> {
  try {
    const d = await c.service<Record<string, unknown>>(PURCHASE_PATHS[action], { job_id: jobId });
    return {
      ok: true, ...modeOf(d.mode), action, ...opt("outcome", str(d.outcome)), ...opt("state", str(d.state)), ...opt("stage", str(d.stage)), ...opt("summary", str(d.summary)),
      ...opt("note", str(d.note)), next: appHint(d.next) ?? "",
    };
  } catch (e) {
    return toFlowError(e);
  }
}
