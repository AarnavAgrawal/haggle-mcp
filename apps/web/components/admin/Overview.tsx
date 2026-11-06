// The overview's sections (DESIGN.md "Overview"): the totals line, what needs the human, the open deals,
// the pipeline, the workspace's controls, and the latest quotes and activity. Server components, all
// reading one ledger. Business text is untrusted data: plain text, marked as the business's own words.
import Link from "next/link";
import type { ReactNode } from "react";
import { AnswerForm } from "@/components/dashboard/DealActions";
import { Untrusted, When } from "@/components/dashboard/DealSections";
import { dealHref } from "@/components/shell/deals";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Highlighted } from "@/components/ui/PenMarks";
import { Price } from "@/components/ui/Price";
import { Status } from "@/components/ui/Status";
import { money, sentence } from "@/lib/dashboard/format";
import { attention, historyRows, isOpen, leadQuote, ledgerStatus, pipeline, quoteRows, standingWords, totals, type Attention, type LedgerDeal } from "@/lib/dashboard/ledger";
import type { WorkspaceSettings } from "@/lib/settings/types";
import { QuoteSpread } from "./QuoteSpread";

function Figure({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <Link href={href} className="adm-figure">
      <span className="adm-figure-label">{label}</span>
      <span className="adm-figure-value">{children}</span>
    </Link>
  );
}

export function TotalsLine({ deals }: { deals: LedgerDeal[] }) {
  const t = totals(deals);
  return (
    <nav className="adm-totals" aria-label="Workspace totals">
      <Figure href="/deals?view=needs_you" label="Needs you">
        <span data-hold={t.needsYou > 0 || undefined}>{t.needsYou}</span>
      </Figure>
      <Figure href="/deals?view=in_progress" label="In progress">
        {t.inProgress}
      </Figure>
      <Figure href="/quotes" label="Quotes in play">
        {t.quotes}
      </Figure>
      <Figure href="/quotes?view=picks" label="Approved">
        <Price amount={t.approvedUsd} size="xl" />
      </Figure>
      <Figure href="/quotes?view=picks" label="Saved by negotiating">
        {t.savedUsd > 0 ? (
          <Highlighted>
            <Price amount={t.savedUsd} size="xl" />
          </Highlighted>
        ) : (
          <Price amount={0} size="xl" />
        )}
      </Figure>
    </nav>
  );
}

function AttentionRow({ item }: { item: Attention }) {
  const what = sentence(item.deal.what);
  const href = dealHref(item.deal.job_id);
  if (item.kind === "question") {
    return (
      <li className="adm-task">
        <div className="adm-task-head">
          <Status tone="hold">{item.question.business} asked a question</Status>
          <Link className="adm-quiet-link" href={href}>
            {what}
          </Link>
          <When at={item.question.asked_at} />
        </div>
        <Untrusted text={item.question.text} from={item.question.business} kind="asked" />
        <AnswerForm jobId={item.deal.job_id} questionId={item.question.question_id} business={item.question.business} />
      </li>
    );
  }
  if (item.kind === "approve") {
    const q = item.quote;
    return (
      <li className="adm-task adm-task-line">
        <div>
          <Status tone="hold">Ready for your approval</Status>
          <p className="adm-task-what">
            <Link className="adm-quiet-link" href={href}>
              {what}
            </Link>
            {q ? (
              <span className="hint">
                {" "}
                {q.business} at {money(q.total_usd)}
                {q.deposit_usd ? `, ${money(q.deposit_usd)} deposit` : ""}
              </span>
            ) : null}
          </p>
        </div>
        <Link className={buttonClass("primary", { size: "s" })} href={href}>
          Review quotes
        </Link>
      </li>
    );
  }
  const approved = leadQuote(item.deal);
  const due = item.deal.approval?.amount_usd;
  return (
    <li className="adm-task adm-task-line">
      <div>
        <Status tone="hold">{ledgerStatus(item.deal).words}</Status>
        <p className="adm-task-what">
          <Link className="adm-quiet-link" href={href}>
            {what}
          </Link>
          {approved ? (
            <span className="hint">
              {" "}
              {approved.business}
              {due ? `, ${money(due)} due now` : ""}
            </span>
          ) : null}
        </p>
      </div>
      <Link className={buttonClass("primary", { size: "s" })} href={href}>
        Open deal
      </Link>
    </li>
  );
}

