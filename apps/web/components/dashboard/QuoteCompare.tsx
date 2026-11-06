// Compare (DESIGN.md "Deal board"): the deal's quotes side by side, one column per business and one row
// per fact, so terms read across instead of being opened one by one. Reading only: choosing a quote stays
// on the sheet above. Scrolls sideways inside itself on a narrow screen. Business text is plain text.
import { Circled } from "@/components/ui/PenMarks";
import { Price } from "@/components/ui/Price";
import { compareMatrix } from "@/lib/dashboard/ledger";
import type { DealBoardView } from "@/lib/dashboard/types";

export function QuoteCompare({ board }: { board: DealBoardView }) {
  const m = compareMatrix(board);
  if (!m) return null;
  const [total, ...facts] = m.rows;
  return (
    <section className="compare" aria-labelledby="compare-h">
      <h2 id="compare-h" className="section-h">
        Compare
      </h2>
      {/* Focusable so a keyboard can scroll it sideways on a narrow screen. */}
      <div className="compare-scroll" role="group" aria-label="Quotes side by side" tabIndex={0}>
        <table className="compare-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Detail</span>
              </th>
              {m.columns.map((c) => (
                <th key={c.quote_id} scope="col">
                  {c.business}
                  {c.recommended ? <span className="compare-pick">Recommended</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="compare-total">
              <th scope="row">{total!.label}</th>
              {m.columns.map((c, i) => {
                const price = <Price amount={c.total_usd} size="m" />;
                return (
                  <td key={c.quote_id} data-tone={total!.cells[i]!.tone}>
                    {c.recommended ? <Circled>{price}</Circled> : price}
                    {total!.cells[i]!.tone === "best" ? <span className="compare-low">Lowest</span> : null}
                  </td>
                );
              })}
            </tr>
            {facts.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                {r.cells.map((c, i) => (
                  <td key={m.columns[i]!.quote_id} data-tone={c.tone}>
                    {c.text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
