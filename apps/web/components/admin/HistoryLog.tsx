"use client";
// /history (DESIGN.md "History"): the audit trail. Every deal's events on one timeline under day
// headings, with filters and CSV export. Times are UTC, like every stamp in the app.
import Link from "next/link";
import { useMemo, useState } from "react";
import { dealHref } from "@/components/shell/deals";
import { Button } from "@/components/ui/Button";
import { StatusDot, type StatusTone } from "@/components/ui/Status";
import { sentence, stamp } from "@/lib/dashboard/format";
import { HISTORY_CHOICES, HISTORY_DEFAULTS, HISTORY_GROUPS, byDay, filterHistory, toCsv, type EventGroup, type HistoryItem } from "@/lib/dashboard/ledger";
import { ExportButton, NoMatches, SearchBox, SelectFilter } from "./TableKit";
import { useTableQuery } from "./tableState";

const PAGE = 100;
const TONE: Record<EventGroup, StatusTone> = { status: "idle", contact: "idle", quote: "live", negotiation: "live", approval: "hold", payment: "ok", problem: "risk" };

export function HistoryLog({ rows, initial, now }: { rows: HistoryItem[]; initial: typeof HISTORY_DEFAULTS; now: string }) {
  const [query, setQuery] = useTableQuery(initial, HISTORY_DEFAULTS, HISTORY_CHOICES);
  const [limit, setLimit] = useState(PAGE);
  // A new filter starts from the top again.
  const set = (patch: Partial<typeof HISTORY_DEFAULTS>) => {
    setLimit(PAGE);
    setQuery(patch);
  };
  const deals = useMemo(() => [...new Map(rows.map((r) => [r.job_id, r.deal])).entries()].map(([value, what]) => ({ value, label: sentence(what) })), [rows]);
  const shown = useMemo(() => filterHistory(rows, query), [rows, query]);
  // `now` comes from the server, so "Today" reads the same in both renders.
  const days = useMemo(() => byDay(shown.slice(0, limit), new Date(now)), [shown, limit, now]);

  return (
    <section aria-label="History">
      <div className="adm-toolbar">
        <p className="hint adm-tz">Times are UTC.</p>
        <div className="adm-filters">
          <SearchBox label="Search history" placeholder="Search history" value={query.q} onChange={(q) => set({ q })} />
          <SelectFilter label="Filter by kind" all="Everything" value={query.group} onChange={(group) => set({ group })} options={HISTORY_GROUPS.map((g) => ({ value: g.key, label: g.label }))} />
          <SelectFilter label="Filter by deal" all="Every deal" value={query.deal} onChange={(deal) => set({ deal })} options={deals} />
          <ExportButton
            filename="haggle-history.csv"
            disabled={!shown.length}
            build={() =>
              toCsv(shown, [
                { label: "When (UTC)", value: (r) => r.at },
                { label: "Deal", value: (r) => sentence(r.deal) },
                { label: "Business", value: (r) => r.business },
                { label: "Kind", value: (r) => HISTORY_GROUPS.find((g) => g.key === r.group)?.label },
                { label: "What happened", value: (r) => r.text },
              ])
            }
          />
        </div>
      </div>
      {days.length ? (
        <div className="adm-log">
          {days.map((d) => (
            <section key={d.day} aria-label={d.label} className="ui-sheet ui-sheet-pad-none adm-day">
              <h2 className="adm-day-h">{d.label}</h2>
              <ol className="adm-events">
                {d.items.map((e) => (
                  <li key={e.key}>
                    <time className="adm-event-time" dateTime={e.at} title={stamp(e.at)}>
                      {e.at.slice(11, 16)}
                    </time>
                    <StatusDot tone={TONE[e.group]} />
                    <span className="adm-event-text">{e.text}</span>
                    <Link className="adm-quiet-link adm-event-deal" href={dealHref(e.job_id)}>
                      {sentence(e.deal)}
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          ))}
          {shown.length > limit ? (
            <Button className="adm-more" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, shown.length - limit)} more
            </Button>
          ) : null}
        </div>
      ) : (
        <NoMatches onClear={() => set({ group: "", deal: "", q: "" })}>Nothing in the history matches these filters.</NoMatches>
      )}
    </section>
  );
}
