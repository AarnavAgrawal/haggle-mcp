/**
 * Haggle deal board: the MCP App view for get_quotes. Shows a purchase in seconds: who was
 * contacted, what each business quoted (one schema), what's wrong with the risky ones, the
 * honest winner, and where approval and payment stand.
 *
 * Pattern from quote-broker@8a68559 views/quote-board (Partner): agents get the same structured
 * result, so nothing depends on the UI; buttons never authorize anything. "Approve" and "Pay"
 * ask the model to call the tools, and approval itself is the human-only form or verified email.
 */
import { ModelContext, ThemeProvider, useCallTool, useOpenExternal, useSendFollowUp, useToolContext, useViewTheme } from "mcp-use/react";
import { useEffect, useMemo, useState } from "react";
import "./view.css";

type Flag = string;
type Quote = {
  quote_id: string; business_id: string; business: string; total_usd: number; per_unit_usd?: number; deposit_usd?: number; delivery_usd?: number;
  meets_requirements: boolean; requirement_results: { requirement_id: string; met: boolean | null }[]; missing: string[]; flags: Flag[];
  price_check?: "good" | "typical" | "high"; negotiated_from?: number; round: number; confidence: number; source: string;
  evidence: Record<string, { provenance: string; source: string; excerpt?: string }>; status: string; items: string[];
};
type Payment = { status: string; amount_usd?: number; amount_usdc_base_units?: string; network: string; settle_tx?: string; explorer_url?: string; simulated: boolean; reason?: string };
type Deal = {
  ok: boolean; mode: "mock" | "live"; job_id: string; state: string; ready: boolean; inbox: string; next: string;
  request: { what: string; quantity: number; unit?: string; date: string; area: string; requirements: { id: string; text: string; hard: boolean }[] };
  budget_usd: number | null; quotes: Quote[]; recommended_quote_id?: string;
  rejected: { business_id: string; reason: Flag }[]; pending_questions: { question_id: string; business_id: string; text: string }[];
  business_names: Record<string, string>; businesses: { business_id: string; business: string; status: string; simulated: boolean }[];
  approval: { approval_id: string; quote_id: string; quote_total_usd: number; payment_usd: number; approver: string; channel: string; approved_at: string; expires_at: string } | null;
  payment: Payment | null;
};

const usd = (n: number | undefined | null) => (n === undefined || n === null || n === 0 ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);
const FLAG_LABEL: Record<string, [string, "risk" | "warn" | "info"]> = {
  requirement_unmet: ["Requirement unmet", "risk"], requirement_unknown: ["Requirement unclear", "warn"], hidden_deposit: ["Hidden deposit", "warn"],
  hidden_fee: ["Hidden fee", "warn"], tax_excluded: ["Tax extra", "warn"], delivery_unclear: ["Delivery unclear", "warn"], vague_price: ["Vague price", "warn"],
  conflicting_numbers: ["Conflicting numbers", "risk"], expired: ["Expired", "warn"], external_payment_link: ["Payment link (blocked)", "risk"],
  prompt_injection: ["Prompt injection", "risk"], unverified_sender: ["Unverified sender", "risk"], over_budget: ["Over budget", "risk"],
  low_confidence: ["Low confidence", "warn"], question_pending: ["Question pending", "info"], unsourced_figure: ["Unsourced figure", "warn"],
};
const STATE_LABEL: Record<string, string> = {
  created: "Created", contacting: "Contacting", collecting: "Collecting quotes", negotiating: "Negotiating", awaiting_approval: "Awaiting approval",
  paying: "Paying", paid: "Paid", cancelled: "Cancelled", failed: "Failed",
};
const PIPE: [string, string[]][] = [
  ["Contacted", ["contacted", "pending"]], ["Responding", ["replied"]], ["Question", ["question"]], ["Quoted", ["quoted"]], ["Out", ["declined", "bounced", "silent"]],
];
const PAY_STEPS = ["awaiting_approval", "awaiting_invoice", "invoice_received", "signed", "sent", "settled"];
const PAY_LABEL: Record<string, string> = { awaiting_approval: "Approval", awaiting_invoice: "Invoice requested", invoice_received: "Invoice checked", signed: "Signed", sent: "Sent in thread", settled: "Settled" };

