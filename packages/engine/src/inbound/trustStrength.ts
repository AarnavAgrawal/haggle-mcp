// PURE: conversation continuity vs sender identity. A reply verified only by Haggle's reply token
// ("external-reply-token") proves that whoever wrote it holds the email Haggle sent to that address,
// the strength of an email-verification link; anyone with access to the mailbox, or a forwarded
// copy whose recipient then spoofs the From, passes it. That is enough to read a quote (the human
// still approves out of band), never enough on its own to name a payee, settle a payment, or be
// passed to the human as trustworthy payment details.
//
// "operator_verified" (a quarantined email an operator released after checking it with the business
// on an independent channel, inbound/quarantineReview.ts) is continuity-only too, on purpose: the
// operator confirmed the quote's content, not who controls the sending mailbox, so payment details,
// a payee or a binding confirmation arriving that way still need their own check.

/** Trust reasons that prove only continuity with Haggle's thread, not who sent the mail. */
export const CONTINUITY_ONLY_REASONS: ReadonlySet<string> = new Set(["external-reply-token", "operator_verified"]);

/** Trusted, and by something stronger than thread continuity (provider authentication, a pinned identity, channel). */
export function provesSenderIdentity(m: { sender_trusted: boolean | null; trust_reason: string | null }): boolean {
  return m.sender_trusted === true && !!m.trust_reason && !CONTINUITY_ONLY_REASONS.has(m.trust_reason);
}

export const CONTINUITY_ONLY_WARNING = "the sender was verified only by Haggle's reply reference (anyone with access to that email thread could send this), not by its mail provider: confirm these payment details with the business by phone before paying";

/** What the human is told when a binding confirmation arrives from a continuity-only sender. */
export const UNVERIFIED_CONFIRMATION_WARNING = "this confirmation was verified only by Haggle's reply reference, not by the business's mail provider: confirm the booking with the business on a number you already know before relying on it or paying";

export type SenderIdentity = "verified" | "thread_only" | "unverified";

/**
 * How far a reply may move a purchase, by the strength of its sender verification. Binding
 * financial terms are a booking confirmation, a changed price or deposit, payment instructions, a
 * payee, or a receipt ("payment received").
 *   - verified: provider authentication or a pinned identity; may confirm a booking and settle.
 *   - thread_only: the reply token or an operator release. Recorded and shown, but a confirmation
 *     needs the human's explicit acknowledgement (`requiresHumanAck`), payment details carry a
 *     confirm-by-phone warning, and it never names a payee or marks money received.
 *   - unverified: never read for any of it (callers should not reach this; it is the safe default).
 */
export function bindingTermsTrust(m: { sender_trusted: boolean | null; trust_reason: string | null }): {
  senderIdentity: SenderIdentity;
  /** May mark the booking confirmed without a human acknowledging it. */
  mayConfirmBooking: boolean;
  /** The human must acknowledge (e.g. "OK <code>" / the card) before the confirmation counts or the handoff starts. */
  requiresHumanAck: boolean;
  /** May name or change the payment recipient (x402 payTo, a manual payee). */
  mayNamePayee: boolean;
  /** May mark a payment received/settled_verified. */
  mayVerifySettlement: boolean;
  /** Text for the human and the job event when not fully verified. */
  warning: string | null;
} {
  const identity: SenderIdentity = provesSenderIdentity(m) ? "verified" : m.sender_trusted === true ? "thread_only" : "unverified";
  const verified = identity === "verified";
  return {
    senderIdentity: identity, mayConfirmBooking: verified, requiresHumanAck: identity === "thread_only", mayNamePayee: verified, mayVerifySettlement: verified,
    warning: verified ? null : identity === "thread_only" ? UNVERIFIED_CONFIRMATION_WARNING : "the sender could not be verified at all: ignore it",
  };
}

/** The same verdict from a trust reason alone (the booking hook has the reason, not a stored row). */
export function bindingTermsTrustFor(trustReason: string | null, senderTrusted = true): ReturnType<typeof bindingTermsTrust> {
  return bindingTermsTrust({ sender_trusted: senderTrusted, trust_reason: trustReason });
}
