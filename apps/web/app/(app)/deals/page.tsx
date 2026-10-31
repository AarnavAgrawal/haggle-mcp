// /deals: every deal in the workspace (list_deals, newest 20), grouped the way the shell rail groups
// them (Needs you, In progress, Done); each row links to its live board.
import Link from "next/link";
import { dealHref, dealStatus, groupDeals } from "@/components/shell/deals";
import { loadDeals } from "@/components/shell/data";
import { RetryButton } from "@/components/shell/RetryButton";
import { Badge } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Price } from "@/components/ui/Price";
import { EmptyState } from "@/components/ui/Sheet";
import { Status } from "@/components/ui/Status";
import { ago, dayWords, dealCounts, sentence, stamp } from "@/lib/dashboard/format";
import type { DealRow } from "@/lib/dashboard/types";
import "@/components/dashboard/board.css";

export const dynamic = "force-dynamic";

function DealLine({ d }: { d: DealRow }) {
  const s = dealStatus(d);
  const sub = [d.quantity !== undefined ? `${d.quantity} ${d.unit ?? "people"}` : null, d.date ? dayWords(d.date) : null, d.area].filter((x): x is string => !!x);
  const counts = dealCounts(d);
  return (
    <Link className="deal-row" href={dealHref(d.job_id)}>
      <span className="deal-what">
        <strong>{sentence(d.what)}</strong>
        {sub.length ? (
          <span className="deal-sub">
            {sub.map((x) => (
              <span key={x}>{x}</span>
            ))}
          </span>
        ) : null}
      </span>
      <span className="deal-state">
        <Status tone={s.tone}>{d.purchase && d.state === "paying" ? sentence(d.purchase.stage.replace(/_/g, " ")) : s.words}</Status>
        {counts ? <span className="deal-counts">{counts}</span> : null}
      </span>
      <span className="deal-best">
        {d.leading ? (
          <>
            <Price amount={d.leading.total_usd} size="m" />
            <span className="hint">{d.leading.business}</span>
          </>
        ) : (
          <span className="hint">No quote yet</span>
        )}
      </span>
      <span className="deal-time hint">
        {d.created_at ? (
          <time dateTime={d.created_at} title={`Started ${stamp(d.created_at)}`}>
            {ago(d.created_at)}
          </time>
        ) : null}
      </span>
    </Link>
  );
}

export default async function DealsPage() {
  // Shared with the shell rail's deals list: one list_deals call per request.
  const { deals = null, error = null } = await loadDeals();
  const groups = deals ? groupDeals(deals.deals) : [];

  return (
    <main className="shell deals-page">
      <header className="page-head">
        <div className="page-title">
          <h1>Deals</h1>
          {deals?.mode === "mock" ? <Badge /> : null}
        </div>
        <Link className={buttonClass("primary")} href="/chat">
          <Icon name="plus" />
          New request
        </Link>
      </header>
      {error ? (
        <div className="board-error" role="alert">
          <p>{error.message}</p>
          <p className="fix">{error.fix}</p>
          <RetryButton />
        </div>
      ) : groups.length ? (
        <div className="deals-groups">
          {groups.map((g) => (
            <section key={g.key} aria-labelledby={`dg-${g.key}`}>
              <h2 id={`dg-${g.key}`} className="deals-group-h">
                {g.label}
                <span className="hint">{g.deals.length}</span>
              </h2>
              <ul className="deals-list">
                {g.deals.map((d) => (
                  <li key={d.job_id}>
                    <DealLine d={d} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No deals yet"
          action={
            <Link className={buttonClass("primary")} href="/chat">
              <Icon name="plus" />
              New request
            </Link>
          }
        >
          Say what you need, like lunch for 40 next Thursday under $1,200. Haggle gets quotes from your vendors by email, phone and text, and nothing is ordered until you approve.
        </EmptyState>
      )}
    </main>
  );
}
