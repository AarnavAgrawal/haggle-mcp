// PURE: a PDF quote whose total disagrees with the total the business wrote in the email itself
// ("$1,150 total" in the body, $1,400 on the attached quote). The extractor picks one; the human
// must see that the two disagree, so the quote is flagged `conflicting_numbers` (a caveat on the
// approval, not a block). Only the business's own words count (the caller passes cleanEmailBody text).
import type { QuoteExtraction } from "./extraction.ts";

const TOTAL_NEAR = [
  /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:usd\s*)?(?:total|all[- ]in|in total)\b/gi,
  /\b(?:total|all[- ]in)(?:\s+(?:is|of|comes to|would be|will be|price|cost))?\s*[:=]?\s*\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/gi,
];

/** Totals the body states in so many words ("$1,150 total", "Total: $1,150"), in cents. */
export function statedBodyTotals(text: string): number[] {
  const out = new Set<number>();
  for (const re of TOTAL_NEAR) for (const m of text.matchAll(re)) out.add(Number(m[1]!.replace(/,/g, "")) * 100 + Number((m[2] ?? "0").padEnd(2, "0")));
  return [...out];
}

/**
 * The extracted total came from a PDF, and the email body states a different total (by more than
 * 1% and $1). Null when they agree, the body states none, or the total isn't from a PDF.
 */
export function pdfBodyTotalConflict(x: Pick<QuoteExtraction, "total_usd" | "sources">, ownBodyText: string): { pdfCents: number; bodyCents: number[] } | null {
  if (x.total_usd === null) return null;
  const src = x.sources.find((s) => s.field === "total")?.source ?? "";
  if (!/^pdf\b/i.test(src)) return null;
  const pdfCents = Math.round(x.total_usd * 100);
  const body = statedBodyTotals(ownBodyText);
  if (!body.length || body.some((c) => Math.abs(c - pdfCents) <= Math.max(100, pdfCents * 0.01))) return null;
  return { pdfCents, bodyCents: body };
}
