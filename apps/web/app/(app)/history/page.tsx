// /history: every deal's events on one timeline (DESIGN.md "History"). Filters are in the URL.
import Link from "next/link";
import { AutoRefresh } from "@/components/admin/AutoRefresh";
import { HistoryLog } from "@/components/admin/HistoryLog";
import { LedgerError, TruncatedNote } from "@/components/admin/LedgerError";
import { Badge } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/Sheet";
import { HISTORY_CHOICES, HISTORY_DEFAULTS, historyRows, isOpen, readQuery } from "@/lib/dashboard/ledger";
import { loadLedger } from "@/lib/dashboard/ledgerData";
import "@/components/dashboard/board.css";
import "@/components/admin/admin.css";

export const dynamic = "force-dynamic";

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ ledger, error }, params] = await Promise.all([loadLedger(), searchParams]);
  const deals = ledger?.deals ?? [];
  const rows = historyRows(deals);
  return (
    <main className="adm" aria-labelledby="history-h">
      <header className="adm-head">
        <div className="page-title">
          <h1 id="history-h">History</h1>
          {ledger?.mode === "mock" ? <Badge /> : null}
        </div>
        <div className="adm-head-actions">
          <AutoRefresh active={deals.some(isOpen)} />
        </div>
      </header>
      {error ? (
        <LedgerError error={error} />
      ) : rows.length ? (
        <>
          {ledger?.truncated ? <TruncatedNote shown={deals.length} /> : null}
          <HistoryLog rows={rows} initial={readQuery(params, HISTORY_DEFAULTS, HISTORY_CHOICES)} now={new Date().toISOString()} />
        </>
      ) : (
        <EmptyState
          title="Nothing has happened yet"
          action={
            <Link className={buttonClass("primary")} href="/chat">
              <Icon name="plus" />
              New request
            </Link>
          }
        >
          Every message, quote, approval and payment is recorded here.
        </EmptyState>
      )}
    </main>
  );
}
