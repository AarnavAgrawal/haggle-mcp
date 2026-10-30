// /deals/<jobId>: one deal, live. The board comes from get_quotes (DealBoardPlus); LiveRefresh re-renders
// it whenever wait_for_update reports a change.
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { AnswerForm, CancelDealButton, NegotiateButton } from "@/components/dashboard/DealActions";
import { BusinessTable, Callbacks, NegotiationHistory, PurchaseStatus, QuoteList, SetupNotes, Timeline, Untrusted } from "@/components/dashboard/DealSections";
import { LiveRefresh } from "@/components/dashboard/LiveRefresh";
import { humanNext, isTerminal, money, stamp, stateTone, stateWords } from "@/lib/dashboard/format";
import type { DealBoardView } from "@/lib/dashboard/types";
import { HaggleError } from "@/lib/haggle";
import { requireHaggle } from "@/lib/workspace";
import "@/components/dashboard/dashboard.css";

export const dynamic = "force-dynamic";

export default async function DealPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const { user, haggle } = await requireHaggle();
  let board: DealBoardView | null = null;
  let error: { message: string; fix: string } | null = null;
  try {
    board = (await haggle.callTool<DealBoardView>("get_quotes", { job_id: jobId })).data;
  } catch (err) {
    error = err instanceof HaggleError ? { message: err.message, fix: err.fix } : { message: "The Haggle server couldn't be reached.", fix: "Reload the page in a moment." };
  }

  if (!board || !board.job) {
    return (
      <>
        <TopBar email={user.email} active="deals" />
        <main className="shell">
          <Link className="dash-back" href="/deals">
            All deals
          </Link>
          <p className="note note-risk" role="alert">
            {error ? (
              <>
                {error.message} <span className="fix">{error.fix}</span>
              </>
            ) : (
              "This deal has no data yet."
            )}
          </p>
        </main>
      </>
    );
  }

  const job = board.job;
  const state = job.state;
  const mode = board.mode ?? "live";
  const live = !isTerminal(state);
  const d = board.request_details;
  const budget = d?.budget_usd ?? job.budget_usd;
  // The counteroffer round: at most once (round 2), before anything is approved or paid. The server
  // still decides (no_rounds_left etc. come back as an error with its fix).
  const counterRan = (board.negotiation ?? []).length > 0;
  const approved = !!board.approval && ["approved", "used"].includes(board.approval.status);
  const priced = board.quotes.filter((q) => q.total_usd !== null && (!q.status || q.status === "current")).length;
  const canNegotiate = live && state !== "paying" && !approved && !counterRan && priced >= 2;

  return (
    <>
      <TopBar email={user.email} active="deals" />
      <main className="shell">
        <Link className="dash-back" href="/deals">
          All deals
        </Link>

        <header className="page-head deal-head">
          <div className="page-title">
            <h1 id="deal-h" className="deal-title">
              {d?.what ?? job.request}
            </h1>
            <span className={`chip chip-${stateTone(state)}`}>{stateWords(state)}</span>
            {mode === "mock" ? <span className="chip demo">DEMO data</span> : null}
          </div>
          {live ? <LiveRefresh jobId={jobId} /> : null}
        </header>

        <div className="deal-grid">
          <div className="deal-main">
            <p className="note dash-next" role="status">
              {humanNext(board)}
            </p>

            <SetupNotes board={board} />

            {board.open_questions.length ? (
              <section className="deal-section stack" aria-labelledby="q-h">
                <h2 id="q-h" className="dash-h2">
                  Questions from businesses
                </h2>
                {board.open_questions.map((q) => (
                  <div key={q.question_id} className="card stack">
                    <div>
                      <strong>{q.business}</strong>
                      {q.asked_at ? <span className="hint"> asked {stamp(q.asked_at)}</span> : null}
                    </div>
                    <Untrusted text={q.text} />
                    {live ? <AnswerForm jobId={jobId} questionId={q.question_id} business={q.business} /> : null}
                  </div>
                ))}
              </section>
            ) : null}

            <section className="deal-section" aria-labelledby="quotes-h">
              <div className="dash-head">
                <h2 id="quotes-h" className="dash-h2">
                  Quotes
                </h2>
                {board.ready ? <span className="chip chip-win">Final</span> : null}
              </div>
              {board.recommendation_note && !board.recommended_quote_id ? <p className="hint">{board.recommendation_note}</p> : null}
              <QuoteList board={board} jobId={jobId} mode={mode} live={state !== "cancelled" && state !== "failed"} />
              {canNegotiate ? (
                <div className="quote-approve">
                  <NegotiateButton jobId={jobId} />
                </div>
              ) : null}
            </section>

            <PurchaseStatus board={board} />
            <Callbacks board={board} jobId={jobId} />
            <NegotiationHistory board={board} />

            <section className="deal-section" aria-labelledby="biz-h">
              <h2 id="biz-h" className="dash-h2">
                Businesses
              </h2>
              <BusinessTable board={board} jobId={jobId} />
            </section>

            {live ? (
              <section className="deal-cancel" aria-label="Stop this deal">
                <CancelDealButton jobId={jobId} />
              </section>
            ) : null}
          </div>

          <aside className="deal-aside" aria-label="The request">
            <div>
              <h2>Request</h2>
              <dl className="dash-meta">
                {d?.headcount !== undefined ? (
                  <div>
                    <dt>For</dt>
                    <dd>{d.headcount}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Budget</dt>
                  <dd>
                    {budget !== undefined && budget !== null ? money(budget) : "none set"}
                    {d?.budget_source === "settings_default" ? <span className="hint"> (default)</span> : null}
                  </dd>
                </div>
                <div className="meta-wide">
                  <dt>When</dt>
                  <dd>{d?.when ?? "not set"}</dd>
                </div>
                <div className="meta-wide">
                  <dt>Where</dt>
                  <dd>{d?.place ?? "not set"}</dd>
                </div>
                {board.payment_ceiling_usd !== undefined ? (
                  <div>
                    <dt>Payment cap</dt>
                    <dd>{money(board.payment_ceiling_usd)}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
            {job.requirements.length ? (
              <div>
                <h2>Must have</h2>
                <div className="chips" aria-label="Requirements">
                  {job.requirements.map((r) => (
                    <span key={r} className="chip chip-plain">
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            <div>
              <h2>Progress</h2>
              <Timeline state={state} />
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
