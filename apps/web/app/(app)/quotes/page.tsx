// /quotes: every quote from every deal (DESIGN.md "Quotes"). The view, filters and sort are in the URL.
import Link from "next/link";
import { AutoRefresh } from "@/components/admin/AutoRefresh";
import { LedgerError, TruncatedNote } from "@/components/admin/LedgerError";
import { QuotesTable } from "@/components/admin/QuotesTable";
import { Badge } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/Sheet";
import { QUOTE_CHOICES, QUOTE_DEFAULTS, isOpen, quoteRows, readQuery } from "@/lib/dashboard/ledger";
import { loadLedger } from "@/lib/dashboard/ledgerData";
import "@/components/dashboard/board.css";
import "@/components/admin/admin.css";

export const dynamic = "force-dynamic";

export default async function QuotesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ ledger, error }, params] = await Promise.all([loadLedger(), searchParams]);
  const deals = ledger?.deals ?? [];
  const rows = quoteRows(deals);
  return (
    <main className="adm" aria-labelledby="quotes-h">
      <header className="adm-head">
        <div className="page-title">
          <h1 id="quotes-h">Quotes</h1>
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
          <QuotesTable rows={rows} initial={readQuery(params, QUOTE_DEFAULTS, QUOTE_CHOICES)} now={new Date().toISOString()} />
        </>
      ) : (
        <EmptyState
          title="No quotes yet"
          action={
            <Link className={buttonClass("primary")} href={deals.length ? "/deals" : "/chat"}>
              {deals.length ? null : <Icon name="plus" />}
              {deals.length ? "See your deals" : "New request"}
            </Link>
          }
        >
          Every quote from every deal shows up here as businesses reply.
        </EmptyState>
      )}
    </main>
  );
}
