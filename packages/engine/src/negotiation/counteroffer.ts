// PURE: honest counteroffers.
//
// Honesty is by construction: the text is a fixed template filled only with totals from stored,
// current quotes on this job. No LLM writes it, and the competing business is never named.
//
// Adapted from quote-broker@8a68559 src/negotiator/counteroffer.ts (Partner). Changes for Haggle
// v3: cites order totals (not per-head), only quotes that are compliant AND from a trusted
// sender can be cited or countered, every plan carries the cited quote's id for the audit trail
// (a counter can't exist without a real basis quote), and rounds are capped. Eligibility is the
// ranker's own `rejectReason`, so a quote that can't win (scam link, injection, unverified, over
// budget, superseded) can never be cited either.
import { rejectReason, type RankableQuote } from "../ranking/rank.ts";

export interface CounterQuote {
  quoteId: string;
  businessId: string;
  businessName: string;
  totalCents: number | null;
  available: boolean;
  compliant: boolean; // every hard requirement met === true
  senderTrusted: boolean;
  round: number; // this business's current quote round (1 = first quote)
  status: RankableQuote["status"];
  confidence: number;
  flags: string[];
  /** The business's own stated extras (levers a target counter may mention). */
  deliveryFeeCents?: number | null;
  depositCents?: number | null;
  /** The business hedged this total ("around $1,300"): cited only as "about $X", never as a firm quote. */
  approximate?: boolean;
}

export interface PlannedCounter {
  businessId: string;
  businessName: string;
  round: number; // the round this counter opens
  theirTotalCents: number;
  targetTotalCents: number;
  basisQuoteId: string; // the real competing quote cited, or "buyer_target"
  /** competing_quote: cites a real cheaper eligible quote. buyer_target: the buyer's stated target. */
  basis: "competing_quote" | "buyer_target";
  /** The cited competing total is the other business's approximation (said as "about $X"). */
  basisApproximate: boolean;
  text: string;
  /** Short form for text messages (iMessage/RCS). */
  shortText: string;
}

const usd = (cents: number) => `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;
/** Their own figure, as firm as they said it. */
const theirs = (cents: number, approximate = false) => `${approximate ? "estimate of about" : "quote of"} ${usd(cents)} total`;

/** "21:30 UTC". Businesses see one unambiguous clock. */
function deadlineLabel(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function counterofferText(businessName: string, theirCents: number, bestCents: number, deadline: Date, opts: { theirApproximate?: boolean; bestApproximate?: boolean } = {}): string {
  return [
    `Hi ${businessName},`,
    "",
    `Thanks for your ${theirs(theirCents, opts.theirApproximate)}. We've received another ${theirs(bestCents, opts.bestApproximate)} for the same order and requirements${opts.bestApproximate ? " (not yet confirmed as firm)" : ""}. Are you able to match or beat that? If so, please reply with your updated firm total and deposit by ${deadlineLabel(deadline)}.`,
    "",
    "Thank you!",
  ].join("\n");
}

/**
 * Who gets a counteroffer, and which real quote it cites.
 * - Only quotes the ranker would accept count, as basis or as target.
 * - Skip entirely with fewer than 2 such quotes.
 * - Cite the single best total; counter only businesses priced above it with rounds left.
 */
export function targetCounterText(businessName: string, theirCents: number, targetCents: number, deadline: Date, levers: { deliveryFeeCents?: number | null; depositCents?: number | null; approximate?: boolean } = {}): string {
  const asks = [levers.deliveryFeeCents ? `the ${usd(levers.deliveryFeeCents)} delivery fee` : "", levers.depositCents && levers.depositCents > theirCents * 0.25 ? `the ${usd(levers.depositCents)} deposit` : ""].filter(Boolean);
  return [
    `Hi ${businessName},`,
    "",
    `Thanks for your ${theirs(theirCents, levers.approximate)}. Our client's budget target for this order is ${usd(targetCents)} total. Is there anything you can do to get closer to it${asks.length ? ` (for example on ${asks.join(" or ")})` : ""}? If so, please reply with your updated firm total and deposit by ${deadlineLabel(deadline)}.`,
    "",
    "Thank you!",
  ].join("\n");
}

/**
 * Who gets a counteroffer, and on what truthful basis.
 * - competing_quote: only quotes the ranker accepts count, as basis or as target; the single best
 *   total is cited to every business priced above it (needs at least 2 such quotes).
 * - buyer_target: when the buyer gave a target (not a hard limit) and the best eligible quote is
 *   still above it, that business is asked to get closer to the target. No competing price is
 *   invented; only the buyer's own target and the business's own stated fees are mentioned.
 * Rounds are capped per business.
 */
export function planCounteroffers(quotes: CounterQuote[], deadline: Date, maxRounds = 2, budgetCents: number | null = null, targetCents: number | null = null): PlannedCounter[] {
  const eligible = quotes.filter((q): q is CounterQuote & { totalCents: number } => rejectReason(q, budgetCents) === null);
  if (eligible.length === 0) return [];
  const best = eligible.reduce((a, b) => (b.totalCents < a.totalCents ? b : a));
  const out: PlannedCounter[] = [];
  if (eligible.length >= 2) {
    for (const q of eligible.filter((q) => q.businessId !== best.businessId && q.totalCents > best.totalCents && q.round < maxRounds)) {
      out.push({
        businessId: q.businessId, businessName: q.businessName, round: q.round + 1, theirTotalCents: q.totalCents, targetTotalCents: best.totalCents,
        basisQuoteId: best.quoteId, basis: "competing_quote", basisApproximate: best.approximate === true,
        text: counterofferText(q.businessName, q.totalCents, best.totalCents, deadline, { theirApproximate: q.approximate === true, bestApproximate: best.approximate === true }),
        shortText: `Thanks! We have another ${theirs(best.totalCents, best.approximate)} for the same order. Can you match or beat it?`,
      });
    }
  }
  if (targetCents !== null && best.totalCents > targetCents && best.round < maxRounds) {
    out.push({
      businessId: best.businessId, businessName: best.businessName, round: best.round + 1, theirTotalCents: best.totalCents, targetTotalCents: targetCents,
      basisQuoteId: "buyer_target", basis: "buyer_target", basisApproximate: false, text: targetCounterText(best.businessName, best.totalCents, targetCents, deadline, best),
      shortText: `Thanks! Our client's target is ${usd(targetCents)} total. Anything you can do to get closer (delivery or deposit)?`,
    });
  }
  return out;
}
