// PURE: honest counteroffers.
//
// Honesty is by construction: the text is a fixed template filled only with totals from stored,
// current quotes on this job. No LLM writes it, and the competing business is never named.
//
// Adapted from quote-broker@8a68559 src/negotiator/counteroffer.ts (Partner). Changes for Haggle
// v3: cites order totals (not per-head), only quotes that are compliant AND from a trusted
// sender can be cited or countered, every plan carries the cited quote's id for the audit trail
// (a counter can't exist without a real basis quote), and rounds are capped.

export interface CounterQuote {
  quoteId: string;
  businessId: string;
  businessName: string;
  totalCents: number | null;
  available: boolean;
  compliant: boolean; // every hard requirement met === true
  senderTrusted: boolean;
  round: number; // this business's current quote round (1 = first quote)
}

export interface PlannedCounter {
  businessId: string;
  businessName: string;
  round: number; // the round this counter opens
  theirTotalCents: number;
  targetTotalCents: number;
  basisQuoteId: string; // the real competing quote cited
  text: string;
}

const usd = (cents: number) => `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;

/** "21:30 UTC". Businesses see one unambiguous clock. */
function deadlineLabel(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function counterofferText(businessName: string, theirCents: number, bestCents: number, deadline: Date): string {
  return [
    `Hi ${businessName},`,
    "",
    `Thanks for your quote of ${usd(theirCents)} total. We've received another quote of ${usd(bestCents)} total for the same order and requirements. Are you able to match or beat that? If so, please reply with your updated total and deposit by ${deadlineLabel(deadline)}.`,
    "",
    "Thank you!",
  ].join("\n");
}

/**
 * Who gets a counteroffer, and which real quote it cites.
 * - Only available, compliant, trusted, priced quotes count, as basis or as target.
 * - Skip entirely with fewer than 2 such quotes.
 * - Cite the single best total; counter only businesses priced above it with rounds left.
 */
export function planCounteroffers(quotes: CounterQuote[], deadline: Date, maxRounds = 2): PlannedCounter[] {
  const eligible = quotes.filter(
    (q): q is CounterQuote & { totalCents: number } => q.available && q.compliant && q.senderTrusted && q.totalCents !== null,
  );
  if (eligible.length < 2) return [];

  const best = eligible.reduce((a, b) => (b.totalCents < a.totalCents ? b : a));

  return eligible
    .filter((q) => q.businessId !== best.businessId && q.totalCents > best.totalCents && q.round < maxRounds)
    .map((q) => ({
      businessId: q.businessId,
      businessName: q.businessName,
      round: q.round + 1,
      theirTotalCents: q.totalCents,
      targetTotalCents: best.totalCents,
      basisQuoteId: best.quoteId,
      text: counterofferText(q.businessName, q.totalCents, best.totalCents, deadline),
    }));
}
