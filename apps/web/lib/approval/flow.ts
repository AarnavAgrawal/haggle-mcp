// Approval, payment and callbacks from a signed-in human's click (CLAUDE.md §7). Pure: the Haggle
// client is injected (lib/haggle.ts in the app, a fake in tests).
//
// The web backend is a trusted MCP Apps host: choose_in_view hands it a one-time ticket in `_meta`,
// and the same click spends it on approve_in_view. Tickets and callback codes stay inside these
// functions: every result below is built field by field from the tool's data, never spread from it,
// and no result type has a code or ticket field.
import { HaggleError, type ToolResult } from "../haggle.ts";

/** What the flows need from the Haggle client. */
export interface HostClient {
  callTool<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<ToolResult<T>>;
  callToolAsHost<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<ToolResult<T>>;
}

export type Mode = "mock" | "live";
export interface FlowError {
  ok: false;
  error: { code: string; message: string; fix: string };
  next: string | null;
  /** HTTP status of a transport refusal (401, 5xx); absent for a tool's own refusal. */
  status?: number;
}

export interface ApproveOk {
  ok: true;
  mode?: Mode;
  /** approved: the human's yes is recorded (pay next); confirmed: confirm-only, nothing to pay; pending_text: the approver answers by text. */
  status: "approved" | "confirmed" | "paid" | "refused" | "pending_text";
  action?: "pay" | "confirm";
  amount_usd?: number;
  reason?: string;
  next: string;
}
export type ApproveResult = ApproveOk | FlowError;

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
  status: "placed" | "scheduled" | "pending_text" | "declined";
  business?: string;
  scheduled_for?: string;
  next: string;
}
export type CallbackResult = CallbackOk | FlowError;

