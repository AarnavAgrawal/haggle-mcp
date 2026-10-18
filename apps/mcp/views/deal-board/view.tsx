/**
 * Deal board (rendered once by deal; open_haggle re-opens it): who Haggle contacted on which channel,
 * what each business said, the quotes as a ranked ladder against the budget, the recommendation and
 * why, and the human's choose → pay → receipt steps on any safe option. Renders only DealBoard fields;
 * every action is an MCP tool call made from the board (no messages are posted into the chat).
 *
 * One board per deal: it refreshes itself (wait_for_update long-poll, then get_quotes), so the model
 * never needs to re-render it. The model sees the board's state through ModelContext instead.
 */
import { ModelContext, useCallTool, useDisplayMode, useOpenExternal, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Conversation, ConversationEntry, DealBoard, DealBoardBusiness, DealBoardOrEmpty, OpenQuestion, Quote } from "@haggle/core";
import { ChannelBadge, ErrorNote, FlagChip, Meter, ModeBadge, Shell, Skeleton, VerdictChip, relativeTime, usd, viewTicket } from "../_shared/ui.tsx";
import { formatField, parseToolError, toolErrorText } from "../_shared/format.ts";
import { EntryList, Reply, mergeEntries } from "../conversation/thread.tsx";
import { boardContext, choiceFor, chosenApproval, isUnsafe, negotiationLine, negotiationWarning, replaceableApproval, type Choice } from "./options.ts";
import "./view.css";

const TERMINAL = new Set(["paid", "confirmed", "cancelled", "failed"]);
const POLL_MS = 4000;
const RETRY_MS = 10_000;

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
  unavailable: "Can't reach",
};

type Sync = { at: number | null; trouble: boolean };

/** False when the business stated no total (total_usd is then 0 and means "unknown"): never show $0. */
const knownTotal = (q: Quote) => q.total_known !== false;

