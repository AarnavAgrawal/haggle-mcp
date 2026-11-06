// The deal's totals line (DESIGN.md "Deal board"): the lead quote, how it sits against the budget, how
// many businesses have quoted and what negotiating saved, closed by the bookkeeper's double rule.
import { Highlighted } from "@/components/ui/PenMarks";
import { Price } from "@/components/ui/Price";
import { money } from "@/lib/dashboard/format";
import { boardFigures } from "@/lib/dashboard/ledger";
import type { DealBoardView } from "@/lib/dashboard/types";

export function DealTotals({ board }: { board: DealBoardView }) {
  const f = boardFigures(board);
  const against = f.againstBudget;
  return (
    <dl className="deal-totals" aria-label="This deal in figures">
      <div>
        <dt>{f.lead ? `Lead quote, ${f.lead.business}` : "Lead quote"}</dt>
        <dd>{f.lead ? <Price amount={f.lead.total_usd} size="l" /> : <span className="deal-totals-none">None yet</span>}</dd>
      </div>
      <div>
        <dt>Against your budget</dt>
        <dd>
          {against === null ? (
            <span className="deal-totals-none">{f.budget === null ? "No budget set" : `Budget ${money(f.budget)}`}</span>
          ) : (
            <span className="deal-totals-num" data-over={against > 0 || undefined}>
              {against === 0 ? "On budget" : `${money(Math.abs(against))} ${against > 0 ? "over" : "under"}`}
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt>Quoted so far</dt>
        <dd>
          <span className="deal-totals-num">
            {f.quoted} of {f.asked}
          </span>
        </dd>
      </div>
      <div>
        <dt>Saved by negotiating</dt>
        <dd>
          {f.saved > 0 ? (
            <Highlighted>
              <Price amount={f.saved} size="l" />
            </Highlighted>
          ) : (
            <span className="deal-totals-none">Nothing yet</span>
          )}
        </dd>
      </div>
    </dl>
  );
}
