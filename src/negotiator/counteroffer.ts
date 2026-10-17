// PURE: honest counteroffers (DESIGN.md §12).
//
// Honesty is by construction: the text is a fixed template filled only with
// per-head prices from stored, current, available quotes on this job. No LLM
// writes it, and the competing vendor is never named.

export interface CounterQuote {
  vendorId: string;
  vendorName: string;
  perHeadCents: number | null;
  available: boolean;
}

export interface PlannedCounter {
  vendorId: string;
  vendorName: string;
  theirPerHeadCents: number;
  bestPerHeadCents: number;
  text: string;
}

const usd = (cents: number) => (cents / 100).toFixed(2);

/** "21:30 UTC". Vendors see one unambiguous clock. */
function deadlineLabel(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function counterofferText(vendorName: string, theirCents: number, bestCents: number, deadline: Date): string {
  return [
    `Hi ${vendorName},`,
    "",
    `Thanks for your quote of $${usd(theirCents)}/person. We've received another quote of $${usd(bestCents)}/person for the same event. Are you able to match or beat that? If so, please reply with your updated price and deposit by ${deadlineLabel(deadline)}.`,
    "",
    "Thank you!",
  ].join("\n");
}

/**
 * Who gets a counteroffer, and what price it cites.
 * - Only priced, available quotes count.
 * - Skip entirely with fewer than 2 such quotes.
 * - Cite the single best per-head price; counter only vendors priced above it.
 */
export function planCounteroffers(quotes: CounterQuote[], deadline: Date): PlannedCounter[] {
  const priced = quotes.filter(
    (q): q is CounterQuote & { perHeadCents: number } => q.available && q.perHeadCents !== null,
  );
  if (priced.length < 2) return [];

  const best = priced.reduce((a, b) => (b.perHeadCents < a.perHeadCents ? b : a));

  return priced
    .filter((q) => q.vendorId !== best.vendorId && q.perHeadCents > best.perHeadCents)
    .map((q) => ({
      vendorId: q.vendorId,
      vendorName: q.vendorName,
      theirPerHeadCents: q.perHeadCents,
      bestPerHeadCents: best.perHeadCents,
      text: counterofferText(q.vendorName, q.perHeadCents, best.perHeadCents, deadline),
    }));
}
