// /dashboard: the overview, where signing in lands (DESIGN.md "Overview"). One ledger read feeds every
// section; the workspace's limits come from the owner's settings.
import Link from "next/link";
import { AutoRefresh } from "@/components/admin/AutoRefresh";
import { LedgerError, TruncatedNote } from "@/components/admin/LedgerError";
import { Controls, LatestQuotes, NeedsYou, OpenDeals, Pipeline, RecentActivity, TotalsLine } from "@/components/admin/Overview";
import { Badge } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/Sheet";
import { isOpen } from "@/lib/dashboard/ledger";
import { loadLedger, loadSettings } from "@/lib/dashboard/ledgerData";
import "@/components/dashboard/board.css";
import "@/components/admin/admin.css";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [{ ledger, error }, settings] = await Promise.all([loadLedger(), loadSettings()]);
  const deals = ledger?.deals ?? [];
  return (
    <main className="adm" aria-labelledby="overview-h">
      <header className="adm-head">
        <div className="page-title">
          <h1 id="overview-h">Overview</h1>
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
          <TotalsLine deals={deals} />
          {ledger?.truncated ? <TruncatedNote shown={deals.length} /> : null}
          <div className="adm-grid">
            <div className="adm-col">
              <NeedsYou deals={deals} />
              <OpenDeals deals={deals} />
              <LatestQuotes deals={deals} />
            </div>
            <div className="adm-col">
              <Pipeline deals={deals} />
              <Controls settings={settings} />
              <RecentActivity deals={deals} />
            </div>
          </div>
        </>
      ) : (
        <EmptyState
          title="Start your first deal"
          action={
            <Link className={buttonClass("primary")} href="/chat">
              <Icon name="plus" />
              New request
            </Link>
          }
        >
          Say what you need, like lunch for 40 next Thursday under $1,200. Haggle gets the quotes, and this page shows where everything stands. Nothing is ordered until you approve.
        </EmptyState>
      )}
    </main>
  );
}
