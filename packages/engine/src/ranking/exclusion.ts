// PURE: why a contacted vendor isn't in the comparison, in one plain line (sprint 5 A). A vendor with a
// current priced quote is compared, and its quote's selection reason (selection.ts) says why it was or
// wasn't picked; this covers the rest: it declined, couldn't be reached, asked a question first, sent a
// reply Haggle couldn't read, or never replied before quotes closed. Contact problems Haggle tracks
// separately (bounced, opted out, held for review, deferred: inbound/contactStatus.ts) take precedence.

export type ExclusionStatus = "declined" | "unreachable" | "asked_question" | "reply_unreadable" | "no_reply";

export interface ExclusionFacts {
  name: string;
  channel: string;
  /** The vendor has a current quote with a total: it is compared (null result). */
  compared: boolean;
  declined: boolean;
  /** Why Haggle couldn't contact it at all (a business with no usable channel). */
  unreachable?: string | null;
  /** The question it asked before quoting, still unanswered. */
  question?: string | null;
  unreadable: boolean;
  /** Quotes are final (or the deal moved on): a vendor that hasn't quoted by now is out. */
  quotesFinal: boolean;
  /** It replied at all (a reply that isn't a quote, a question, or unreadable). */
  replied: boolean;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function exclusionOf(f: ExclusionFacts): { status: ExclusionStatus; detail: string } | null {
  if (f.compared) return null;
  const name = clip(f.name, 30);
  if (f.declined) return { status: "declined", detail: `${name} said it can't do this order, so it isn't compared.` };
  if (f.unreachable) return { status: "unreachable", detail: clip(`${name} couldn't be contacted (${f.unreachable}), so it isn't compared.`, 140) };
  if (f.question) return { status: "asked_question", detail: clip(`${name} asked a question before quoting ("${f.question}") and hasn't quoted yet.`, 140) };
  if (f.unreadable) return { status: "reply_unreadable", detail: `${name} replied, but Haggle couldn't read a price from it, so it isn't compared.` };
  if (!f.quotesFinal) return null;
  return f.replied
    ? { status: "no_reply", detail: `${name} replied without a quote before quotes closed, so it isn't compared.` }
    : { status: "no_reply", detail: `${name} didn't reply (${f.channel}) before quotes closed, so it isn't compared.` };
}

/** "Not compared: Golden Grill (no reply), Bay Catering (declined)" for the agent's next hint, or "". */
export function exclusionLine(rows: { name: string; status: string }[]): string {
  if (!rows.length) return "";
  const word: Record<string, string> = { declined: "declined", unreachable: "couldn't be contacted", asked_question: "asked a question first", reply_unreadable: "unreadable reply", no_reply: "no quote", bounced: "email bounced", failed: "send failed", opted_out: "opted out", quarantined_reply: "reply held for review", scheduled: "contact deferred" };
  return `Not compared: ${rows.slice(0, 6).map((r) => `${clip(r.name, 30)} (${word[r.status] ?? r.status.replace(/_/g, " ")})`).join(", ")}${rows.length > 6 ? ` (+${rows.length - 6} more)` : ""}.`;
}
