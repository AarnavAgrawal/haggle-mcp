// /deals/<jobId>: one deal, live (DESIGN.md "Deal board"). The board comes from get_quotes
// (DealBoardPlus); LiveRefresh re-renders it whenever wait_for_update reports a change. loading.tsx
// paints the board's shape instantly while the first read is in flight.
import Link from "next/link";
import { Activity, BoardHeader, Callbacks, NeedsAnswer, PurchaseStatus, QuoteSheet, RequestAside, SetupNotes } from "@/components/dashboard/DealSections";
import { RetryButton } from "@/components/shell/RetryButton";
import { isTerminal } from "@/lib/dashboard/format";
import type { DealBoardView } from "@/lib/dashboard/types";
import { HaggleError } from "@/lib/haggle";
import { requireHaggle } from "@/lib/workspace";
import "@/components/dashboard/board.css";

export const dynamic = "force-dynamic";

export default async function DealPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const { haggle } = await requireHaggle();
  let board: DealBoardView | null = null;
  let error: { message: string; fix: string } | null = null;
  try {
    board = (await haggle.callTool<DealBoardView>("get_quotes", { job_id: jobId })).data;
  } catch (err) {
    error = err instanceof HaggleError ? { message: err.message, fix: err.fix } : { message: "The Haggle server couldn't be reached.", fix: "Reload the page in a moment." };
  }

  if (!board || !board.job) {
    return (
      <main className="shell board">
        <Link className="board-back" href="/deals">
          All deals
        </Link>
        <div className="board-error" role="alert">
          <p>{error ? error.message : "This deal has no data yet."}</p>
          {error ? <p className="fix">{error.fix}</p> : null}
          <RetryButton />
        </div>
      </main>
    );
  }

  const state = board.job.state;
  const mode = board.mode ?? "live";
  const live = !isTerminal(state);
  // The counteroffer round: at most once (round 2), before anything is approved or paid. The server
  // still decides (no_rounds_left etc. come back as an error with its fix).
  const counterRan = (board.negotiation ?? []).length > 0;
  const approved = !!board.approval && ["approved", "used"].includes(board.approval.status);
  const priced = board.quotes.filter((q) => q.total_usd !== null && (!q.status || q.status === "current")).length;
  // While quotes are still coming in Haggle negotiates by itself (the server refuses a manual round), so
  // the button appears once the quotes are in.
  const canNegotiate = live && state !== "paying" && !approved && !counterRan && priced >= 2 && (board.ready === true || state === "awaiting_approval");
  // The approval bar already shows the purchase for the approved quote; the board's own purchase
  // section is for when it can't (a stopped deal, or an approval on a quote no longer on the sheet).
  const barShowsPurchase =
    state !== "cancelled" && state !== "failed" && !!board.approval && board.quotes.some((q) => q.quote_id === board!.approval!.quote_id && q.total_usd !== null && (!q.status || q.status === "current"));

  return (
    <main className="shell board" aria-labelledby="deal-h">
      <BoardHeader board={board} jobId={jobId} canNegotiate={canNegotiate} />
      <div className="board-grid">
        <div className="board-main">
          <SetupNotes board={board} />
          <NeedsAnswer board={board} jobId={jobId} />
          <QuoteSheet board={board} jobId={jobId} mode={mode}>
            {barShowsPurchase ? null : <PurchaseStatus board={board} />}
            <Callbacks board={board} jobId={jobId} />
            <Activity board={board} jobId={jobId} />
          </QuoteSheet>
        </div>
        <RequestAside board={board} />
      </div>
    </main>
  );
}
