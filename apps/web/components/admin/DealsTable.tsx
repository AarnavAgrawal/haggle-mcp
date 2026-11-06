"use client";
// The /deals table (DESIGN.md "Deals"): views, search, stage filter, sortable columns, CSV export, and
// selecting open deals to cancel several at once. Rows arrive from the server; filtering is instant
// here. Cancelling goes through the same /api/deals/<id>/actions route as a deal's own menu, always after
// an inline "are you sure", and reports what really happened to each deal.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { DealMenu } from "@/components/dashboard/DealActions";
import { dealHref } from "@/components/shell/deals";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Price } from "@/components/ui/Price";
import { Status } from "@/components/ui/Status";
import { ago, dayWords, money, sentence, stamp } from "@/lib/dashboard/format";
import {
  DEAL_CHOICES, DEAL_DEFAULTS, STAGES, dealViews, filterDeals, isOpen, leadQuote, ledgerStatus, pricedQuotes, sortDeals, toCsv, type DealSortKey, type DealView, type LedgerDeal, type SortDir,
} from "@/lib/dashboard/ledger";
import { QuoteSpread } from "./QuoteSpread";
import { ExportButton, NoMatches, SearchBox, SelectFilter, SortSelect, SortTh, ViewTabs } from "./TableKit";
import { useTableQuery } from "./tableState";

type Outcome = { job_id: string; what: string; done: boolean; note: string };