function Chip({ flag }: { flag: Flag }) {
  const [label, tone] = FLAG_LABEL[flag] ?? [flag.replace(/_/g, " "), "info"];
  return <span className={`hg-chip hg-${tone}`}>{label}</span>;
}

export default function DealBoard() {
  const view = useToolContext<"get_quotes">();
  const theme = useViewTheme();
  const refresh = useCallTool("get_quotes");
  const answer = useCallTool("answer_seller");
  const followUp = useSendFollowUp();
  const openExternal = useOpenExternal();
  const [open, setOpen] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const initial = view.status === "ready" ? (view.toolOutput as unknown as Deal) : null;
  const latest = (refresh.data?.structuredContent as unknown as Deal | undefined) ?? initial;
  const jobId = latest?.job_id ?? (view.toolInput as { job_id?: string } | undefined)?.job_id;
  const terminal = latest ? ["paid", "cancelled", "failed"].includes(latest.state) : false;

  // Live: re-read the deal every 4 s until it finishes.
  useEffect(() => {
    if (!jobId || terminal) return;
    const t = window.setInterval(() => { if (!refresh.isPending) void refresh.callTool({ job_id: jobId }).catch(() => {}); }, 4000);
    return () => window.clearInterval(t);
  }, [jobId, terminal]); // eslint-disable-line react-hooks/exhaustive-deps

  const rec = useMemo(() => latest?.quotes.find((q) => q.quote_id === latest.recommended_quote_id), [latest]);
  const rejected = useMemo(() => new Map(latest?.rejected.map((r) => [r.business_id, r.reason]) ?? []), [latest]);

  if (view.status === "pending" && !latest) {
    return (
      <ThemeProvider>
        <div className={`hg ${theme === "dark" ? "hg-dark" : ""}`}><div className="hg-skeleton"><div /><div /><div /></div></div>
      </ThemeProvider>
    );
  }
  if (!latest) {
    return (
      <ThemeProvider>
        <div className={`hg ${theme === "dark" ? "hg-dark" : ""}`}>
          <div className="hg-empty"><strong>Couldn't load this deal.</strong><span>{view.status === "error" ? view.error.message : "No data yet."}</span></div>
        </div>
      </ThemeProvider>
    );
  }

  const d = latest;
  const compliant = d.quotes.filter((q) => !rejected.has(q.business_id) && q.meets_requirements && q.total_usd > 0);
  const others = d.quotes.filter((q) => !compliant.includes(q));
  const ranked = [...compliant, ...others];
  const payIdx = d.payment ? PAY_STEPS.indexOf(d.payment.status) : d.state === "awaiting_approval" ? 0 : -1;
  const req = d.request;

  return (
    <ThemeProvider>
      <div className={`hg ${theme === "dark" ? "hg-dark" : ""}`}>
        <ModelContext content={`Haggle deal board for ${d.job_id}: ${STATE_LABEL[d.state] ?? d.state}; ${d.quotes.length} quotes; recommended ${rec ? `${rec.business} ${usd(rec.total_usd)}` : "none yet"}; ${d.pending_questions.length} pending questions${d.mode === "mock" ? "; DEMO MODE (simulated data)" : ""}.`} />
        {d.mode === "mock" && <div className="hg-demo">DEMO MODE · simulated businesses, approval and payment · no real email or funds</div>}

        <header className="hg-head">
          <div>
            <div className="hg-eyebrow">Haggle · {d.job_id}</div>
            <h1>{req.what} · {req.quantity} {req.unit ?? "people"}</h1>
            <div className="hg-sub">{req.date} · {req.area}{d.budget_usd ? ` · budget ${usd(d.budget_usd)}` : ""}</div>
          </div>
          <div className="hg-head-right">
            <span className={`hg-state hg-state-${d.state}`}>{STATE_LABEL[d.state] ?? d.state}{d.ready && (d.state === "collecting" || d.state === "negotiating") ? " · final" : ""}</span>
            <span className="hg-inbox" title="Dedicated job inbox">{d.inbox}</span>
          </div>
        </header>

        <section className="hg-pipe" aria-label="Seller pipeline">
          {PIPE.map(([label, statuses]) => {
            const list = d.businesses.filter((b) => statuses.includes(b.status));
            return (
              <div key={label} className="hg-pipe-col">
                <div className="hg-pipe-head"><span>{label}</span><b>{list.length}</b></div>
                {list.map((b) => <div key={b.business_id} className={`hg-pipe-item ${rejected.has(b.business_id) ? "hg-strike" : ""}`}>{b.business}</div>)}
              </div>
            );
          })}
        </section>

        {rec && (
          <section className="hg-rec">
            <div>
              <div className="hg-eyebrow">Recommended</div>
              <div className="hg-rec-name">{rec.business}</div>
              <div className="hg-rec-why">
                Cheapest quote that meets every hard requirement{rec.negotiated_from ? `, negotiated down from ${usd(rec.negotiated_from)} in round ${rec.round}` : ""}. Source: {rec.source}.
              </div>
            </div>
            <div className="hg-rec-right">
              <div className="hg-rec-total">{usd(rec.total_usd)}</div>
              <div className="hg-rec-dep">deposit {usd(rec.deposit_usd)} now</div>
              {!d.approval && d.ready && (d.state === "collecting" || d.state === "negotiating") && (
                <button className="hg-btn hg-primary" onClick={() => void followUp({ prompt: `Please call approve for job ${d.job_id}, quote ${rec.quote_id} (${rec.business}, ${usd(rec.total_usd)}). I'll confirm in the approval form.` }).catch(() => {})}>Request approval</button>
              )}
            </div>
          </section>
        )}

        {d.pending_questions.length > 0 && (
          <section className="hg-questions">
            <div className="hg-section-title">Seller questions</div>
            {d.pending_questions.map((q) => (
              <div key={q.question_id} className="hg-q">
                <div><b>{d.business_names[q.business_id]}</b> asks: <span className="hg-quote-text">“{q.text}”</span></div>
                <div className="hg-q-row">
                  <input value={drafts[q.question_id] ?? ""} placeholder="Your answer (sent in their email thread)" onChange={(e) => setDrafts({ ...drafts, [q.question_id]: e.target.value })} />
                  <button className="hg-btn" disabled={!drafts[q.question_id]?.trim() || answer.isPending} onClick={() => void answer.callTool({ job_id: d.job_id, question_id: q.question_id, answer: drafts[q.question_id]! }).then(() => refresh.callTool({ job_id: d.job_id })).catch(() => {})}>
                    {answer.isPending ? "Sending…" : "Answer"}
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        <section className="hg-table" aria-label="Quote comparison">
          <div className="hg-section-title">Quotes <span className="hg-muted">one schema for every reply</span></div>
          {ranked.length === 0 && <div className="hg-empty-row">Waiting for the first replies…</div>}
          {ranked.length > 0 && (
            <table>
              <thead><tr><th>#</th><th>Business</th><th className="r">Total</th><th className="r">Deposit</th><th>Fits</th><th>Round</th><th className="r">Conf.</th><th>Flags</th></tr></thead>
              <tbody>
                {ranked.map((q, i) => {
                  const out = rejected.has(q.business_id) || !q.meets_requirements;
                  const isRec = q.quote_id === d.recommended_quote_id;
                  return [
                    <tr key={q.quote_id} className={`${isRec ? "hg-row-rec" : ""} ${out ? "hg-row-out" : ""}`} onClick={() => setOpen(open === q.quote_id ? null : q.quote_id)}>
                      <td className="hg-rank">{out ? "×" : i + 1}</td>
                      <td><div className="hg-biz">{q.business}</div>{q.price_check && <span className={`hg-pc hg-pc-${q.price_check}`}>{q.price_check}</span>}</td>
                      <td className="r hg-num">{usd(q.total_usd)}{q.negotiated_from ? <div className="hg-was">was {usd(q.negotiated_from)}</div> : null}</td>
                      <td className="r hg-num">{usd(q.deposit_usd)}</td>
                      <td>{q.meets_requirements ? <span className="hg-ok">✓</span> : <span className="hg-no">✗</span>}</td>
                      <td>{q.round}</td>
                      <td className="r">{Math.round(q.confidence * 100)}%</td>
                      <td className="hg-flags">{[...new Set([...(rejected.has(q.business_id) ? [rejected.get(q.business_id)!] : []), ...q.flags])].slice(0, 4).map((f) => <Chip key={f} flag={f} />)}</td>
                    </tr>,
                    open === q.quote_id ? (
                      <tr key={`${q.quote_id}-ev`} className="hg-ev"><td colSpan={8}>
                        <div className="hg-ev-grid">
                          <div><div className="hg-eyebrow">Evidence</div>{Object.entries(q.evidence).map(([k, e]) => <div key={k}><b>{k.replace(/_usd$/, "")}</b> · {e.source}{e.excerpt ? <span className="hg-muted"> “{e.excerpt}”</span> : null}</div>)}{Object.keys(q.evidence).length === 0 && <span className="hg-muted">No sourced figures.</span>}</div>
                          <div><div className="hg-eyebrow">Requirements</div>{q.requirement_results.map((r) => <div key={r.requirement_id}>{r.met === true ? "✓" : r.met === false ? "✗" : "?"} {req.requirements.find((x) => x.id === r.requirement_id)?.text ?? r.requirement_id}</div>)}</div>
                          <div><div className="hg-eyebrow">Missing</div>{q.missing.length ? q.missing.join(", ") : <span className="hg-muted">nothing</span>}{q.items.length > 0 && <><div className="hg-eyebrow hg-mt">Items</div>{q.items.join(" · ")}</>}</div>
                        </div>
                      </td></tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          )}
        </section>

        {(d.approval || d.payment || d.state === "awaiting_approval") && (
          <section className="hg-pay">
            <div className="hg-section-title">Approval &amp; payment <span className="hg-muted">x402 in the email thread · base-sepolia test USDC</span></div>
            <ol className="hg-steps">
              {PAY_STEPS.map((s, i) => <li key={s} className={i < payIdx || d.payment?.status === "settled" ? "done" : i === payIdx ? "now" : ""}><span />{PAY_LABEL[s]}</li>)}
            </ol>
            <div className="hg-pay-row">
              {d.approval && <div>Approved {usd(d.approval.quote_total_usd)} · deposit {usd(d.approval.payment_usd)} by <b>{d.approval.approver}</b> via {d.approval.channel}</div>}
              {d.payment?.status === "settled" && (
                <div className="hg-receipt">
                  Receipt {d.payment.simulated ? <span className="hg-chip hg-warn">DEMO receipt · not on-chain</span> : null}
                  <code>{d.payment.settle_tx}</code>
                  {d.payment.explorer_url && <button className="hg-btn" onClick={() => openExternal({ url: d.payment!.explorer_url! })}>View on Basescan</button>}
                </div>
              )}
              {d.payment && ["failed", "rejected", "expired"].includes(d.payment.status) && <div className="hg-no">Payment {d.payment.status}{d.payment.reason ? `: ${d.payment.reason}` : ""}</div>}
              {d.state === "paying" && d.payment?.status === "awaiting_invoice" && d.approval && (
                <button className="hg-btn hg-primary" onClick={() => void followUp({ prompt: `Please call pay for job ${d.job_id}, quote ${d.approval!.quote_id}.` }).catch(() => {})}>Pay deposit</button>
              )}
            </div>
          </section>
        )}

        <footer className="hg-foot"><span>Next: {d.next}</span>{refresh.isPending ? <span className="hg-muted">refreshing…</span> : null}</footer>
      </div>
    </ThemeProvider>
  );
}
