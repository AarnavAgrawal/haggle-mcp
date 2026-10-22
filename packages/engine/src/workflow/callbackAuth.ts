// Who may authorize a real outbound callback (sprint 4, workstream D). A Voice AI callback rings a
// real person, so in live mode (and whenever approvals are out-of-band only) a board tap, a client
// form, the model or a view-held code never places one: only the workspace approver's coded text
// ("CALL <code>", sent to the approver's own phone) or an operator action. And only to a callee who
// agreed to be called: an operator-configured simulated vendor, a workspace vendor whose consent the
// operator recorded, or the business that itself called Haggle on this deal, when that call's sender
// was authenticated (caller ID alone can be spoofed: decision H1, 2026-10-22). Never to a suppressed
// number. The authorization lives in job events (durable, per job): only a hash of the code is kept.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { provesSenderIdentity } from "../inbound/trustStrength.ts";
import type { JobBusinessRow, JobEventRow, MessageRow, WorkspaceVendorRow } from "../store/types.ts";

/** "CALL 482913": the approver allows the one callback Haggle texted them about. Six digits (approval codes have four). */
export const CALL_TEXT = /^call\b[\s,.:!-]*(\d{6})[\s.!]*$/i;
/**
 * "CANCEL 482913": the approver cancels a booking the business already confirmed (decision H3,
 * 2026-10-22). The model's cancel_deal only asks for it; the code goes only to the approver's phone.
 */
export const CANCEL_TEXT = /^cancel\b[\s,.:!-]*(\d{6})[\s.!]*$/i;
export const CALLBACK_AUTH_TTL_MS = 30 * 60_000;
/** Wrong CALL codes from the approver's number before a pending callback is locked. */
export const MAX_CALLBACK_CODE_ATTEMPTS = 5;

export const newCallbackCode = (): string => String(randomInt(100_000, 1_000_000));
export const callbackCodeHash = (authId: string, code: string): string => createHash("sha256").update(`${authId}:${code}`, "utf8").digest("hex");

export function codeMatches(authId: string, code: string, hash: string): boolean {
  const a = Buffer.from(callbackCodeHash(authId, code), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PendingCallbackAuth {
  auth_id: string;
  business_id: string;
  code_hash: string;
  expires_at: string;
  wrong: number;
}

/**
 * Coded authorizations still waiting for the approver's text: not decided, superseded, locked or
 * expired. `kind` "callback" is CALL <code>; "cancel" is CANCEL <code> (cancelAuth.ts), same events
 * with their own prefix.
 */
export function pendingCallbackAuths(events: Pick<JobEventRow, "type" | "data">[], now: Date, kind: "callback" | "cancel" = "callback"): PendingCallbackAuth[] {
  const decided = new Set(events.filter((e) => e.type === `${kind}_auth_decided`).map((e) => String(e.data.auth_id)));
  const wrong = new Map<string, number>();
  for (const e of events) if (e.type === `${kind}_auth_wrong_code`) wrong.set(String(e.data.auth_id), (wrong.get(String(e.data.auth_id)) ?? 0) + 1);
  return events
    .filter((e) => e.type === `${kind}_auth_requested` && !decided.has(String(e.data.auth_id)))
    .map((e) => ({ auth_id: String(e.data.auth_id), business_id: String(e.data.business_id), code_hash: String(e.data.code_hash), expires_at: String(e.data.expires_at), wrong: wrong.get(String(e.data.auth_id)) ?? 0 }))
    .filter((a) => Date.parse(a.expires_at) > now.getTime() && a.wrong < MAX_CALLBACK_CODE_ATTEMPTS);
}

export type CallbackConsent = { ok: true; basis: "simulated_vendor" | "workspace_vendor" | "called_us" } | { ok: false; reason: string };

/**
 * May Haggle's Voice AI call this business back? The callee's consent, from durable records only
 * (never from the agent, a board or a message body).
 */
export function callbackConsent(input: {
  business: Pick<JobBusinessRow, "business_id" | "phone" | "simulated" | "status">;
  workspaceVendors: Pick<WorkspaceVendorRow, "contact" | "consent">[];
  messages: Pick<MessageRow, "direction" | "business_id" | "channel" | "matched_via" | "from_address" | "sender_trusted" | "trust_reason">[];
  suppressed: boolean;
}): CallbackConsent {
  const { business: b } = input;
  if (!b.phone) return { ok: false, reason: "no phone number on this deal" };
  if (input.suppressed) return { ok: false, reason: "this number asked not to be contacted (or is suppressed)" };
  if (b.status === "declined" || b.status === "unavailable") return { ok: false, reason: "this business declined or asked to stop on this deal" };
  if (b.simulated) return { ok: true, basis: "simulated_vendor" };
  if (input.workspaceVendors.some((v) => v.contact === b.phone && v.consent.trim().length >= 3)) return { ok: true, basis: "workspace_vendor" };
  const calledUs = input.messages.filter((m) => m.direction === "in" && m.channel === "phone" && m.business_id === b.business_id && m.matched_via === "caller_number" && m.from_address === b.phone);
  if (calledUs.some((m) => provesSenderIdentity(m))) return { ok: true, basis: "called_us" };
  if (calledUs.length) return { ok: false, reason: "a call from this number reached Haggle, but caller ID alone can't prove it was the business; no recorded consent to be called (ask the operator to record it with workspace-admin add-vendor --consent)" };
  return { ok: false, reason: "no recorded consent to be called (not an operator-authorized vendor of this workspace, and it never called Haggle from an authenticated line)" };
}
