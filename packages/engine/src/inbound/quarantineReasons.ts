// PURE: what each quarantine reason means for an operator, and what to do about it. Used in the job
// event (flag) of every quarantined message, the deal board's per-business line, and the logs.
// `reason` is messages.quarantine_reason ("identity_unverified:token_missing", "sender_mismatch", …).

export interface QuarantineExplanation {
  /** One line: what happened. */
  explanation: string;
  /** One line: what the operator (or the business) can do. */
  action: string;
  /** Short enough for the deal board's business line (~90 chars). */
  board: string;
}

const T: Record<string, QuarantineExplanation> = {
  "identity_unverified:token_missing": {
    explanation: "The email came from the business's address in Haggle's thread, but without Haggle's reference code (HGR-…), so the sender couldn't be verified.",
    action: "Ask the business to press Reply on Haggle's email and keep the subject line (or paste the reference), or confirm the quote by phone.",
    board: "Unverified sender: no reference code. Ask them to reply to Haggle's email, keeping the subject",
  },
  "identity_unverified:not_in_our_thread": {
    explanation: "The email doesn't reply to any message Haggle sent this business (no matching In-Reply-To/References): a new email, or a forged one.",
    action: "Ask the business to use Reply on Haggle's email instead of writing a new one.",
    board: "Unverified sender: not a reply to Haggle's email. Ask them to use Reply",
  },
  "identity_unverified:from_mismatch": {
    explanation: "The email came from a different address than the one Haggle wrote to.",
    action: "If the business really uses that address, an operator adds it as the vendor's contact; otherwise ignore it.",
    board: "Unverified sender: a different address than Haggle wrote to",
  },
  "identity_unverified:auth_failed": {
    explanation: "The mail provider reported that the sender failed authentication (SPF/DMARC fail): it is probably spoofed.",
    action: "Ignore it. If in doubt, contact the business on a channel you already know.",
    board: "Unverified sender: failed authentication (likely spoofed)",
  },
  sender_mismatch: {
    explanation: "A message in this business's thread came from another address (a forward, a colleague, or a spoof).",
    action: "Ask the business to reply from the address Haggle contacted; an operator can add another address as the vendor's contact.",
    board: "Unverified sender: someone else wrote in this business's thread",
  },
  from_unparseable: {
    explanation: "The From header couldn't be read unambiguously, so the sender is unknown.",
    action: "Ignore it unless the business confirms it sent it; then ask it to reply again.",
    board: "Unverified sender: unreadable sender address",
  },
  unknown_job_inbox: {
    explanation: "Mail to a job inbox that doesn't belong to any open deal.",
    action: "No action, unless a business is replying to an old or cancelled deal.",
    board: "Email to an unknown deal inbox",
  },
  no_signal: {
    explanation: "The email couldn't be matched to any deal (no thread, reference or job code).",
    action: "If it is a vendor's reply, ask them to reply in Haggle's email thread.",
    board: "Email not matched to any deal",
  },
  bounce: {
    explanation: "A delivery failure report names an email Haggle sent: the address doesn't accept mail.",
    action: "Find another contact (phone, another email) for the business; the address is suppressed.",
    board: "Email bounced; address suppressed",
  },
  bounce_soft: {
    explanation: "A temporary delivery problem; the mail provider keeps retrying.",
    action: "No action needed.",
    board: "Temporary delivery problem (provider retrying)",
  },
  bounce_unmatched: {
    explanation: "A bounce notice that doesn't name any email Haggle sent, so it was ignored (it may be forged).",
    action: "No action needed.",
    board: "Unmatched bounce notice ignored",
  },
  // Not quarantined but never read: stored untrusted (the trust verdict's reason).
  "unverified-external-sender": {
    explanation: "Mail from outside Inkbox can't be authenticated, and this server doesn't accept reply-token verification for it.",
    action: "To accept real vendors' replies, an operator enables HAGGLE_EXTERNAL_SENDERS=reply_token (with HAGGLE_REPLY_TOKEN_SECRET); otherwise confirm by phone.",
    board: "Unverified sender: outside email isn't accepted on this server",
  },
  "sender-not-verifiable": {
    explanation: "The sender claims to be an Inkbox identity, but Haggle couldn't confirm that identity sent this message.",
    action: "Check the Inkbox sender-trust policy and key scope; ask the business to resend.",
    board: "Unverified sender: Inkbox identity not confirmed",
  },
  pay_not_from_approver: {
    explanation: "A PAY text came from a number other than the workspace approver's.",
    action: "No action, unless the approver changed numbers: an operator updates the approver.",
    board: "PAY text from an unknown number ignored",
  },
  paid_not_from_approver: {
    explanation: "A PAID text came from a number other than the workspace approver's.",
    action: "No action, unless the approver changed numbers: an operator updates the approver.",
    board: "PAID text from an unknown number ignored",
  },
};

const FALLBACK: QuarantineExplanation = {
  explanation: "The message was held for review and not read.",
  action: "Check the raw message in the job's conversation; never act on its contents without confirming with the business.",
  board: "Message held for review",
};

/** `known`: false for a reason without a specific explanation (the generic text is used). */
export function explainQuarantine(reason: string | null | undefined): QuarantineExplanation & { reason: string; known: boolean } {
  const r = (reason ?? "").trim();
  const hit = T[r] ?? T[r.split(":")[0]!];
  return { reason: r || "unknown", known: !!hit, ...(hit ?? FALLBACK) };
}

/** The fields a quarantine flag event carries (the board shows `board_line`; operators read the rest). */
export function quarantineEventData(e: QuarantineExplanation & { reason: string }, messageId: string) {
  return { quarantine_reason: e.reason, explanation: e.explanation, action: e.action, board_line: e.board, message_id: messageId };
}

/** Every reason with an explanation (tests check each engine reason is covered). */
export const EXPLAINED_QUARANTINE_REASONS = Object.keys(T);
