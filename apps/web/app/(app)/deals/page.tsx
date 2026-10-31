// /deals: every deal in the workspace (list_deals, newest 20), each linking to its live page.
import Link from "next/link";
import { ago, dealLine, money, stateTone, stateWords } from "@/lib/dashboard/format";
import { loadDeals } from "@/components/shell/data";
import "@/components/dashboard/dashboard.css";

export const dynamic = "force-dynamic";

export default async function DealsPage() {
  // Shared with the shell rail's deals list: one list_deals call per request.
  const { deals = null, error = null } = await loadDeals();

  return (
    <>
      <main className="shell">
        <header className="page-head">
          <div>
            <div className="page-title">
              <h1>Your deals</h1>
              {deals?.mode === "mock" && <span className="chip demo">DEMO data</span>}
            </div>
            <p>Every request Haggle is working on or has finished, newest first.</p>
          </div>
          <Link className="btn btn-primary" href="/chat">
            New request
          </Link>
        </header>
        {error ? (
          <p className="note note-risk" role="alert">
            {error.message} <span className="fix">{error.fix}</span>
          </p>
        ) : deals && deals.deals.length ? (
          <ul className="deals" aria-label="Deals">
            {deals.deals.map((d) => (
              <li key={d.job_id} className="deal">
                <Link className="deal-link" href={`/deals/${encodeURIComponent(d.job_id)}`}>
                  <div>
                    <strong className="deal-what">{d.what}</strong>
                    <div className="muted">{dealLine(d)}</div>
                    {d.purchase ? <div className="hint">{d.purchase.summary}</div> : null}
                  </div>
                  <div className="deal-side">
                    <span className={`chip chip-${stateTone(d.state)}`}>{stateWords(d.state)}</span>
                    {d.leading ? (
                      <span>
                        <span className="hint">{d.leading.business} </span>
                        <span className="price">{money(d.leading.total_usd)}</span>
                      </span>
                    ) : d.quotes !== undefined && d.businesses !== undefined ? (
                      <span className="muted num">
                        {d.quotes} of {d.businesses} quoted
                      </span>
                    ) : null}
                    {d.created_at ? <span className="hint">Started {ago(d.created_at)}</span> : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="deals-empty">
            <p>No deals yet. Tell Haggle what you need and it gets real quotes from your vendors by email, phone and text.</p>
            <Link className="btn btn-primary" href="/chat">
              New request
            </Link>
          </div>
        )}
      </main>
    </>
  );
}
