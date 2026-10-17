/**
 * Quote board: the MCP App view for list_quotes. Hosts that render MCP Apps
 * (Claude, ChatGPT) show this table instead of raw JSON. Agents still get the
 * same structured result, so nothing depends on the UI.
 *
 * "Ask for approval" only sends a follow-up prompt to the model; the human
 * still has to reply APPROVE <code> by email before any payment.
 */
import { ModelContext, ThemeProvider, useSendFollowUp, useToolContext } from "mcp-use/react";

type Quote = {
  quote_id: string;
  vendor: string;
  available: boolean;
  per_head: string | null;
  total: string | null;
  deposit: string | null;
  delivery: string | null;
  dietary_ok: boolean;
  valid_until: string | null;
  round: number;
  missing_fields: string[];
};

const dollars = (v: string | null) => (v === null ? "—" : `$${v}`);

function Row({ q, best, onPick }: { q: Quote; best: boolean; onPick: () => void }) {
  return (
    <tr className={best ? "bg-emerald-50 dark:bg-emerald-950/40" : undefined}>
      <td className="py-2 pr-3 font-medium text-neutral-900 dark:text-neutral-100">
        {q.vendor}
        {best && <span className="ml-2 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold uppercase text-white">Best</span>}
        {q.round > 0 && <span className="ml-2 text-xs text-neutral-500">after negotiation</span>}
      </td>
      <td className="py-2 pr-3 tabular-nums">{dollars(q.per_head)}</td>
      <td className="py-2 pr-3 tabular-nums">{dollars(q.total)}</td>
      <td className="py-2 pr-3 tabular-nums">{dollars(q.deposit)}</td>
      <td className="py-2 pr-3">{q.dietary_ok ? "Yes" : "No"}</td>
      <td className="py-2 pr-3 text-xs text-neutral-500">
        {!q.available ? "Unavailable" : q.missing_fields.length > 0 ? `Missing: ${q.missing_fields.join(", ")}` : ""}
      </td>
      <td className="py-2 text-right">
        {q.available && q.deposit !== null && (
          <button
            type="button"
            onClick={onPick}
            className="cursor-pointer rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            Ask for approval
          </button>
        )}
      </td>
    </tr>
  );
}

export default function QuoteBoard() {
  const view = useToolContext<"list_quotes">();
  const sendFollowUp = useSendFollowUp();

  if (view.status === "pending") {
    return (
      <ThemeProvider>
        <div className="p-4 text-sm text-neutral-500">Comparing quotes…</div>
      </ThemeProvider>
    );
  }
  if (view.status === "error") {
    return (
      <ThemeProvider>
        <div className="p-4 text-sm text-red-600">{view.error.message}</div>
      </ThemeProvider>
    );
  }

  const out = view.toolOutput;
  const pick = (q: Quote) =>
    void sendFollowUp({
      prompt: `Request approval for the ${q.vendor} quote (quote_id ${q.quote_id}, deposit $${q.deposit}).`,
    }).catch(() => {});

  return (
    <ThemeProvider>
      <ModelContext
        content={`Quote board for job ${out.job_id}: ${out.quotes.length} quote(s); best is ${out.quotes.find((q) => q.quote_id === out.best_quote_id)?.vendor ?? "none yet"}.`}
      />
      <div className="p-4 text-sm text-neutral-700 dark:text-neutral-300">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="m-0 text-base font-semibold text-neutral-900 dark:text-neutral-100">Catering quotes</h2>
          <span className="text-xs uppercase tracking-wide text-neutral-500">{out.status.replace("_", " ")}</span>
        </div>
        {out.quotes.length === 0 ? (
          <p className="m-0 text-neutral-500">No quotes yet. Vendors usually reply within a few minutes.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase text-neutral-500 dark:border-neutral-700">
                  <th className="py-2 pr-3 font-medium">Vendor</th>
                  <th className="py-2 pr-3 font-medium">Per head</th>
                  <th className="py-2 pr-3 font-medium">Total</th>
                  <th className="py-2 pr-3 font-medium">Deposit</th>
                  <th className="py-2 pr-3 font-medium">Dietary</th>
                  <th className="py-2 pr-3 font-medium">Notes</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {out.quotes.map((q) => (
                  <Row key={q.quote_id} q={q} best={q.quote_id === out.best_quote_id} onPick={() => pick(q)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {out.no_quote.length > 0 && (
          <p className="mt-3 mb-0 text-xs text-neutral-500">
            No quote: {out.no_quote.map((n) => `${n.vendor} (${n.reason.replace("_", " ")})`).join(", ")}
          </p>
        )}
      </div>
    </ThemeProvider>
  );
}
