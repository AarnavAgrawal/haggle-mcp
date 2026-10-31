// PURE: conversation continuity vs sender identity. A reply verified only by naming Haggle's own
// Message-ID ("external-thread-reply"; before 2026-10-30 the reply token, "external-reply-token")
// proves that whoever wrote it holds the email Haggle sent to that address,
// the strength of an email-verification link; anyone with access to the mailbox, or a forwarded
// copy whose recipient then spoofs the From, passes it. That is enough to read a quote (the human
// still approves out of band), never enough on its own to name a payee, settle a payment, or be
// passed to the human as trustworthy payment details.
//
// "operator_verified" (a quarantined email an operator released after checking it with the business
// on an independent channel, inbound/quarantineReview.ts) is continuity-only too, on purpose: the
// operator confirmed the quote's content, not who controls the sending mailbox, so payment details,
// a payee or a binding confirmation arriving that way still need their own check.

/**
 * Trust reasons that prove only continuity with Haggle's thread, not who sent the mail:
 * "external-thread-reply" (a reply naming one of Haggle's own Message-IDs, from the pinned address),
 * "external-sender-only" (a new email from the pinned address of a business with exactly one open
 * deal: weaker still, no thread at all), and "external-reply-token" (the legacy reply token, before
 * 2026-10-30; kept for stored rows).
 */
export const CONTINUITY_ONLY_REASONS: ReadonlySet<string> = new Set(["external-thread-reply", "external-sender-only", "external-reply-token", "operator_verified"]);

/**
 * Trust reasons that rest on a phone number the sender claims (decision H2/H1, 2026-10-22): a text from
 * the business's pinned number (SMS or iMessage) or an inbound call matched by caller ID. Both can be
 * spoofed, so they are enough to read a quote, never to confirm a booking, verify a payment or name a payee.
 */
export const TEXT_OR_CALLER_ID_REASONS: ReadonlySet<string> = new Set(["sms-reply-to-pinned-number", "imessage-from-pinned-number", "inbound-caller-id-match (operator opt-in)"]);

/** Trusted, and by something stronger than thread continuity or a claimed number (provider authentication, a pinned identity Haggle reached itself). */
export function provesSenderIdentity(m: { sender_trusted: boolean | null; trust_reason: string | null }): boolean {
  return m.sender_trusted === true && !!m.trust_reason && !CONTINUITY_ONLY_REASONS.has(m.trust_reason) && !TEXT_OR_CALLER_ID_REASONS.has(m.trust_reason);
}

export const CONTINUITY_ONLY_WARNING = "the sender was verified only by its reply in Haggle's email thread (anyone with access to that email thread could send this), not by its mail provider: confirm these payment details with the business by phone before paying";

/** What the human is told when a binding confirmation arrives from a continuity-only sender. */
export const UNVERIFIED_CONFIRMATION_WARNING = "this confirmation was verified only by its reply in Haggle's email thread, not by the business's mail provider: confirm the booking with the business on a number you already know before relying on it or paying";

/** What the human is told when a binding confirmation arrives by text (or a caller-ID-matched call). */
export const TEXT_CONFIRMATION_WARNING = "this confirmation came by text from the business's number, which can't prove who sent it: confirm the booking with the business on a number you already know before relying on it or paying";

export type SenderIdentity = "verified" | "thread_only" | "text_only" | "unverified";

/**
 * How far a reply may move a purchase, by the strength of its sender verification. Binding
 * financial terms are a booking confirmation, a changed price or deposit, payment instructions, a
 * payee, or a receipt ("payment received").
 *   - verified: provider authentication or a pinned identity; may confirm a booking and settle.
 *   - thread_only: the reply token or an operator release. Recorded and shown, but a confirmation
 *     needs the human's explicit acknowledgement (`requiresHumanAck`), payment details carry a
 *     confirm-by-phone warning, and it never names a payee or marks money received.
 *   - text_only: a text from the business's number or a caller-ID-matched call; treated like thread_only.
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
  const identity = senderIdentityOf(m);
  const verified = identity === "verified";
  return {
    senderIdentity: identity, mayConfirmBooking: verified, requiresHumanAck: identity === "thread_only" || identity === "text_only", mayNamePayee: verified, mayVerifySettlement: verified,
    warning: verified ? null : identity === "thread_only" ? UNVERIFIED_CONFIRMATION_WARNING : identity === "text_only" ? TEXT_CONFIRMATION_WARNING : "the sender could not be verified at all: ignore it",
  };
}

/** How strongly a trusted message's sender is identified (see bindingTermsTrust). */
export function senderIdentityOf(m: { sender_trusted: boolean | null; trust_reason: string | null }): SenderIdentity {
  if (provesSenderIdentity(m)) return "verified";
  if (m.sender_trusted !== true) return "unverified";
  return m.trust_reason && TEXT_OR_CALLER_ID_REASONS.has(m.trust_reason) ? "text_only" : "thread_only";
}

/** The same verdict from a trust reason alone (the booking hook has the reason, not a stored row). */
export function bindingTermsTrustFor(trustReason: string | null, senderTrusted = true): ReturnType<typeof bindingTermsTrust> {
  return bindingTermsTrust({ sender_trusted: senderTrusted, trust_reason: trustReason });
}