export default function DealBoardView() {
  const ctx = useToolContext<"open_haggle">();
  const refresh = useCallTool("get_quotes");
  const wait = useCallTool("wait_for_update");
  const [live, setLive] = useState<DealBoard | null>(null);
  const [sync, setSync] = useState<Sync>({ at: null, trouble: false });
  const cursor = useRef("0");

  const initial = ctx.status === "ready" ? (ctx.toolOutput as DealBoardOrEmpty) : null;
  const board = live ?? (initial?.job ? (initial as DealBoard) : null);
  const jobId = board?.job.id;
  const active = board ? !TERMINAL.has(board.job.state) : false;

  const reload = useCallback(async (id: string) => {
    const next = await refresh.callTool({ job_id: id });
    setLive(next.structuredContent as DealBoard);
    setSync({ at: Date.now(), trouble: false });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A re-opened conversation or reconnect shows the stored tool output, which may be old: re-read once.
  useEffect(() => {
    if (jobId) void reload(jobId).catch(() => {}); // the poll below reports lasting trouble
  }, [jobId, reload]);

  // Live updates: wait for a change, then re-read the board. Runs in every non-terminal state
  // (awaiting approval included) and keeps retrying after host errors. Stops when the job ends.
  useEffect(() => {
    if (!jobId || !active) return;
    let stopped = false;
    let timer: number | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const res = await wait.callTool({ job_id: jobId, cursor: cursor.current, timeout_s: 20 });
        const w = res.structuredContent as { cursor: string; updates: unknown[]; timed_out: boolean };
        cursor.current = w.cursor;
        if (!stopped && !w.timed_out && w.updates.length > 0) await reload(jobId);
        else if (!stopped) setSync((s) => ({ at: s.at ?? Date.now(), trouble: false }));
        failures = 0;
      } catch {
        // Host refused or the server hiccupped: say so after two misses, back off, keep trying.
        failures++;
        if (!stopped && failures >= 2) setSync((s) => ({ ...s, trouble: true }));
      }
      if (!stopped) timer = window.setTimeout(tick, failures ? RETRY_MS : POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [jobId, active, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const changedHere = () => reload(board!.job.id).catch(() => setSync((s) => ({ ...s, trouble: true })));

  if (!board) {
    return (
      <Shell>
        {ctx.status === "error" ? (
          <ErrorNote title="Couldn't load this deal." detail={ctx.error.message} />
        ) : initial && !initial.job ? (
          <Welcome mode={initial.mode} />
        ) : (
          <Skeleton rows={5} />
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <Board
        board={board}
        sync={sync}
        refreshing={refresh.isPending}
        onRefresh={() => void reload(board.job.id).catch(() => setSync((s) => ({ ...s, trouble: true })))}
        onChanged={changedHere}
      />
    </Shell>
  );
}

/**
 * A button that sends a message to the assistant in the chat, on the human's click only. Always
 * labelled as such: the board never posts into the chat by itself.
 */
function ChatButton({ prompt, children, primary }: { prompt: string; children: ReactNode; primary?: boolean }) {
  const followUp = useSendFollowUp();
  const [failed, setFailed] = useState(false);
  return (
    <button
      className={`hg-btn${primary ? " hg-btn-primary" : ""}`}
      title={`Sends this message to your assistant: “${prompt}”`}
      onClick={() => void followUp({ prompt }).then(() => setFailed(false)).catch(() => setFailed(true))}
    >
      {children}
      {failed && <span className="db-err"> (couldn't send; type it in the chat)</span>}
    </button>
  );
}

/** open_haggle before any deal: what Haggle does and two ways to start. */
function Welcome({ mode }: { mode?: "mock" | "live" }) {
  return (
    <div className="db db-welcome">
      <header className="db-head">
        <div className="db-title">
          <h1>Haggle</h1>
          <p className="hg-muted">No deals yet. Tell your agent what to buy: Haggle contacts businesses by email, phone, iMessage or A2A, compares real quotes, and pays a deposit only after you approve.</p>
        </div>
        <ModeBadge mode={mode} />
      </header>
      <div className="db-welcome-actions">
        <span className="db-chat-hint hg-muted">Ask your assistant:</span>
        <ChatButton primary prompt="Use Haggle to get catering quotes for 40 people next week in San Francisco, at least 12 vegetarian, delivered, budget $1,200.">
          Example catering deal
        </ChatButton>
        <ChatButton prompt="Use Haggle's ask tool for an instant estimate: lunch catering for 40 in San Francisco.">Instant estimate</ChatButton>
      </div>
    </div>
  );
}

function Board({ board, sync, refreshing, onRefresh, onChanged }: { board: DealBoard; sync: Sync; refreshing: boolean; onRefresh: () => void; onChanged: () => Promise<void> }) {
  const { displayMode, availableDisplayModes, requestDisplayMode } = useDisplayMode();
  const fullscreen = displayMode === "fullscreen";
  const canFullscreen = availableDisplayModes.includes("fullscreen");
  // Haggle's texted suggestion isn't a choice yet: the recommendation stays highlighted, every option choosable.
  const held = chosenApproval(board);
  const chosenId = held?.quote_id ?? (board.payment?.status === "settled" ? board.approval?.quote_id : undefined);
  const chosen = board.quotes.find((q) => q.quote_id === chosenId);
  const rankBy = board.job.compare_by && board.job.ask?.find((f) => f.key === board.job.compare_by!.field);

  return (
    <div className={`db${fullscreen ? " db-full" : ""}`}>
      <ModelContext content={boardContext(board, board.recommended_quote_id)} />
      <header className="db-head">
        <div className="db-title">
          <h1>{capitalize(board.job.request)}</h1>
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
          <ModeBadge mode={board.mode} />
          <span className={`db-state db-state-${board.job.state}`}>{stateLabel(board)}</span>
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

      <Progress board={board} />
      <NegotiationNow board={board} />

      <div className="db-body">
        <section className="db-ladder" aria-label="Quotes, best first">
          <Ladder board={board} chosenId={chosen?.quote_id} onChanged={onChanged} />
        </section>
        <section className="db-side">
          {board.open_questions.map((q) => (
            <Question key={q.question_id} jobId={board.job.id} question={q} onChanged={onChanged} />
          ))}
          <Businesses businesses={board.businesses} quotes={board.quotes} compact={!fullscreen} jobId={board.job.id} />
        </section>
      </div>

      <footer className="db-foot">
        <p className="db-sync hg-muted" aria-live="polite">
          {sync.trouble ? "Reconnecting…" : TERMINAL.has(board.job.state) ? (sync.at ? `Updated ${relativeTime(new Date(sync.at).toISOString())}` : "") : "Live · updates by itself"}
          <button className="db-link" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </p>
        <div className="db-foot-actions">
          <span className="db-chat-hint hg-muted">Ask your assistant:</span>
          {chosen && board.payment?.status === "settled" && (
            <ChatButton prompt={`Show what Haggle learned about ${chosen.business} (business_profile).`}>What Haggle learned</ChatButton>
          )}
          <ChatButton prompt="Start another Haggle deal. Ask me what to buy, for how many, when and where.">New deal</ChatButton>
        </div>
      </footer>
    </div>
  );
}

/** One line: how many businesses on which channels, how many answered. */
function Progress({ board }: { board: DealBoard }) {
  const n = board.businesses.length;
  if (n === 0) return null;
  const answered = board.businesses.filter((b) => ["quoted", "negotiating", "won"].includes(b.status)).length;
  const channels = [...new Set(board.businesses.map((b) => b.channel))];
  const label: Record<string, string> = { email: "email", phone: "phone", a2a: "A2A", imessage: "iMessage" };
  return (
    <p className="db-progress">
      <strong>
        {answered} of {n}
      </strong>{" "}
      businesses quoted · contacted by {channels.map((c) => label[c] ?? c).join(", ")}
      {board.negotiation && board.negotiation.length > 0 && <> · {board.negotiation.length} counteroffer{board.negotiation.length > 1 ? "s" : ""}</>}
    </p>
  );
}

/** The live negotiation round: who will be called back when, who lowered, who matched. */
function NegotiationNow({ board }: { board: DealBoard }) {
  const line = negotiationLine(board, (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  if (!line) return null;
  return (
    <p className="db-neg-live" aria-live="polite">
      {line}
    </p>
  );
}

function Ladder({ board, chosenId, onChanged }: { board: DealBoard; chosenId?: string; onChanged: () => Promise<void> }) {
  if (board.quotes.length === 0) {
    return (
      <p className="db-empty">
        No quotes yet. A2A answers in seconds, texts and calls in minutes, email within the hour. This board updates by itself.
      </p>
    );
  }
  const scale = Math.max(board.job.budget_usd ?? 0, ...board.quotes.filter(knownTotal).map((q) => q.total_usd)) * 1.05;
  const options = board.quotes.filter((q) => !isUnsafe(board, q)).length;
  return (
    <>
      {options > 1 && !TERMINAL.has(board.job.state) && (
        <p className="db-ladder-note hg-muted">{options} safe options. Haggle recommends one; you can choose any of them.</p>
      )}
      <ol className="db-quotes">
        {board.quotes.map((q, i) => (
          <QuoteRow key={q.quote_id} quote={q} rank={i + 1} scale={scale} board={board} chosen={q.quote_id === chosenId} onChanged={onChanged} />
        ))}
      </ol>
    </>
  );
}

function QuoteRow({ quote: q, rank, scale, board, chosen, onChanged }: { quote: Quote; rank: number; scale: number; board: DealBoard; chosen: boolean; onChanged: () => Promise<void> }) {
  const rejected = board.rejected?.find((r) => r.quote_id === q.quote_id);
  const out = isUnsafe(board, q);
  const recommended = q.quote_id === board.recommended_quote_id;
  const highlight = chosen || (recommended && !board.quotes.some((x) => x.quote_id === chosenApproval(board)?.quote_id));
  const known = knownTotal(q);
  const overBudget = known && board.job.budget_usd !== undefined && q.total_usd > board.job.budget_usd;
  const flash = useFlashOnChange(q.total_usd);
  const biz = board.businesses.find((b) => b.id === q.business_id);
  const said = biz?.transcript_snippet;
  const countered = board.negotiation?.filter((n) => n.business_id === q.business_id) ?? [];
  const [talk, setTalk] = useState(false);

  return (
    <li className={`db-quote${highlight ? " is-best" : ""}${out ? " is-out" : ""}${flash ? " is-flash" : ""}`}>
      <span className="db-rank" aria-label={`Rank ${rank}`}>
        {rank}
      </span>
      <div className="db-quote-main">
        <div className="db-quote-line">
          <span className="db-biz">{q.business}</span>
          <ChannelBadge channel={q.channel} />
          {chosen && <span className="db-best-label">{board.payment?.status === "settled" ? "Won" : "Chosen"}</span>}
          {recommended && !chosen && <span className="db-best-label db-rec-label">Recommended</span>}
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
            tone={highlight ? "win" : out ? "risk" : undefined}
            label={`${usd(q.total_usd)}${board.job.budget_usd !== undefined ? ` against a ${usd(board.job.budget_usd)} budget` : ""}`}
          />
        )}
        {board.job.ask && board.job.ask.length > 0 && <AskFields quote={q} board={board} />}
        <div className="db-quote-meta">
          {q.per_unit_usd !== undefined && <span>{usd(q.per_unit_usd)} per person</span>}
          {q.deposit_usd !== undefined && <span>{usd(q.deposit_usd)} deposit</span>}
          <VerdictChip verdict={q.price_check} />
          {overBudget && !q.flags.includes("over_budget") && <FlagChip flag="over_budget" />}
          {q.flags.map((f) => (
            <FlagChip key={f} flag={f} />
          ))}
          {q.missing_fields && q.missing_fields.length > 0 && <span className="hg-flag hg-tone-warn">Still owes: {q.missing_fields.join(", ")}</span>}
          <button className="db-link" aria-expanded={talk} onClick={() => setTalk(!talk)}>
            {talk ? "Hide conversation" : "Conversation"}
          </button>
        </div>
        {recommended && (!TERMINAL.has(board.job.state) || chosen) && <p className="db-why">Why recommended: {whyRecommended(q, board)}</p>}
        {(recommended || chosen) && q.items.length > 0 && <p className="db-items">{q.items.join(", ")}</p>}
        {countered.map((n) => (
          <p key={`${n.business_id}-${n.round}`} className="db-neg">
            Countered with a real {usd(n.target_total_usd)} quote
            {basisName(board, n.basis_quote_id) ? ` from ${basisName(board, n.basis_quote_id)}` : ""}
            {n.outcome_total_usd !== null ? ` → ${usd(n.outcome_total_usd)}` : " · waiting for the answer"}
          </p>
        ))}
        {rejected && <p className="db-rejected">Can't be chosen: {rejected.detail}</p>}
        {!rejected && out && <p className="db-rejected">Can't be chosen: a safety flag on this quote.</p>}
        {said && !out && (
          <p className={`db-said db-said-${q.channel}`}>
            <span className="db-said-src">{q.channel === "phone" ? "On the call" : q.channel === "imessage" ? "Texted" : "Wrote"}</span> {said}
          </p>
        )}
        {talk && <ConversationPanel jobId={board.job.id} businessId={q.business_id} business={q.business} stamp={`${biz?.last_event_at ?? ""}|${biz?.last_event ?? ""}`} onClose={() => setTalk(false)} />}
        <QuoteAction board={board} quote={q} recommended={recommended} onChanged={onChanged} />
      </div>
    </li>
  );
}

/**
 * The human's confirm click on the board IS the approval: choose_in_view starts a board-only approval
 * (nothing texted or emailed, so no moot "reply YES"), approve_in_view records the human's yes with the
 * board's one-time code, and the engine charges the approved amount at once (outcome: paid, approved =
 * still settling, refused, confirmed). pay is only a retry for a charge that didn't go through.
 */
function useChooseFlow(board: DealBoard, q: Quote, onChanged: () => Promise<void>) {
  const start = useCallTool("choose_in_view");
  const approveInView = useCallTool("approve_in_view");
  const pay = useCallTool("pay");
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const busy = start.isPending || approveInView.isPending || pay.isPending;

  const run = async (fn: () => Promise<string | null>) => {
    setErr(null);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e) {
      const info = parseToolError(e);
      // The engine keeps one approval per job: say so plainly instead of a raw state error.
      setErr(info.code === "not_approvable" || info.code === "approval_pending" ? `${info.message} ${info.fix ?? ""}`.trim() : toolErrorText(e));
    }
    await onChanged();
  };

  const choose = () =>
    run(async () => {
      const res = await start.callTool({ job_id: board.job.id, quote_id: q.quote_id });
      const ticket = viewTicket((res as { _meta?: Record<string, unknown> })._meta);
      if (!ticket) return `Approval is ${(res.structuredContent as { status?: string }).status ?? "not available here"}.`;
      const r = (await approveInView.callTool(ticket)).structuredContent as { status: string; outcome?: string; reason?: string; next?: string };
      if (r.status !== "approved") return `Approval is ${r.status}.`;
      if (r.outcome === "refused") throw new Error(`Approved, but the payment didn't go through: ${r.reason ?? r.next ?? "see the board"}`);
      return r.outcome === "approved" ? "Approved; the charge is settling." : null; // paid / confirmed: the board shows it
    });

  // Retry only: pay is idempotent (one charge per approval) and reports a charge already under way.
  const retryPay = () =>
    run(async () => {
      let res;
      try {
        res = await pay.callTool({ job_id: board.job.id, quote_id: q.quote_id });
      } catch (e) {
        if (parseToolError(e).code === "payment_refused_payment_in_flight") return "Payment is processing.";
        throw e;
      }
      const p = res.structuredContent as { status?: string; reason?: string };
      if (p.status === "refused") throw new Error(`Payment refused: ${p.reason ?? "see the deal board"}`);
      return p.status === "paid" ? null : "Payment is processing.";
    });

  return { choose, retryPay, busy, approving: start.isPending || approveInView.isPending, paying: pay.isPending, note, err };
}

/** The action under one quote: choose it, its approve → pay → receipt steps, or why it must wait. */
function QuoteAction({ board, quote: q, recommended, onChanged }: { board: DealBoard; quote: Quote; recommended: boolean; onChanged: () => Promise<void> }) {
  const choice = choiceFor(board, q);
  if (choice.kind === "none") return null;
  if (choice.kind === "held") return <DealAction board={board} quote={q} onChanged={onChanged} />;
  if (choice.kind === "blocked") return <Blocked choice={choice} />;
  return <ChooseAction board={board} quote={q} choice={choice} recommended={recommended} onChanged={onChanged} />;
}

function Blocked({ choice }: { choice: Extract<Choice, { kind: "blocked" }> }) {
  const [why, setWhy] = useState(false);
  return (
    <div className="db-approve">
      <button className="hg-btn hg-btn-quiet" aria-expanded={why} onClick={() => setWhy(!why)}>
        Choose this instead
      </button>
      {why && <span className="db-approve-hint db-blocked">{choice.reason}</span>}
    </div>
  );
}

/** Choose a safe option: one tap shows what will happen, a second confirms (money moves). */
function ChooseAction({ board, quote: q, choice, recommended, onChanged }: { board: DealBoard; quote: Quote; choice: Extract<Choice, { kind: "choose" }>; recommended: boolean; onChanged: () => Promise<void> }) {
  const flow = useChooseFlow(board, q, onChanged);
  const [confirming, setConfirming] = useState(false);
  const warning = negotiationWarning(board);
  const caveats = [
    knownTotal(q) && board.job.budget_usd !== undefined && q.total_usd > board.job.budget_usd ? `${usd(q.total_usd - board.job.budget_usd)} over budget` : null,
    !q.meets_requirements ? "not every requirement confirmed" : null,
  ].filter(Boolean);
  return (
    <div className="db-approve">
      {confirming ? (
        <>
          <button className="hg-btn hg-btn-primary" disabled={flow.busy} onClick={() => void flow.choose().finally(() => setConfirming(false))}>
            {flow.approving ? "Approving…" : flow.paying ? "Paying…" : choice.pays ? `Yes, pay ${usd(choice.amount)} to ${q.business}` : `Yes, confirm ${q.business}`}
          </button>
          <button className="hg-btn hg-btn-quiet" disabled={flow.busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <span className="hg-muted db-approve-hint">
            {knownTotal(q) ? `${usd(q.total_usd)} order total. ` : ""}
            {choice.pays ? "Stripe test mode. " : "Nothing is paid now. "}
            {caveats.length ? `Heads up: ${caveats.join(", ")}.` : ""}
            {choice.replaces && choice.replaces !== q.business ? ` Replaces the ${choice.replaces} suggestion Haggle texted you.` : ""}
          </span>
          {warning && <span className="db-approve-hint db-warn-hint">{warning}</span>}
        </>
      ) : (
        <>
          <button className={`hg-btn${recommended ? " hg-btn-primary" : ""}`} disabled={flow.busy} onClick={() => setConfirming(true)}>
            {flow.busy ? "Working…" : choice.label}
          </button>
          {recommended && <span className="hg-muted db-approve-hint">Only you can choose; your agent can't.</span>}
        </>
      )}
      {flow.note && <span className="db-approve-status">{flow.note}</span>}
      {flow.err && (
        <span className="db-err" role="alert">
          {flow.err}
        </span>
      )}
    </div>
  );
}

/** Approve → pay → receipt for the quote that holds the job's approval. The human taps; the model can't. */
function DealAction({ board, quote: q, onChanged }: { board: DealBoard; quote: Quote; onChanged: () => Promise<void> }) {
  const flow = useChooseFlow(board, q, onChanged);
  const openExternal = useOpenExternal();
  const approval = board.approval?.quote_id === q.quote_id ? board.approval : null;
  const payment = approval ? board.payment : null;
  const deposit = q.deposit_usd ?? (knownTotal(q) ? q.total_usd : undefined);

  let body: ReactNode;
  if (approval?.status === "confirmed" || (board.job.state === "confirmed" && !payment)) {
    // A confirm-only approval: the order went ahead, nothing was paid.
    body = <span className="db-approved">Confirmed — the business was told to go ahead (nothing paid)</span>;
  } else if (payment?.status === "settled") {
    body = (
      <>
        <span className="db-paid">
          {usd(deposit)} {q.deposit_usd !== undefined ? "deposit " : ""}paid · {payment.simulated ? "simulated (demo), no money moved" : "Stripe test mode"}
        </span>
        {payment.receipt_url && (
          <button className="hg-btn" onClick={() => void openExternal({ url: payment.receipt_url! }).catch(() => {})}>
            View receipt
          </button>
        )}
      </>
    );
  } else if (payment && ["charging", "sent", "signed", "awaiting_invoice", "invoice_received"].includes(payment.status)) {
    body = <span className="db-approve-status">Payment processing…</span>;
  } else if (approval && (approval.status === "approved" || approval.status === "used")) {
    // The approval charges at once; a Pay click only appears to retry a charge that failed or never started.
    const failed = payment && ["failed", "rejected", "expired"].includes(payment.status);
    const pays = deposit !== undefined;
    body = (
      <>
        <span className="db-approved">Approved{approval.channel === "imessage" ? " by text" : approval.channel === "email" ? " by email" : approval.channel === "simulated" ? " (simulated, demo)" : ""}</span>
        {pays && (failed || !payment) && (
          <button className="hg-btn" disabled={flow.busy} onClick={() => void flow.retryPay()}>
            {flow.paying ? "Paying…" : `Retry payment of ${usd(deposit)}`}
          </button>
        )}
        {failed && <span className="db-err">Last payment {payment.status}.</span>}
      </>
    );
  } else if (approval && approval.status.startsWith("pending")) {
    body = (
      <>
        <span className="db-approve-status">
          {replaceableApproval(board)?.quote_id === q.quote_id
            ? "Haggle texted you this recommendation: reply YES to that text, approve here, or choose another option"
            : "Waiting for your approval (text, email or this board)"}
        </span>
        <button className="hg-btn hg-btn-primary" disabled={flow.busy} onClick={() => void flow.choose()}>
          {flow.approving ? "Approving…" : flow.paying ? "Paying…" : "Approve here"}
        </button>
      </>
    );
  } else {
    return null;
  }

  return (
    <div className="db-approve">
      {body}
      {flow.note && <span className="db-approve-status">{flow.note}</span>}
      {flow.err && (
        <span className="db-err" role="alert">
          {flow.err}
        </span>
      )}
    </div>
  );
}

/**
 * One business's thread, inline on the board: loaded with get_conversation when opened and again
 * when that business has news. Business text is untrusted data, rendered as plain text.
 */
function ConversationPanel({ jobId, businessId, business, stamp, onClose }: { jobId: string; businessId: string; business: string; stamp: string; onClose: () => void }) {
  const load = useCallTool("get_conversation");
  const [convo, setConvo] = useState<Conversation | null>(null);
  const [sent, setSent] = useState<ConversationEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchIt = useCallback(async () => {
    setError(null);
    try {
      const res = await load.callTool({ job_id: jobId, business_id: businessId, limit: 50 });
      setConvo(res.structuredContent as Conversation);
      setSent([]);
    } catch (e) {
      setError(toolErrorText(e));
    }
  }, [jobId, businessId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void fetchIt();
  }, [fetchIt, stamp]);

  const entries = convo ? mergeEntries(convo, sent) : [];
  return (
    <div className="db-convo" role="region" aria-label={`Conversation with ${business}`}>
      <div className="db-convo-head">
        <strong>Conversation with {business}</strong>
        <span className="hg-muted">{convo ? `${entries.length} message${entries.length === 1 ? "" : "s"}` : ""}</span>
        <button className="db-link" onClick={() => void fetchIt()} disabled={load.isPending}>
          {load.isPending ? "Loading…" : "Refresh"}
        </button>
        <button className="db-link" onClick={onClose}>
          Close
        </button>
      </div>
      {error ? (
        <p className="db-err" role="alert">
          Couldn't load the conversation: {error}
        </p>
      ) : !convo ? (
        <Skeleton rows={2} />
      ) : (
        <div className="cv">
          <EntryList entries={entries} business={business} />
          <Reply compact convo={convo} onSent={(e) => setSent((s) => [...s, e])} />
        </div>
      )}
    </div>
  );
}

/** Why the recommended quote is on top, said truthfully: what it meets or misses, its price among the options, the budget. */
function whyRecommended(q: Quote, board: DealBoard): string {
  // Options = every quote that isn't unsafe or unusable (preferences are soft).
  const options = board.quotes.filter((x) => !isUnsafe(board, x) && knownTotal(x));
  // A custom compare_by field ranks the ladder instead of the total.
  const rankBy = board.job.compare_by && board.job.ask?.find((f) => f.key === board.job.compare_by!.field);
  const best = rankBy ? `${board.job.compare_by!.direction === "min" ? "lowest" : "highest"} ${rankBy.label.toLowerCase()}` : "lowest total";
  const n = board.job.requirements.length;
  const parts = [
    q.meets_requirements ? (n ? `meets all ${n} requirements` : "meets the request")
      : q.flags.includes("requirement_unmet") ? "misses a requirement (see flags)" : "requirements not all confirmed by the business",
  ];
  const known = knownTotal(q);
  const cheaper = known ? options.filter((x) => x.total_usd < q.total_usd).length : 0;
  parts.push(options.length > 1 ? (cheaper === 0 ? `${best} of ${options.length} options` : `${options.length} options, ${cheaper} cheaper but missing more of what you asked`) : "the only option so far");
  if (known && board.job.budget_usd !== undefined) parts.push(q.total_usd <= board.job.budget_usd ? `${usd(board.job.budget_usd - q.total_usd)} under budget` : `${usd(q.total_usd - board.job.budget_usd)} over budget`);
  return `${parts.join(" · ")}.`;
}

function basisName(board: DealBoard, quoteId: string): string | undefined {
  return board.quotes.find((x) => x.quote_id === quoteId)?.business;
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

function Question({ jobId, question, onChanged }: { jobId: string; question: OpenQuestion; onChanged: () => Promise<void> }) {
  const answer = useCallTool("answer_business");
  const [draft, setDraft] = useState("");
  const sent = answer.data !== undefined;
  return (
    <div className="db-question">
      <p className="db-q-who">{question.business} asked</p>
      <p className="db-q-text">“{question.text}”</p>
      {sent ? (
        <p className="db-q-sent">Answer sent in their thread: “{draft}”</p>
      ) : (
        <form
          className="db-q-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            void answer
              .callTool({ job_id: jobId, question_id: question.question_id, answer: draft.trim() })
              .then(() => onChanged())
              .catch(() => {});
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Your answer" aria-label={`Answer ${question.business}`} maxLength={2000} />
          <button className="hg-btn" type="submit" disabled={answer.isPending || !draft.trim()}>
            {answer.isPending ? "Sending…" : "Send answer"}
          </button>
        </form>
      )}
      {answer.error && <span className="db-err">{toolErrorText(answer.error)}</span>}
    </div>
  );
}

function Businesses({ businesses, quotes, compact, jobId }: { businesses: DealBoardBusiness[]; quotes: Quote[]; compact: boolean; jobId: string }) {
  const quoted = new Set(quotes.map((q) => q.business_id));
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id));
  const stamp = (b: DealBoardBusiness) => `${b.last_event_at ?? ""}|${b.last_event}`;
  if (compact) {
    // Inline: one wrapped line of chips; businesses still waiting show their last event under it.
    const waiting = businesses.filter((b) => !quoted.has(b.id) && (b.last_event || b.transcript_snippet));
    return (
      <div className="db-biz-inline">
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
        {waiting.length > 0 && (
          <ul className="db-waiting">
            {waiting.map((b) => (
              <li key={b.id}>
                <strong>{b.name}:</strong> {b.unavailable_reason ?? b.transcript_snippet ?? b.last_event}
                {b.last_event_at && <span className="hg-muted"> · {relativeTime(b.last_event_at)}</span>}{" "}
                <button className="db-link" aria-expanded={open === b.id} onClick={() => toggle(b.id)}>
                  {open === b.id ? "Hide conversation" : "Conversation"}
                </button>
                {open === b.id && <ConversationPanel jobId={jobId} businessId={b.id} business={b.name} stamp={stamp(b)} onClose={() => setOpen(null)} />}
              </li>
            ))}
          </ul>
        )}
      </div>
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
              {b.unavailable_reason ?? b.last_event}
              {b.last_event_at && <span className="hg-muted"> · {relativeTime(b.last_event_at)}</span>}
              <button className="db-link" aria-expanded={open === b.id} onClick={() => toggle(b.id)}>
                {open === b.id ? "Hide conversation" : "Conversation"}
              </button>
            </p>
            {b.transcript_snippet && <p className={`db-said db-said-${b.channel}`}>{b.transcript_snippet}</p>}
            {open === b.id && <ConversationPanel jobId={jobId} businessId={b.id} business={b.name} stamp={stamp(b)} onClose={() => setOpen(null)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "paying" starts at approval; until a charge exists it reads as approved, waiting for Pay. */
function stateLabel(board: DealBoard): string {
  if (board.job.state === "paying" && !board.payment) return "Approved · ready to pay";
  return STATE_LABEL[board.job.state] ?? board.job.state;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
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
