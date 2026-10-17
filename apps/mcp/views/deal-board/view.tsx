/**
 * Deal board (get_quotes, open_haggle): who Haggle contacted on which channel, live status,
 * and the quotes as a ranked ladder against the budget. Renders only DealBoard fields.
 */
import { ModelContext, useCallTool, useDisplayMode, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useEffect, useRef, useState } from "react";
import type { DealBoard, DealBoardBusiness, OpenQuestion, Quote } from "@haggle/core";
import { ChannelBadge, ErrorNote, FlagChip, Meter, Shell, Skeleton, VerdictChip, isRiskFlag, relativeTime, usd } from "../_shared/ui.tsx";
import "./view.css";

const TERMINAL = new Set(["paid", "cancelled", "failed"]);
const POLL_MS = 4000;

const STATE_LABEL: Record<string, string> = {
  created: "Starting",
  contacting: "Contacting businesses",
  collecting: "Collecting quotes",
  negotiating: "Negotiating",
  awaiting_approval: "Waiting for approval",
  paying: "Paying",
  paid: "Paid",
  cancelled: "Cancelled",
  failed: "Failed",
};

const STATUS_LABEL: Record<string, string> = {
  contacted: "Contacted",
  ringing: "Ringing",
  on_call: "On call",
  quoted: "Quoted",
  negotiating: "Negotiating",
  won: "Won",
  declined: "Out",
  no_reply: "No reply",
};