/** Cancels one deal; the server may refuse, or need the approver first, and says so. */
async function cancelOne(d: LedgerDeal): Promise<Outcome> {
  const base = { job_id: d.job_id, what: sentence(d.what) };
  try {
    const res = await fetch(`/api/deals/${encodeURIComponent(d.job_id)}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel_deal", confirm: true }) });
    const out = (await res.json().catch(() => null)) as { ok: true; data: { note?: string; needs_approver?: boolean; flagged?: boolean } } | { ok: false; error: { message: string; fix: string } } | null;
    if (!out) return { ...base, done: false, note: `The app answered ${res.status}.` };
    if (!out.ok) return { ...base, done: false, note: `${out.error.message} ${out.error.fix}`.trim() };
    if (out.data.needs_approver || out.data.flagged) return { ...base, done: false, note: out.data.note ?? "Not cancelled yet." };
    return { ...base, done: true, note: "Cancelled." };
  } catch {
    return { ...base, done: false, note: "Couldn't reach the app." };
  }
}

function BulkBar({ selected, working, setWorking, onClear }: { selected: LedgerDeal[]; working: boolean; setWorking: (w: boolean) => void; onClear: () => void }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  const n = selected.length;
  const label = `${n} ${n === 1 ? "deal" : "deals"}`;

  // The button that started this is gone: focus moves to what replaced it, not to the top of the page.
  useEffect(() => {
    if (outcomes) dismiss.current?.focus();
  }, [outcomes]);

  async function run() {
    setWorking(true);
    const results: Outcome[] = [];
    // One at a time: each cancel tells businesses and may withdraw an approval.
    for (const d of selected) results.push(await cancelOne(d));
    setWorking(false);
    setConfirming(false);
    setOutcomes(results);
    onClear();
    startTransition(() => router.refresh());
  }

  return (
    <>
      {/* Always mounted: a screen reader announces a live region's changes, not its arrival. */}
      <div role="status">
        {outcomes ? (
          <div className="adm-bulk">
            <ul className="adm-outcomes">
              {outcomes.map((o) => (
                <li key={o.job_id}>
                  <Status tone={o.done ? "idle" : "risk"}>{o.what}</Status>
                  <span className="hint">{o.note}</span>
                </li>
              ))}
            </ul>
            <Button ref={dismiss} size="s" variant="quiet" onClick={() => setOutcomes(null)}>
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>
      {n && !outcomes ? (
        <div className="adm-bulk">
          {confirming ? (
            <>
              <p>
                <strong>Cancel {label}?</strong> Businesses that replied are told; any approval is withdrawn.
              </p>
              <Button variant="danger" size="s" pending={working} onClick={run}>
                Yes, cancel {label}
              </Button>
              <Button variant="quiet" size="s" disabled={working} onClick={() => setConfirming(false)}>
                Keep them
              </Button>
            </>
          ) : (
            <>
              <p>
                <strong>{label}</strong> selected
              </p>
              <Button variant="danger" size="s" onClick={() => setConfirming(true)}>
                Cancel {label}
              </Button>
              <Button variant="quiet" size="s" onClick={onClear}>
                Clear selection
              </Button>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

const SORTS: { sort: DealSortKey; dir: SortDir; label: string }[] = [
  { sort: "updated", dir: "desc", label: "Recently updated" },
  { sort: "started", dir: "desc", label: "Newest first" },
  { sort: "best", dir: "asc", label: "Lowest quote" },
  { sort: "quotes", dir: "desc", label: "Most quotes" },
  { sort: "what", dir: "asc", label: "Name" },
];

function subLine(d: LedgerDeal): string[] {
  return [d.quantity !== undefined ? `${d.quantity} ${d.unit ?? "people"}` : null, d.date ? dayWords(d.date) : null, d.area].filter((x): x is string => !!x);
}

export function DealsTable({ deals, initial, now }: { deals: LedgerDeal[]; initial: typeof DEAL_DEFAULTS; now: string }) {
  const [query, set] = useTableQuery(initial, DEAL_DEFAULTS, DEAL_CHOICES);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const sort = query.sort as DealSortKey;
  const dir = query.dir as SortDir;

  const views = useMemo(() => dealViews(deals), [deals]);
  const rows = useMemo(() => sortDeals(filterDeals(deals, { view: query.view as DealView, stage: query.stage, q: query.q }), sort, dir), [deals, query.view, query.stage, query.q, sort, dir]);
  const openRows = rows.filter(isOpen);
  // Only deals on screen can be cancelled: one ticked and then filtered away, or finished since, isn't
  // in the count and isn't touched.
  const selected = openRows.filter((d) => picked.has(d.job_id));
  const allPicked = openRows.length > 0 && openRows.every((d) => picked.has(d.job_id));
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const filtered = query.view !== "all" || !!query.stage || !!query.q;

  return (
    <section aria-label="Deals">
      <div className="adm-toolbar">
        <ViewTabs views={views} value={query.view as DealView} onChange={(view) => set({ view })} label="Show deals" />
        <div className="adm-filters">
          <SearchBox label="Search deals" placeholder="Search deals or businesses" value={query.q} onChange={(q) => set({ q })} />
          <SelectFilter label="Filter by stage" all="Any stage" value={query.stage} onChange={(stage) => set({ stage })} options={STAGES.map((s) => ({ value: s.key, label: s.label }))} />
          <SortSelect sort={sort} dir={dir} options={SORTS} onSort={(s, d) => set({ sort: s, dir: d })} />
          <ExportButton
            filename="haggle-deals.csv"
            disabled={!rows.length}
            build={() =>
              toCsv(rows, [
                { label: "Deal", value: (d) => sentence(d.what) },
                { label: "Status", value: (d) => ledgerStatus(d).words },
                { label: "Businesses", value: (d) => d.businesses.length },
                { label: "Quotes", value: (d) => pricedQuotes(d).length },
                { label: "Lead quote USD", value: (d) => leadQuote(d)?.total_usd },
                { label: "Lead business", value: (d) => leadQuote(d)?.business },
                { label: "Budget USD", value: (d) => d.budget_usd },
                { label: "Started", value: (d) => d.created_at },
                { label: "Updated", value: (d) => d.updated_at },
              ])
            }
          />
        </div>
      </div>
      <BulkBar selected={selected} working={working} setWorking={setWorking} onClear={() => setPicked(new Set())} />
      {rows.length ? (
        <div className="ui-sheet ui-sheet-pad-none adm-sheet">
          <table className="adm-table adm-deals">
            <thead>
              <tr>
                <th scope="col" className="adm-pick">
                  <input
                    type="checkbox"
                    aria-label="Select all open deals shown"
                    checked={allPicked}
                    disabled={!openRows.length || working}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(openRows.map((d) => d.job_id)))}
                  />
                </th>
                <SortTh label="Deal" column="what" sort={sort} dir={dir} onSort={(s, d) => set({ sort: s, dir: d })} />
                <th scope="col">Status</th>
                <SortTh label="Quotes" column="quotes" sort={sort} dir={dir} first="desc" onSort={(s, d) => set({ sort: s, dir: d })} />
                <SortTh label="Lead quote" column="best" sort={sort} dir={dir} onSort={(s, d) => set({ sort: s, dir: d })} className="adm-right" />
                <th scope="col" className="adm-right">
                  Budget
                </th>
                <SortTh label="Updated" column="updated" sort={sort} dir={dir} first="desc" onSort={(s, d) => set({ sort: s, dir: d })} className="adm-right" />
                <th scope="col" className="adm-menu">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const s = ledgerStatus(d);
                const lead = leadQuote(d);
                const sub = subLine(d);
                const open = isOpen(d);
                return (
                  <tr key={d.job_id} data-picked={picked.has(d.job_id) || undefined}>
                    <td className="adm-pick">
                      {open ? <input type="checkbox" aria-label={`Select ${d.what}`} checked={picked.has(d.job_id)} disabled={working} onChange={() => toggle(d.job_id)} /> : null}
                    </td>
                    <td className="adm-deal">
                      <Link href={dealHref(d.job_id)}>{sentence(d.what)}</Link>
                      {sub.length ? (
                        <span className="adm-sub">
                          {sub.map((x) => (
                            <span key={x}>{x}</span>
                          ))}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Status">
                      <Status tone={s.tone}>{s.words}</Status>
                    </td>
                    <td data-label="Quotes" className="adm-spread">
                      <QuoteSpread deal={d} />
                    </td>
                    <td data-label="Lead quote" className="adm-right">
                      {lead ? (
                        <>
                          <Price amount={lead.total_usd} size="m" />
                          <span className="adm-under">{lead.business}</span>
                        </>
                      ) : (
                        <span className="hint">None</span>
                      )}
                    </td>
                    <td data-label="Budget" className="adm-right">
                      {d.budget_usd !== null ? <span className="num">{money(d.budget_usd)}</span> : <span className="hint">None set</span>}
                    </td>
                    <td data-label="Updated" className="adm-right">
                      <time className="hint" dateTime={d.updated_at} title={stamp(d.updated_at)}>
                        {ago(d.updated_at, new Date(now))}
                      </time>
                    </td>
                    <td className="adm-menu">
                      <DealMenu jobId={d.job_id} canCancel={open} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : filtered ? (
        <NoMatches onClear={() => set({ view: "all", stage: "", q: "" })}>No deals match these filters.</NoMatches>
      ) : null}
      <p className="adm-foot">
        <Icon name="check" />
        Nothing is ordered until you approve a quote on its deal.
      </p>
    </section>
  );
}
