// The quote spread (DESIGN.md "The ledger pages"): a deal's current quotes as ticks on a thin ruled line,
// the approved or recommended quote circled in pen, the budget a dashed stroke. Rendered from quoteSpread(); no quote means
// no strip. Each tick names its business on hover; the range is always printed, and a screen reader gets the sentence.
import type { CSSProperties } from "react";
import { money } from "@/lib/dashboard/format";
import { quoteSpread, type LedgerDeal } from "@/lib/dashboard/ledger";

const at = (n: number) => ({ "--at": `${(n * 100).toFixed(2)}%` }) as CSSProperties;

export function QuoteSpread({ deal }: { deal: Pick<LedgerDeal, "state" | "quotes" | "recommended_quote_id" | "approval" | "budget_usd"> }) {
  const s = quoteSpread(deal, money);
  if (!s) return <span className="hint">No quote yet</span>;
  // The circled mark draws last, so it sits on top of a tick at the same price.
  const marks = [...s.marks].sort((a, b) => Number(a.picked) - Number(b.picked));
  return (
    <span className="spread">
      <span className="sr-only">
        {s.words}: {s.marks.map((m) => `${m.business} ${money(m.total_usd)}`).join(", ")}
      </span>
      <span className="spread-line" aria-hidden="true">
        {s.budgetAt !== null ? <span className="spread-budget" style={at(s.budgetAt)} data-tip={`Budget ${money(s.budget)}`} /> : null}
        {marks.map((m) => (
          <span key={m.quote_id} className="spread-mark" data-picked={m.picked || undefined} style={at(m.at)} data-tip={`${m.business} ${money(m.total_usd)}`} />
        ))}
      </span>
      <span className="spread-range" aria-hidden="true">
        {s.low === s.high ? money(s.low) : `${money(s.low)} to ${money(s.high)}`}
      </span>
    </span>
  );
}
