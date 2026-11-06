"use client";
// /quotes (DESIGN.md "Quotes"): every quote from every deal in one table. Reading only: a quote is
// approved on its deal's board, where the confirm step and the money checks are. Business text (name,
// items) is untrusted data, shown as plain text.
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { dealHref } from "@/components/shell/deals";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { Circled, Struck } from "@/components/ui/PenMarks";
import { Price } from "@/components/ui/Price";
import { Status, type StatusTone } from "@/components/ui/Status";
import { ago, channelWords, flagTone, flagWords, money, priceCheckWords, sentence, stamp } from "@/lib/dashboard/format";
import { QUOTE_CHOICES, QUOTE_DEFAULTS, filterQuotes, quoteViews, quoteWarning, sortQuotes, standingWords, toCsv, type QuoteRowItem, type QuoteSortKey, type QuoteStanding, type QuoteView, type SortDir } from "@/lib/dashboard/ledger";
import { ExportButton, NoMatches, SearchBox, SelectFilter, SortSelect, SortTh, Via, ViewTabs } from "./TableKit";
import { useTableQuery } from "./tableState";

const STANDING_TONE: Record<QuoteStanding, StatusTone> = { approved: "ok", recommended: "ok", open: "live", closed: "idle", replaced: "idle" };

function Total({ r }: { r: QuoteRowItem }) {
  if (r.total_usd === null) return <span className="hint">Not stated</span>;
  const total = <Price amount={r.total_usd} size="m" />;
  const came = r.negotiated_from !== undefined && r.negotiated_from > r.total_usd;
  return (
    <span className="adm-total">
      {came ? (
        <Struck className="adm-was">
          <Price amount={r.negotiated_from} size="s" />
        </Struck>
      ) : null}
      {r.standing === "recommended" || r.standing === "approved" ? <Circled>{total}</Circled> : total}
    </span>
  );
}

function Details({ r }: { r: QuoteRowItem }) {
  const facts: [string, string][] = [];
  if (r.per_unit_usd !== undefined) facts.push(["Each", money(r.per_unit_usd)]);
  facts.push(["Deposit", r.deposit_usd !== undefined ? money(r.deposit_usd) : "None stated"]);
  if (r.valid_until) facts.push(["Valid until", stamp(r.valid_until)]);
  facts.push(["Read from", `${sentence(r.source)}, ${Math.round(r.confidence * 100)}% confidence`]);
  if (r.round > 1) facts.push(["Round", String(r.round)]);
  return (
    <div className="adm-detail">
      {r.items.length ? (
        <ul className="adm-items" aria-label="What's included">
          {r.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      ) : null}
      <dl className="adm-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {r.flags.length ? (
        <ul className="adm-flags">
          {r.flags.map((f) => (
            <li key={f} data-tone={flagTone(f)}>
              {sentence(flagWords(f))}
            </li>
          ))}
        </ul>
      ) : null}
      <Link className="qd-link" href={dealHref(r.job_id)}>
        Open {r.deal}
        <Icon name="chevron-right" />
      </Link>
    </div>
  );
}

const SORTS: { sort: QuoteSortKey; dir: SortDir; label: string }[] = [
  { sort: "received", dir: "desc", label: "Newest first" },
  { sort: "total", dir: "asc", label: "Lowest total" },
  { sort: "total", dir: "desc", label: "Highest total" },
  { sort: "business", dir: "asc", label: "Business" },
  { sort: "deal", dir: "asc", label: "Deal" },
];

