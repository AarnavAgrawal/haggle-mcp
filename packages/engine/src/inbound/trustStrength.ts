// PURE: conversation continuity vs sender identity. A reply verified only by Haggle's reply token
// ("external-reply-token") proves that whoever wrote it holds the email Haggle sent to that address,
// the strength of an email-verification link; anyone with access to the mailbox, or a forwarded
// copy whose recipient then spoofs the From, passes it. That is enough to read a quote (the human
// still approves out of band), never enough on its own to name a payee, settle a payment, or be
// passed to the human as trustworthy payment details.

/** Trust reasons that prove only continuity with Haggle's thread, not who sent the mail. */
export const CONTINUITY_ONLY_REASONS: ReadonlySet<string> = new Set(["external-reply-token"]);

/** Trusted, and by something stronger than thread continuity (provider authentication, a pinned identity, channel). */
export function provesSenderIdentity(m: { sender_trusted: boolean | null; trust_reason: string | null }): boolean {
  return m.sender_trusted === true && !!m.trust_reason && !CONTINUITY_ONLY_REASONS.has(m.trust_reason);
}

export const CONTINUITY_ONLY_WARNING = "the sender was verified only by Haggle's reply reference (anyone with access to that email thread could send this), not by its mail provider: confirm these payment details with the business by phone before paying";
