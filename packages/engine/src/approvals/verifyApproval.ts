// Reused unchanged from quote-broker@8a68559 src/approvals/verifyApproval.ts (Partner).
// Haggle uses it for email approvals; senderTrusted must come from isTrustedSender on the signed
// webhook event (see docs/v3-prekickoff-readiness.md section 7B).
// PURE: does an email reply approve, decline, or do nothing? (DESIGN.md §13.2)
//
// An approval needs ALL of: the right thread, the registered approver's exact
// address, an authenticated sender (DKIM/DMARC verified upstream), a pending
// unexpired approval, and "APPROVE <code>" in the first line the human wrote.
// Quoted text is ignored, because our own email contains the code.

export interface ApprovalForVerify {
  status: string;
  code: string;
  approver_email: string;
  expires_at: string;
}

export interface ApprovalReply {
  /** Bare sender address, as parsed from the From header. */
  from: string;
  /** isTrustedSender verdict for the approver's domain and address. */
  senderTrusted: boolean;
  /** The reply matched this approval's thread (DESIGN.md §10.5). */
  threadMatched: boolean;
  bodyText: string | null;
}

export type Verdict =
  | { decision: "approve" }
  | { decision: "decline" }
  | {
      decision: "ignore";
      reason: "thread_mismatch" | "wrong_sender" | "sender_not_authenticated" | "not_pending" | "expired" | "no_valid_command";
    };

// Lines that start the quoted original in common mail clients.
const SEPARATORS = [
  /^On .+wrote:\s*$/i, // Gmail / Apple Mail (single-line form)
  /^On .+<?[^\s@]+@[^\s@]+/i, // Gmail when the "wrote:" wraps to the next line
  /^-{2,}\s*Original Message\s*-{2,}/i, // Outlook
  /^From:\s/i, // Outlook header block
  /^_{5,}\s*$/, // Outlook web divider
];

/** First line the human actually wrote: skip blanks and "> quoted" lines, stop at a separator. */
export function firstReplyLine(body: string | null): string | null {
  if (!body) return null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith(">")) continue;
    if (SEPARATORS.some((re) => re.test(line))) return null;
    return line;
  }
  return null;
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function verifyApproval(approval: ApprovalForVerify, reply: ApprovalReply, now: Date): Verdict {
  if (!reply.threadMatched) return { decision: "ignore", reason: "thread_mismatch" };
  if (!sameAddress(reply.from, approval.approver_email)) return { decision: "ignore", reason: "wrong_sender" };
  if (!reply.senderTrusted) return { decision: "ignore", reason: "sender_not_authenticated" };
  if (approval.status !== "pending") return { decision: "ignore", reason: "not_pending" };
  if (now.getTime() > Date.parse(approval.expires_at)) return { decision: "ignore", reason: "expired" };

  const line = firstReplyLine(reply.bodyText);
  if (line) {
    // Decline first: "No, don't approve 4821" carries the code but is a refusal.
    if (/^\W*NO\b/i.test(line)) return { decision: "decline" };
    // Any other negation of the approve ("I can't approve 4821 yet") is never an approval.
    if (/\b(?:not|don'?t|can'?t|cannot|won'?t|never)\b[^.!?]*\bAPPROVE\b/i.test(line)) return { decision: "ignore", reason: "no_valid_command" };
    const approve = line.match(/\bAPPROVE\b\W{0,3}(\d{4})\b/i);
    if (approve && approve[1] === approval.code) return { decision: "approve" };
  }
  return { decision: "ignore", reason: "no_valid_command" };
}