export function QuotesTable({ rows, initial, now }: { rows: QuoteRowItem[]; initial: typeof QUOTE_DEFAULTS; now: string }) {
  const [query, set] = useTableQuery(initial, QUOTE_DEFAULTS, QUOTE_CHOICES);
  const [open, setOpen] = useState<string | null>(null);
  const sort = query.sort as QuoteSortKey;
  const dir = query.dir as SortDir;
  const views = useMemo(() => quoteViews(rows), [rows]);
  const channels = useMemo(() => [...new Set(rows.map((r) => r.channel))].map((c) => ({ value: c, label: channelWords(c) })), [rows]);
  const deals = useMemo(() => [...new Map(rows.map((r) => [r.job_id, r.deal])).entries()].map(([value, what]) => ({ value, label: sentence(what) })), [rows]);
  const shown = useMemo(
    () => sortQuotes(filterQuotes(rows, { view: query.view as QuoteView, channel: query.channel, deal: query.deal, q: query.q }), sort, dir),
    [rows, query.view, query.channel, query.deal, query.q, sort, dir],
  );
  const onSort = (s: QuoteSortKey, d: SortDir) => set({ sort: s, dir: d });

  return (
    <section aria-label="Quotes">
      <div className="adm-toolbar">
        <ViewTabs views={views} value={query.view as QuoteView} onChange={(view) => set({ view })} label="Show quotes" />
        <div className="adm-filters">
          <SearchBox label="Search quotes" placeholder="Search businesses or deals" value={query.q} onChange={(q) => set({ q })} />
          <SelectFilter label="Filter by deal" all="Every deal" value={query.deal} onChange={(deal) => set({ deal })} options={deals} />
          <SelectFilter label="Filter by channel" all="Any channel" value={query.channel} onChange={(channel) => set({ channel })} options={channels} />
          <SortSelect sort={sort} dir={dir} options={SORTS} onSort={onSort} />
          <ExportButton
            filename="haggle-quotes.csv"
            disabled={!shown.length}
            build={() =>
              toCsv(shown, [
                { label: "Business", value: (r) => r.business },
                { label: "Deal", value: (r) => sentence(r.deal) },
                { label: "Channel", value: (r) => channelWords(r.channel) },
                { label: "Total USD", value: (r) => r.total_usd },
                { label: "Came down from USD", value: (r) => r.negotiated_from },
                { label: "Each USD", value: (r) => r.per_unit_usd },
                { label: "Deposit USD", value: (r) => r.deposit_usd },
                { label: "Meets must-haves", value: (r) => (r.meets_requirements ? "Yes" : "No") },
                { label: "Price check", value: (r) => priceCheckWords(r.price_check) },
                { label: "Standing", value: (r) => standingWords(r.standing) },
                { label: "Received", value: (r) => r.received_at },
              ])
            }
          />
        </div>
      </div>
      {shown.length ? (
        <div className="ui-sheet ui-sheet-pad-none adm-sheet">
          <table className="adm-table adm-quotes">
            <thead>
              <tr>
                <SortTh label="Business" column="business" sort={sort} dir={dir} onSort={onSort} />
                <SortTh label="Deal" column="deal" sort={sort} dir={dir} onSort={onSort} />
                <th scope="col">Reached by</th>
                <th scope="col">Must-haves</th>
                <th scope="col">Standing</th>
                <SortTh label="Total" column="total" sort={sort} dir={dir} onSort={onSort} className="adm-right" />
                <SortTh label="Received" column="received" sort={sort} dir={dir} first="desc" onSort={onSort} className="adm-right" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const expanded = open === r.quote_id;
                const warning = quoteWarning(r);
                return (
                  <Fragment key={r.quote_id}>
                    <tr className={cx(r.standing === "replaced" && "adm-dim")} data-open={expanded || undefined}>
                      <td className="adm-deal">
                        <button type="button" className="adm-expand" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.quote_id)}>
                          <Icon name="chevron-right" size={16} />
                          {r.business}
                        </button>
                      </td>
                      <td data-label="Deal">
                        <Link className="adm-quiet-link" href={dealHref(r.job_id)}>
                          {sentence(r.deal)}
                        </Link>
                      </td>
                      <td data-label="Reached by">
                        <Via channel={r.channel} />
                      </td>
                      <td data-label="Must-haves">
                        <span className={cx("must", r.meets_requirements ? "must-ok" : "must-miss")}>
                          <Icon name={r.meets_requirements ? "check" : "x"} />
                          {r.meets_requirements ? "Meets them" : "Misses one"}
                        </span>
                        {r.price_check ? <span className="adm-under">{priceCheckWords(r.price_check)}</span> : null}
                      </td>
                      <td data-label="Standing">
                        <Status tone={STANDING_TONE[r.standing]}>{standingWords(r.standing)}</Status>
                        {warning ? (
                          <span className="adm-warn" data-tone={warning.tone}>
                            {warning.words}
                          </span>
                        ) : null}
                      </td>
                      <td data-label="Total" className="adm-right">
                        <Total r={r} />
                      </td>
                      <td data-label="Received" className="adm-right">
                        <time className="hint" dateTime={r.received_at} title={stamp(r.received_at)}>
                          {ago(r.received_at, new Date(now))}
                        </time>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="adm-detail-row">
                        <td colSpan={7}>
                          <Details r={r} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <NoMatches onClear={() => set({ view: "all", channel: "", deal: "", q: "" })}>No quotes match these filters.</NoMatches>
      )}
    </section>
  );
}
