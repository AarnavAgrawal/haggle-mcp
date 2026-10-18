/**
 * Deal board (get_quotes, open_haggle): who Haggle contacted on which channel, live status,
 * and the quotes as a ranked ladder against the budget. Renders only DealBoard fields.
 */
import { ModelContext, useCallTool, useDisplayMode, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useEffect, useRef, useState } from "react";
import type { DealBoard, DealBoardBusiness, OpenQuestion, Quote } from "@haggle/core";
import { ChannelBadge, DemoTag, ErrorNote, FlagChip, Meter, Shell, Skeleton, VerdictChip, isRiskFlag, relativeTime, usd, viewTicket } from "../_shared/ui.tsx";
import { formatField, toolErrorText } from "../_shared/format.ts";
import "./view.css";

const TERMINAL = new Set(["paid", "confirmed", "cancelled", "failed"]);
const POLL_MS = 4000;

const STATE_LABEL: Record<string, string> = {
  created: "Starting",
  contacting: "Contacting businesses",
  collecting: "Collecting quotes",
  negotiating: "Negotiating",
  awaiting_approval: "Waiting for approval",
  paying: "Paying",
  paid: "Paid",
  confirmed: "Confirmed",
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
  unavailable: "Unavailable",
};

/** False when the business stated no total (total_usd is then 0 and means "unknown"): never show $0. */
const knownTotal = (q: Quote) => q.total_known !== false;
const totalText = (q: Quote) => (knownTotal(q) ? usd(q.total_usd) : "total not stated");

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
    let cursor = "0";
    const tick = async () => {
      try {
        const res = await wait.callTool({ job_id: jobId, cursor, timeout_s: 20 });
        const w = res.structuredContent as { cursor: string; updates: unknown[]; timed_out: boolean };
        const changed = !w.timed_out && w.updates.length > 0;
        cursor = w.cursor;
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
  const rankBy = board.job.compare_by && board.job.ask?.find((f) => f.key === board.job.compare_by!.field);

  return (
    <div className={`db${fullscreen ? " db-full" : ""}`}>
      <ModelContext
        content={`Haggle deal board for ${board.job.id}: ${STATE_LABEL[board.job.state] ?? board.job.state}; ${board.quotes.length} quotes; ${
          best ? `recommended ${best.business} ${totalText(best)}` : "no recommendation yet"
        }; ${board.open_questions.length} open question(s).`}
      />
      <header className="db-head">
        <div className="db-title">
          <h1>{board.job.request}</h1>
          <p className="hg-muted">
            {board.job.budget_usd !== undefined && <>Budget {usd(board.job.budget_usd)}. </>}
            {board.job.requirements.join(", ")}
            {rankBy && (
              <>
                {board.job.requirements.length > 0 ? ". " : ""}Ranked by {rankBy.label.toLowerCase()}, {board.job.compare_by!.direction === "min" ? "lowest" : "highest"} first.
              </>
            )}
          </p>
        </div>
        <div className="db-head-side">
          <DemoTag mode={board.mode} />
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
          <Businesses businesses={board.businesses} compact={!fullscreen} jobId={board.job.id} />
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
  const scale = Math.max(board.job.budget_usd ?? 0, ...board.quotes.filter(knownTotal).map((q) => q.total_usd)) * 1.05;
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
  const known = knownTotal(q);
  const overBudget = known && board.job.budget_usd !== undefined && q.total_usd > board.job.budget_usd;
  const followUp = useSendFollowUp();
  const flash = useFlashOnChange(q.total_usd);
  const approve = useCallTool("approve");
  const approveInView = useCallTool("approve_in_view");
  const [approval, setApproval] = useState<{ status?: string; next?: string } | undefined>(undefined);
  // The human's tap: request approval, then confirm with the one-time code sent only to this view.
  const onApprove = async () => {
    try {
      const res = await approve.callTool({ job_id: board.job.id, quote_id: q.quote_id });
      const a = res.structuredContent as { status?: string; next?: string };
      const ticket = viewTicket((res as { _meta?: Record<string, unknown> })._meta);
      if (a.status === "pending_human" && ticket) {
        const r = (await approveInView.callTool(ticket)).structuredContent as { status: string; next: string };
        setApproval({ status: r.status, next: r.next });
      } else setApproval(a);
    } catch {
      // approve.error / approveInView.error render below
    }
  };
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
          {known ? (
            <span className="db-total">
              {q.negotiated_from !== undefined && <s className="db-was">{usd(q.negotiated_from)}</s>}
              {usd(q.total_usd)}
            </span>
          ) : (
            <span className="db-total db-total-unknown">total not stated</span>
          )}
        </div>
        {known && (
          <Meter
            value={q.total_usd}
            max={scale}
            marker={board.job.budget_usd}
            tone={recommended ? "win" : out ? "risk" : undefined}
            label={`${usd(q.total_usd)}${board.job.budget_usd !== undefined ? ` against a ${usd(board.job.budget_usd)} budget` : ""}`}
          />
        )}
        {board.job.ask && board.job.ask.length > 0 && <AskFields quote={q} board={board} />}
        <div className="db-quote-meta">
          {q.per_unit_usd !== undefined && <span>{usd(q.per_unit_usd)} per person</span>}
          {q.deposit_usd !== undefined && <span>{usd(q.deposit_usd)} deposit</span>}
          <VerdictChip verdict={q.price_check} />
          {overBudget && <FlagChip flag="over_budget" />}
          {q.flags.map((f) => (
            <FlagChip key={f} flag={f} />
          ))}
          {q.missing_fields && q.missing_fields.length > 0 && <span className="hg-flag hg-tone-warn">Still owes: {q.missing_fields.join(", ")}</span>}
          <button className="db-link" onClick={() => void followUp({ prompt: conversationPrompt(q.business, board.job.id, q.business_id) }).catch(() => {})}>
            Conversation
          </button>
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
                onClick={() => void onApprove()}
              >
                {approve.isPending ? "Approving…" : known ? `Approve ${usd(q.total_usd)}` : "Approve"}
              </button>
            )}
            {(approve.error ?? approveInView.error) && <span className="db-err">{toolErrorText(approve.error ?? approveInView.error)}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

/** Custom asks: each answer under its ask label; the ranking answer (compare_by) is highlighted. */
function AskFields({ quote: q, board }: { quote: Quote; board: DealBoard }) {
  const rankKey = board.job.compare_by?.field;
  return (
    <dl className="db-fields">
      {board.job.ask!.map((f) => {
        const value = q.fields?.[f.key];
        const cls = [f.key === rankKey && "is-rank", f.required && (value === null || value === undefined) && "is-missing"].filter(Boolean).join(" ");
        return (
          <div key={f.key} className={cls || undefined}>
            <dt>{f.label}</dt>
            <dd>{formatField(value, f.type)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** The board can't open another view itself: ask the assistant to show get_conversation. */
const conversationPrompt = (business: string, jobId: string, businessId: string) =>
  `Show me the Haggle conversation with ${business} on job ${jobId} (get_conversation with job_id ${jobId}, business_id ${businessId}).`;

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
      {answer.error && <span className="db-err">{toolErrorText(answer.error)}</span>}
    </div>
  );
}

function Businesses({ businesses, compact, jobId }: { businesses: DealBoardBusiness[]; compact: boolean; jobId: string }) {
  const followUp = useSendFollowUp();
  if (compact) {
    return (
      <ul className="db-chips" aria-label="Businesses contacted">
        {businesses.map((b) => (
          <li key={b.id} className={`db-chip db-st-${b.status}`} title={b.unavailable_reason ?? b.last_event}>
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
              <span className="db-bizrow-status" title={b.unavailable_reason}>
                {STATUS_LABEL[b.status] ?? b.status}
              </span>
            </div>
            <p className="db-bizrow-event">
              {b.last_event}
              {b.last_event_at && <span className="hg-muted"> · {relativeTime(b.last_event_at)}</span>}
              <button className="db-link" onClick={() => void followUp({ prompt: conversationPrompt(b.name, jobId, b.id) }).catch(() => {})}>
                Conversation
              </button>
            </p>
            {b.status === "unavailable" && b.unavailable_reason && <p className="db-bizrow-reason">{b.unavailable_reason}</p>}
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