/** A HaggleError (tool refusal or HTTP refusal) or anything else, as the browser-safe error shape. */
export function toFlowError(e: unknown): FlowError {
  if (e instanceof HaggleError) {
    return { ok: false, error: { code: e.code, message: e.message, fix: e.fix }, next: e.next, ...(e.status ? { status: e.status } : {}) };
  }
  return { ok: false, error: { code: "unreachable", message: "The Haggle server couldn't be reached.", fix: "Try again in a moment." }, next: null, status: 502 };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const modeOf = (v: unknown): { mode?: Mode } => (v === "mock" || v === "live" ? { mode: v } : {});
const opt = <K extends string, V>(k: K, v: V | undefined): Partial<Record<K, V>> => (v === undefined ? {} : ({ [k]: v } as Record<K, V>));

/** The approval ticket choose_in_view puts in `_meta` for a host (never leaves this module). */
function ticketOf(meta: Record<string, unknown> | undefined): { approval_id: string; code: string } | null {
  const t = meta?.["haggle/approval"] as { approval_id?: unknown; code?: unknown } | undefined;
  return t && typeof t.approval_id === "string" && typeof t.code === "string" ? { approval_id: t.approval_id, code: t.code } : null;
}
function callbackCodeOf(meta: Record<string, unknown> | undefined): string | null {
  const c = (meta?.["haggle/callback"] as { code?: unknown } | undefined)?.code;
  return typeof c === "string" ? c : null;
}

/** The approval card's status words as ApproveOk statuses. */
function approvalStatus(outcome: unknown): ApproveOk["status"] {
  return outcome === "confirmed" || outcome === "paid" || outcome === "refused" ? outcome : outcome === "pending_human" ? "pending_text" : "approved";
}

type ChooseData = { mode?: string; approval_id?: string; status?: string; action?: string; amount_usd?: number; next?: string };
type ApproveInViewData = { mode?: string; status?: string; outcome?: string; action?: string; next?: string; reason?: string; card?: { amount_usd?: number } };

/**
 * The human clicked Approve: start a board approval (choose_in_view) and, when the server hands this
 * host the ticket, record the approval with it right away (approve_in_view): one click, one yes.
 * Without a ticket (an out-of-band server, or an approval already sent by text, email or form) the
 * approver answers on their phone: pending_text, with the server's own `next` (the code isn't in it).
 */
export async function approveQuote(haggle: HostClient, jobId: string, quoteId: string, action?: "pay" | "confirm"): Promise<ApproveResult> {
  try {
    const chose = await haggle.callToolAsHost<ChooseData>("choose_in_view", { job_id: jobId, quote_id: quoteId, ...(action ? { action } : {}) });
    const c = chose.data;
    const act = c.action === "confirm" || c.action === "pay" ? c.action : action;
    const ticket = ticketOf(chose.meta);
    if (!ticket) {
      if (c.status === "approved" || c.status === "used") {
        return { ok: true, ...modeOf(c.mode), status: "approved", ...opt("action", act), ...opt("amount_usd", num(c.amount_usd)), next: str(c.next) ?? "Approved. Pay when ready." };
      }
      if (c.status && c.status !== "pending") {
        return { ok: true, ...modeOf(c.mode), status: "refused", ...opt("action", act), reason: `approval ${c.status}`, next: str(c.next) ?? "This approval can't be used. Choose a quote again." };
      }
      return { ok: true, ...modeOf(c.mode), status: "pending_text", ...opt("action", act), ...opt("amount_usd", num(c.amount_usd)), next: str(c.next) ?? "We texted your approver: they reply YES with the code from that text." };
    }
    const r = (await haggle.callToolAsHost<ApproveInViewData>("approve_in_view", { approval_id: ticket.approval_id, code: ticket.code })).data;
    const recorded = r.status === "approved" || r.status === "used";
    return {
      ok: true, ...modeOf(r.mode ?? c.mode),
      status: recorded ? approvalStatus(r.outcome) : "refused",
      ...opt("action", r.action === "confirm" || r.action === "pay" ? r.action : act),
      ...opt("amount_usd", num(r.card?.amount_usd) ?? num(c.amount_usd)),
      ...opt("reason", str(r.reason) ?? (recorded ? undefined : `approval ${r.status ?? "missing"}`)),
      next: str(r.next) ?? (recorded ? "Approved. Pay when ready." : "Choose a quote again."),
    };
  } catch (e) {
    return toFlowError(e);
  }
}

type PayData = { mode?: string; status?: string; amount_usd?: number; receipt_url?: string; reason?: string; next?: string; payment?: { simulated?: boolean } };
const PAY_STATUSES = ["pending_human", "approved", "paid", "refused", "confirmed"] as const;

/** The human clicked Pay: charge the approved amount (the server never takes the amount as input). */
export async function payQuote(haggle: HostClient, jobId: string, quoteId: string): Promise<PayResult> {
  try {
    const d = (await haggle.callTool<PayData>("pay", { job_id: jobId, quote_id: quoteId })).data;
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

type CallbackData = { mode?: string; status?: string; business?: string; scheduled_for?: string; next?: string };

function callbackOk(d: CallbackData): CallbackOk {
  const scheduled = str(d.scheduled_for);
  const status: CallbackOk["status"] = d.status === "placed" ? (scheduled ? "scheduled" : "placed") : d.status === "declined" ? "declined" : "pending_text";
  return { ok: true, ...modeOf(d.mode), status, ...opt("business", str(d.business)), ...opt("scheduled_for", scheduled), next: str(d.next) ?? "" };
}

/**
 * The human authorized one callback. Demo servers hand this host a code (`_meta`) that the same click
 * spends on call_back_in_view; live servers text the approver instead (CALL <code>): pending_text.
 */
export async function authorizeCallback(haggle: HostClient, jobId: string, businessId: string): Promise<CallbackResult> {
  try {
    const asked = await haggle.callToolAsHost<CallbackData>("call_back", { job_id: jobId, business_id: businessId });
    const code = callbackCodeOf(asked.meta);
    if (!code) return callbackOk(asked.data);
    return callbackOk((await haggle.callToolAsHost<CallbackData>("call_back_in_view", { job_id: jobId, business_id: businessId, code })).data);
  } catch (e) {
    return toFlowError(e);
  }
}