export function NeedsYou({ deals }: { deals: LedgerDeal[] }) {
  const items = attention(deals);
  return (
    <section className="adm-section" aria-labelledby="needs-you-h">
      <h2 id="needs-you-h" className="adm-h">
        Needs you
        {items.length ? <span className="adm-tab-count">{items.length}</span> : null}
      </h2>
      {items.length ? (
        <ul className="ui-sheet ui-sheet-pad-none adm-tasks">
          {items.map((item) => (
            <AttentionRow key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <p className="ui-sheet adm-clear">
          <Icon name="check" />
          Nothing needs you right now. Haggle keeps working on your open deals.
        </p>
      )}
    </section>
  );
}

export function OpenDeals({ deals }: { deals: LedgerDeal[] }) {
  const open = deals.filter(isOpen).slice(0, 6);
  if (!open.length) return null;
  return (
    <section className="adm-section" aria-labelledby="open-deals-h">
      <div className="adm-section-head">
        <h2 id="open-deals-h" className="adm-h">
          Open deals
        </h2>
        <Link className="adm-all" href="/deals">
          All deals
        </Link>
      </div>
      <ul className="ui-sheet ui-sheet-pad-none adm-mini">
        {open.map((d) => {
          const s = ledgerStatus(d);
          const lead = leadQuote(d);
          return (
            <li key={d.job_id}>
              <Link className="adm-mini-row" href={dealHref(d.job_id)}>
                <span className="adm-mini-what">
                  <strong>{sentence(d.what)}</strong>
                  <Status tone={s.tone}>{s.words}</Status>
                </span>
                <QuoteSpread deal={d} />
                <span className="adm-mini-price">
                  {lead ? (
                    <>
                      <Price amount={lead.total_usd} size="m" />
                      <span className="adm-under">{lead.business}</span>
                    </>
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Pipeline({ deals }: { deals: LedgerDeal[] }) {
  const stages = pipeline(deals);
  const most = Math.max(1, ...stages.map((s) => s.count));
  return (
    <section className="adm-section" aria-labelledby="pipeline-h">
      <h2 id="pipeline-h" className="adm-h">
        Where your deals are
      </h2>
      <ol className="ui-sheet adm-pipe">
        {stages.map((s) => {
          const row = (
            <>
              <span className="adm-pipe-label">{s.label}</span>
              <span className="adm-pipe-track" aria-hidden="true">
                {s.count ? <span className="adm-pipe-bar" data-stage={s.key} style={{ width: `${(s.count / most) * 100}%` }} /> : null}
              </span>
              <span className="adm-pipe-count num">{s.count}</span>
            </>
          );
          return <li key={s.key}>{s.count ? <Link href={`/deals?stage=${s.key}`}>{row}</Link> : <span className="adm-pipe-empty">{row}</span>}</li>;
        })}
      </ol>
    </section>
  );
}

export function Controls({ settings }: { settings: WorkspaceSettings | null }) {
  return (
    <section className="adm-section" aria-labelledby="controls-h">
      <div className="adm-section-head">
        <h2 id="controls-h" className="adm-h">
          Your controls
        </h2>
        <Link className="adm-all" href="/settings">
          Change
        </Link>
      </div>
      {settings ? (
        <dl className="ui-sheet adm-controls">
          <div>
            <dt>Limit per deal</dt>
            <dd className="num">{money(settings.default_deal_limit_usd)}</dd>
          </div>
          <div>
            <dt>Most Haggle can pay</dt>
            <dd className="num">{money(settings.ceiling_usd)}</dd>
          </div>
          <div>
            <dt>Approvals go to</dt>
            <dd>{settings.approver.phone ?? settings.approver.email ?? "Nobody yet"}</dd>
          </div>
          <div>
            <dt>Your area</dt>
            <dd>{settings.default_area ?? "Not set"}</dd>
          </div>
        </dl>
      ) : (
        <p className="ui-sheet hint">Your limits couldn&rsquo;t be read just now. They still apply; see Settings.</p>
      )}
    </section>
  );
}

export function LatestQuotes({ deals }: { deals: LedgerDeal[] }) {
  const rows = quoteRows(deals).filter((r) => r.standing !== "replaced" && r.total_usd !== null).slice(0, 5);
  if (!rows.length) return null;
  return (
    <section className="adm-section" aria-labelledby="latest-quotes-h">
      <div className="adm-section-head">
        <h2 id="latest-quotes-h" className="adm-h">
          Latest quotes
        </h2>
        <Link className="adm-all" href="/quotes">
          All quotes
        </Link>
      </div>
      <ul className="ui-sheet ui-sheet-pad-none adm-feed">
        {rows.map((r) => (
          <li key={r.quote_id}>
            <Link href={dealHref(r.job_id)}>
              <span className="adm-feed-main">
                <strong>{r.business}</strong>
                <span className="hint">
                  {sentence(r.deal)}
                  {r.standing !== "open" ? `, ${standingWords(r.standing).toLowerCase()}` : ""}
                </span>
              </span>
              <Price amount={r.total_usd} size="m" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RecentActivity({ deals }: { deals: LedgerDeal[] }) {
  const rows = historyRows(deals).slice(0, 6);
  if (!rows.length) return null;
  return (
    <section className="adm-section" aria-labelledby="activity-h">
      <div className="adm-section-head">
        <h2 id="activity-h" className="adm-h">
          Recent activity
        </h2>
        <Link className="adm-all" href="/history">
          Full history
        </Link>
      </div>
      <ul className="ui-sheet ui-sheet-pad-none adm-feed">
        {rows.map((e) => (
          <li key={e.key}>
            <Link href={dealHref(e.job_id)}>
              <span className="adm-feed-main">
                <span>{e.text}</span>
                <span className="hint">{sentence(e.deal)}</span>
              </span>
              <When at={e.at} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
