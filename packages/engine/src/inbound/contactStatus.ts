// PURE: where Haggle stands with each business on a deal, from the rows the engine already keeps
// (the business row, its messages, suppressions, the job's events). The deal board's `status` enum
// is fixed (packages/core views.ts), so this is the engine-level detail behind it: `contact_status`
// and a ≤100-character `line` meant for the board's `last_event`.
//
// Precedence (first that applies): opted_out > bounced > failed > quarantined_reply > replied >
// awaiting_reply (contacted, nothing back yet) > scheduled (first contact deferred) > not_contacted.
// `delivered` is what is known about the latest email Haggle sent the business: false once it
// bounced or failed, null otherwise (Inkbox's "delivered" is not tracked, so success is never claimed).
import type { JobBusinessRow, JobEventRow, MessageRow, SuppressionRow } from "../store/types.ts";
import { normalizeAddress } from "./matching.ts";
import { explainQuarantine } from "./quarantineReasons.ts";

export type ContactStatus = "opted_out" | "bounced" | "failed" | "quarantined_reply" | "replied" | "awaiting_reply" | "scheduled" | "not_contacted";

export interface BusinessContactStatus {
  business_id: string;
  contact_status: ContactStatus;
  delivered: false | null;
  /** For the board's last_event: short, no addresses. */
  line: string;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  /** Unprompted reminders sent to a silent business (workflow/contactWindow.ts). */
  reminders_sent: number;
  /** When a deferred first contact or a reminder is due. */
  next_contact_at: string | null;
}

const REMINDER_KEY = /^reminder:/;

export function contactStatusOf(i: { business: JobBusinessRow; messages: MessageRow[]; suppressions: SuppressionRow[]; events: JobEventRow[] }): BusinessContactStatus {
  const b = i.business;
  const mine = i.messages.filter((m) => m.business_id === b.business_id);
  const out = mine.filter((m) => m.direction === "out");
  const lastOut = out.reduce<MessageRow | null>((a, m) => (!a || m.created_at > a.created_at ? m : a), null);
  const lastEmail = mine.filter((m) => m.direction === "out" && m.channel === "email").reduce<MessageRow | null>((a, m) => (!a || m.created_at > a.created_at ? m : a), null);
  const inbound = mine.filter((m) => m.direction === "in");
  const lastIn = inbound.reduce<MessageRow | null>((a, m) => (!a || m.created_at > a.created_at ? m : a), null);
  const contacts = [b.email, b.phone].filter((c): c is string => !!c).map((c) => (c.includes("@") ? normalizeAddress(c) : c));
  const sup = i.suppressions.filter((s) => contacts.includes(s.contact));
  const optedOutHere = i.events.some((e) => e.type === "reply" && e.data.business_id === b.business_id && typeof e.data.opt_out === "string");
  const reminders = mine.filter((m) => m.direction === "out" && REMINDER_KEY.test(m.idempotency_key ?? "")).length;
  const base = { business_id: b.business_id, last_outbound_at: lastOut?.created_at ?? null, last_inbound_at: lastIn?.created_at ?? null, reminders_sent: reminders, next_contact_at: b.next_attempt_at };
  const delivered = lastEmail?.delivery_status ? false as const : null;
  const st = (contact_status: ContactStatus, line: string): BusinessContactStatus => ({ ...base, contact_status, delivered, line: line.slice(0, 100) });

  if (sup.some((s) => s.reason === "opt_out") || optedOutHere) return st("opted_out", sup.some((s) => s.reason === "opt_out") ? "Asked not to be contacted; Haggle won't contact them again" : "Appears to have opted out (unverified); not contacted again on this deal");
  if (sup.some((s) => s.reason === "bounce") || b.status === "bounced" || lastEmail?.delivery_status === "bounced") return st("bounced", lastEmail?.delivery_status === "bounced" || sup.length ? "Email bounced; address suppressed" : "Couldn't be reached on its channel");
  const trustedReply = inbound.filter((m) => m.kind === "reply" && m.sender_trusted === true).reduce<MessageRow | null>((a, m) => (!a || m.created_at > a.created_at ? m : a), null);
  if (lastEmail?.delivery_status === "failed" && !trustedReply) return st("failed", "Email to them failed to send (provider status failed); not delivered");
  const held = inbound.filter((m) => m.kind === "quarantine" || (m.kind === "reply" && m.sender_trusted !== true));
  const lastHeld = held.filter((m) => !(m.quarantine_reason ?? "").startsWith("bounce")).reduce<MessageRow | null>((a, m) => (!a || m.created_at > a.created_at ? m : a), null);
  if (lastHeld && (!trustedReply || lastHeld.created_at > trustedReply.created_at)) return st("quarantined_reply", explainQuarantine(lastHeld.quarantine_reason ?? lastHeld.trust_reason).board);
  if (trustedReply || ["replied", "quoted", "question"].includes(b.status)) return st("replied", trustedReply?.trust_reason === "operator_verified" ? "Replied (released by an operator after verification)" : "Replied");
  if (lastOut) return st("awaiting_reply", reminders ? `Contacted; no reply yet (${reminders} reminder${reminders === 1 ? "" : "s"} sent)` : "Contacted; no reply yet");
  if (b.status === "pending" && b.next_attempt_at) return st("scheduled", `First contact scheduled for ${b.next_attempt_at.slice(0, 16).replace("T", " ")} UTC (contact hours)`);
  if (["contacted", "ringing", "no_reply"].includes(b.status)) return st("awaiting_reply", "Contacted; no reply yet");
  return st("not_contacted", b.status === "unavailable" ? "Not contacted (channel not enabled)" : "Not contacted yet");
}