export default function DealBoardView() {
  const ctx = useToolContext<"get_quotes">();
  const refresh = useCallTool("get_quotes");
  const wait = useCallTool("wait_for_update");
  const [live, setLive] = useState<DealBoard | null>(null);

  const initial = ctx.status === "ready" ? (ctx.toolOutput as DealBoard) : null;
  const board = live ?? initial;
  const jobId = board?.job.id;
  const active = board ? !TERMINAL.has(board.job.state) : false;

  // Live updates: wait for a change, then re-read the board. Stops when the job ends.
  useEffect(() => {
    if (!jobId || !active) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const res = await wait.callTool({ job_id: jobId, timeout_s: 20 });
        const changed = (res.structuredContent as { changed?: boolean } | undefined)?.changed;
        if (changed && !stopped) {
          const next = await refresh.callTool({ job_id: jobId });
          if (!stopped) setLive(next.structuredContent as DealBoard);
        }
      } catch {
        // Host refused or the server hiccupped; try again on the next tick.
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [jobId, active]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!board) {
    return (
      <Shell>
        {ctx.status === "error" ? (
          <ErrorNote title="Couldn't load this deal." detail={ctx.error.message} />
        ) : (
          <Skeleton rows={5} />
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <Board board={board} />
    </Shell>
  );
}

function Board({ board }: { board: DealBoard }) {
  const { displayMode, availableDisplayModes, requestDisplayMode } = useDisplayMode();
  const followUp = useSendFollowUp();
  const fullscreen = displayMode === "fullscreen";
  const canFullscreen = availableDisplayModes.includes("fullscreen");
  const best = board.quotes.find((q) => q.quote_id === board.recommended_quote_id);

  return (
    <div className={`db${fullscreen ? " db-full" : ""}`}>
      <ModelContext
        content={`Haggle deal board for ${board.job.id}: ${STATE_LABEL[board.job.state] ?? board.job.state}; ${board.quotes.length} quotes; ${
          best ? `recommended ${best.business} ${usd(best.total_usd)}` : "no recommendation yet"
        }; ${board.open_questions.length} open question(s).`}
      />
      <header className="db-head">
        <div className="db-title">
          <h1>{board.job.request}</h1>
          <p className="hg-muted">
            {board.job.budget_usd !== undefined && <>Budget {usd(board.job.budget_usd)}. </>}
            {board.job.requirements.join(", ")}
          </p>
        </div>
        <div className="db-head-side">
          <span className={`db-state db-state-${board.job.state}`}>{STATE_LABEL[board.job.state] ?? board.job.state}</span>
          {canFullscreen && (
            <button
              className="hg-btn hg-btn-quiet"
              onClick={() => void requestDisplayMode({ mode: fullscreen ? "inline" : "fullscreen" }).catch(() => {})}
              aria-label={fullscreen ? "Exit full screen" : "Open full screen"}
            >
              {fullscreen ? "Exit full screen" : "Full screen"}
            </button>
          )}
        </div>
      </header>

      <div className="db-body">
        <section className="db-ladder" aria-label="Quotes, best first">
          <Ladder board={board} />
        </section>
        <section className="db-side">
          {board.open_questions.map((q) => (
            <Question key={q.question_id} jobId={board.job.id} question={q} />
          ))}
          <Businesses businesses={board.businesses} compact={!fullscreen} />
        </section>
      </div>

      <footer className="db-foot">
        <button
          className="hg-btn"
          onClick={() =>
            void followUp({
              prompt: `Compare the quotes on Haggle job ${board.job.id} and tell me which one to approve and why.`,
            }).catch(() => {})
          }
        >
          Ask the agent to compare
        </button>
      </footer>
    </div>
  );
}

function Ladder({ board }: { board: DealBoard }) {
  if (board.quotes.length === 0) {
    return <p className="db-empty">No quotes yet. Businesses usually answer A2A in seconds, calls in a few minutes, email within the hour.</p>;
  }
  const scale = Math.max(board.job.budget_usd ?? 0, ...board.quotes.map((q) => q.total_usd)) * 1.05;
  return (
    <ol className="db-quotes">
      {board.quotes.map((q, i) => (
        <QuoteRow key={q.quote_id} quote={q} rank={i + 1} scale={scale} board={board} />
      ))}
    </ol>
  );
}

function QuoteRow({ quote: q, rank, scale, board }: { quote: Quote; rank: number; scale: number; board: DealBoard }) {
  const recommended = q.quote_id === board.recommended_quote_id;
  const out = !q.meets_requirements || q.flags.some(isRiskFlag);
  const overBudget = board.job.budget_usd !== undefined && q.total_usd > board.job.budget_usd;
  const flash = useFlashOnChange(q.total_usd);
  const approve = useCallTool("approve");
  const approval = approve.data?.structuredContent as { status?: string; next?: string } | undefined;
  const transcript = board.businesses.find((b) => b.id === q.business_id)?.transcript_snippet;

  return (
    <li className={`db-quote${recommended ? " is-best" : ""}${out ? " is-out" : ""}${flash ? " is-flash" : ""}`}>
      <span className="db-rank" aria-label={`Rank ${rank}`}>
        {rank}
      </span>
      <div className="db-quote-main">
        <div className="db-quote-line">
          <span className="db-biz">{q.business}</span>
          <ChannelBadge channel={q.channel} />
          {recommended && <span className="db-best-label">Recommended</span>}
          <span className="db-total">
            {q.negotiated_from !== undefined && <s className="db-was">{usd(q.negotiated_from)}</s>}
            {usd(q.total_usd)}
          </span>
        </div>
        <Meter
          value={q.total_usd}
          max={scale}
          marker={board.job.budget_usd}
          tone={recommended ? "win" : out ? "risk" : undefined}
          label={`${usd(q.total_usd)}${board.job.budget_usd !== undefined ? ` against a ${usd(board.job.budget_usd)} budget` : ""}`}
        />
        <div className="db-quote-meta">
          {q.per_unit_usd !== undefined && <span>{usd(q.per_unit_usd)} per person</span>}
          {q.deposit_usd !== undefined && <span>{usd(q.deposit_usd)} deposit</span>}
          <VerdictChip verdict={q.price_check} />
          {overBudget && <FlagChip flag="over_budget" />}
          {q.flags.map((f) => (
            <FlagChip key={f} flag={f} />
          ))}
        </div>
        {recommended && q.items.length > 0 && <p className="db-items">{q.items.join(", ")}</p>}
        {transcript && !out && <p className="db-transcript">{transcript}</p>}
        {recommended && (
          <div className="db-approve">
            {approval?.status ? (
              <p className="db-approve-status">
                {approval.status === "pending_human" ? "Approval requested. Waiting for the approver." : `Approval ${approval.status.replace("_", " ")}.`}
              </p>
            ) : (
              <button
                className="hg-btn hg-btn-primary"
                disabled={approve.isPending}
                onClick={() => void approve.callTool({ job_id: board.job.id, quote_id: q.quote_id, via: "view" }).catch(() => {})}
              >
                {approve.isPending ? "Approving…" : `Approve ${usd(q.total_usd)}`}
              </button>
            )}
            {approve.error && <span className="db-err">{approve.error.message}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

function Question({ jobId, question }: { jobId: string; question: OpenQuestion }) {
  const answer = useCallTool("answer_business");
  const [draft, setDraft] = useState("");
  const sent = answer.data !== undefined;
  return (
    <div className="db-question">
      <p className="db-q-who">{question.business} asked</p>
      <p className="db-q-text">“{question.text}”</p>
      {sent ? (
        <p className="db-q-sent">Answer sent: “{draft}”</p>
      ) : (
        <form
          className="db-q-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void answer.callTool({ job_id: jobId, question_id: question.question_id, answer: draft.trim() }).catch(() => {});
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Your answer"
            aria-label={`Answer ${question.business}`}
          />
          <button className="hg-btn" type="submit" disabled={answer.isPending || !draft.trim()}>
            {answer.isPending ? "Sending…" : "Send answer"}
          </button>
        </form>
      )}
      {answer.error && <span className="db-err">{answer.error.message}</span>}
    </div>
  );
}

function Businesses({ businesses, compact }: { businesses: DealBoardBusiness[]; compact: boolean }) {
  if (compact) {
    return (
      <ul className="db-chips" aria-label="Businesses contacted">
        {businesses.map((b) => (
          <li key={b.id} className={`db-chip db-st-${b.status}`} title={b.last_event}>
            <span className="db-dot" aria-hidden="true" />
            {b.name}
            <ChannelBadge channel={b.channel} />
            <span className="db-chip-status">{STATUS_LABEL[b.status] ?? b.status}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="db-biz-list" aria-label="Businesses contacted">
      <h2>Businesses</h2>
      <ul>
        {businesses.map((b) => (
          <li key={b.id} className={`db-bizrow db-st-${b.status}`}>
            <div className="db-bizrow-line">
              <span className="db-dot" aria-hidden="true" />
              <span className="db-bizrow-name">{b.name}</span>
              <ChannelBadge channel={b.channel} />
              <span className="db-bizrow-status">{STATUS_LABEL[b.status] ?? b.status}</span>
            </div>
            <p className="db-bizrow-event">
              {b.last_event}
              {b.last_event_at && <span className="hg-muted"> · {relativeTime(b.last_event_at)}</span>}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** True for ~1.2 s after `value` changes (not on first render), so a revised price flashes once. */
function useFlashOnChange(value: unknown): boolean {
  const prev = useRef(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1200);
    return () => window.clearTimeout(t);
  }, [value]);
  return flash;
}
