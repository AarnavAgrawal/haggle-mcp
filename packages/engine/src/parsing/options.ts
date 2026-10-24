// PURE: priced options a business offers instead of one total ("Option A, sandwich platters: $890.
// Option B, hot buffet: $1,180. Which would you prefer?"). Read from the business's own words (never a
// call transcript: it holds the agent's words too). Live eval 2026-10-23 (c45): Claude asked the human
// "Which would you prefer?" and kept neither price, so the human was asked to choose without the choices.
//
// Options are kept for the human to choose from, never as a total: none is approvable until the business
// confirms the chosen one's total (its next reply is an ordinary quote, checked like any other).

export interface PricedOption {
  /** The business's own label ("Option A, sandwich platters"). */
  label: string;
  /** The price it stated for that option, in cents, as stated (delivery, tax and fees per its reply). */
  cents: number;
  excerpt: string;
}

const NAME = String.raw`(?:option|package|choice|tier|menu)\s+(?:[A-Z]|\d{1,2}|one|two|three|four)\b`;
/** "Option A, sandwich platters: $890", "Package 2 (hot buffet) - $1,180", "Option B: $1,180 for the buffet". */
const OPTION = new RegExp(String.raw`\b(${NAME})([^$\n.;]{0,60}?)[:\-–—=]?\s*\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?`, "gi");

/** Two or more distinctly labelled, priced options (else []): one labelled price is just a quote. */
export function pricedOptions(text: string): PricedOption[] {
  const seen = new Map<string, PricedOption>();
  for (const m of text.matchAll(OPTION)) {
    const name = m[1]!.replace(/\s+/g, " ").trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const detail = m[2]!.replace(/^[\s,(]+|[\s,):\-–—]+$/g, "").trim();
    const cents = Number(m[3]!.replace(/,/g, "")) * 100 + Number(m[4] ?? 0);
    if (!(cents > 0)) continue;
    seen.set(key, { label: detail ? `${name}, ${detail}`.slice(0, 80) : name, cents, excerpt: m[0].trim().slice(0, 160) });
  }
  const out = [...seen.values()];
  return out.length >= 2 ? out.slice(0, 6) : [];
}

/** "Option A, sandwich platters $890; Option B, hot buffet $1,180" (for the question the human answers). */
export function optionsLine(options: readonly PricedOption[]): string {
  return options.map((o) => `${o.label} $${(o.cents / 100).toLocaleString("en-US", { minimumFractionDigits: o.cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`).join("; ");
}
