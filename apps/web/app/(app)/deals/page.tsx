// /deals: every deal in the workspace as a table (DESIGN.md "Deals"): views, search, stage filter, sort
// and export, with the view kept in the URL; each row links to its live board.
import Link from "next/link";
import { AutoRefresh } from "@/components/admin/AutoRefresh";
import { DealsTable } from "@/components/admin/DealsTable";
import { LedgerError, TruncatedNote } from "@/components/admin/LedgerError";
import { Badge } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/Sheet";
import { DEAL_CHOICES, DEAL_DEFAULTS, isOpen, readQuery } from "@/lib/dashboard/ledger";
import { loadLedger } from "@/lib/dashboard/ledgerData";
import "@/components/dashboard/board.css";
import "@/components/admin/admin.css";

export const dynamic = "force-dynamic";

export default async function DealsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ ledger, error }, params] = await Promise.all([loadLedger(), searchParams]);
  const deals = ledger?.deals ?? [];

  return (
    <main className="adm" aria-labelledby="deals-h">
      <header className="adm-head">
        <div className="page-title">
          <h1 id="deals-h">Deals</h1>
          {ledger?.mode === "mock" ? <Badge /> : null}
        </div>
        <div className="adm-head-actions">
          <AutoRefresh active={deals.some(isOpen)} />
          <Link className={buttonClass("primary")} href="/chat">
            <Icon name="plus" />
            New request
          </Link>
        </div>
      </header>
      {error ? (
        <LedgerError error={error} />
      ) : deals.length ? (
        <>
          {ledger?.truncated ? <TruncatedNote shown={deals.length} /> : null}
          <DealsTable deals={deals.map((d) => ({ ...d, events: [] }))} initial={readQuery(params, DEAL_DEFAULTS, DEAL_CHOICES)} now={new Date().toISOString()} />
        </>
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
