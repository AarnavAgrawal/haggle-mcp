/**
 * Deal board (get_quotes, open_haggle): who Haggle contacted on which channel, what each business
 * said, the quotes as a ranked ladder against the budget, why the winner wins, and the human's
 * approve → pay → receipt steps. Renders only DealBoard fields; every action is an MCP tool call.
 */
import { ModelContext, useCallTool, useDisplayMode, useOpenExternal, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DealBoard, DealBoardBusiness, DealBoardOrEmpty, OpenQuestion, Quote } from "@haggle/core";
import { ChannelBadge, ErrorNote, FlagChip, Meter, ModeBadge, Shell, Skeleton, VerdictChip, isRiskFlag, relativeTime, usd, viewTicket } from "../_shared/ui.tsx";
import { formatField, toolErrorText } from "../_shared/format.ts";
import { actedRecently, covered, isReady, markOwnAction, meaningful, readMark, readToggle, shouldSend, summarize, writeMark, writeToggle, type NotifyMark, type WaitUpdate } from "./keepChat.ts";
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
const totalText = (q: Quote) => (knownTotal(q) ? usd(q.total_usd) : "total not stated");

export default function DealBoardView() {
  const ctx = useToolContext<"get_quotes">();
  const refresh = useCallTool("get_quotes");
  const wait = useCallTool("wait_for_update");
  const [live, setLive] = useState<DealBoard | null>(null);
  const [sync, setSync] = useState<Sync>({ at: null, trouble: false });
  const cursor = useRef("0");
  const followUp = useSendFollowUp();
  const [keepChat, setKeepChat] = useState(true);
  const keepChatRef = useRef(true);
  const latest = useRef<DealBoard | null>(null);
  // Keep-chat bookkeeping: updates waiting to be told, the first poll (history, never told), the
  // ready state this board first saw, the last notice (memory copy for blocked storage), own clicks.
  const pending = useRef<{ updates: WaitUpdate[]; cursor: number | null }>({ updates: [], cursor: null });
  const firstPoll = useRef(true);
  const readySeen = useRef<boolean | null>(null);
  const memMark = useRef<NotifyMark | null>(null);

  const initial = ctx.status === "ready" ? (ctx.toolOutput as DealBoardOrEmpty) : null;
  const board = live ?? (initial?.job ? (initial as DealBoard) : null);
  const jobId = board?.job.id;
  const active = board ? !TERMINAL.has(board.job.state) : false;
  latest.current = board;

  useEffect(() => {
    if (!jobId) return;
    const on = readToggle(jobId);
    keepChatRef.current = on;
    setKeepChat(on);
  }, [jobId]);

  const toggleKeepChat = (on: boolean) => {
    keepChatRef.current = on;
    setKeepChat(on);
    if (jobId) writeToggle(jobId, on);
    if (!on) pending.current = { updates: [], cursor: null };
  };

  const reload = useCallback(async (id: string) => {
    const next = await refresh.callTool({ job_id: id });
    setLive(next.structuredContent as DealBoard);
    latest.current = next.structuredContent as DealBoard;
    setSync({ at: Date.now(), trouble: false });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Wake the chat with one short message when this board has news the model hasn't been told. */
  const notifyChat = useCallback((id: string) => {
    const b = latest.current;
    if (!b || b.job.id !== id || TERMINAL.has(b.job.state) || !keepChatRef.current) {
      pending.current = { updates: [], cursor: null };
      return;
    }
    const readyNow = isReady(b);
    if (readySeen.current === null) readySeen.current = readyNow; // ready when first seen: the model knows
    const newReady = readyNow && !readySeen.current;
    const mark = readMark(id) ?? memMark.current;
    const p = pending.current;
    const now = Date.now();
    if (covered(p.cursor, newReady, mark)) {
      pending.current = { updates: [], cursor: null }; // another board for this job already told the chat
      if (newReady) readySeen.current = true;
      return;
    }
    if (!shouldSend(p.cursor, newReady, mark, now)) return; // rate-limited: keep batching
    const prompt = summarize(b, p.updates, newReady);
    pending.current = { updates: [], cursor: null };
    if (newReady) readySeen.current = true;
    if (!prompt) return;
    const next: NotifyMark = { cursor: p.cursor ?? Number(cursor.current), at: now, ready: newReady || mark?.ready === true };
    memMark.current = next;
    writeMark(id, next);
    void followUp({ prompt }).catch(() => {}); // a host that refuses follow-ups still gets the live board
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
        const w = res.structuredContent as { cursor: string; updates: WaitUpdate[]; timed_out: boolean };
        cursor.current = w.cursor;
        // The first poll replays history (cursor 0): the board shows it, the chat isn't told again.
        const fresh = firstPoll.current ? [] : meaningful(w.updates ?? [], actedRecently());
        firstPoll.current = false;
        if (fresh.length && keepChatRef.current) pending.current = { updates: [...pending.current.updates, ...fresh], cursor: Number(w.cursor) };
        if (!stopped && !w.timed_out && w.updates.length > 0) await reload(jobId);
        else if (!stopped) setSync((s) => ({ at: s.at ?? Date.now(), trouble: false }));
        if (!stopped) notifyChat(jobId);
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
  }, [jobId, active, reload, notifyChat]); // eslint-disable-line react-hooks/exhaustive-deps

  // Changes the human makes on this board (approve, pay, answer) don't wake the chat a second time.
  const changedHere = () => {
    markOwnAction();
    return reload(board!.job.id).catch(() => setSync((s) => ({ ...s, trouble: true })));
  };

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
        keepChat={keepChat}
        onKeepChat={toggleKeepChat}
      />
    </Shell>
  );
}

/** open_haggle before any deal: what Haggle does and two ways to start. */
function Welcome({ mode }: { mode?: "mock" | "live" }) {
  const followUp = useSendFollowUp();
  const ask = (prompt: string) => void followUp({ prompt }).catch(() => {});
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
        <button className="hg-btn hg-btn-primary" onClick={() => ask("Use Haggle to get catering quotes for 40 people next week in San Francisco, at least 12 vegetarian, delivered, budget $1,200.")}>
          Start a catering deal
        </button>
        <button className="hg-btn" onClick={() => ask("Use Haggle's ask tool for an instant estimate: lunch catering for 40 in San Francisco.")}>
          Instant estimate
        </button>
      </div>
    </div>
  );
}

function Board({ board, sync, refreshing, onRefresh, onChanged, keepChat, onKeepChat }: {
  board: DealBoard; sync: Sync; refreshing: boolean; onRefresh: () => void; onChanged: () => Promise<void>; keepChat: boolean; onKeepChat: (on: boolean) => void;
}) {
  const { displayMode, availableDisplayModes, requestDisplayMode } = useDisplayMode();
  const followUp = useSendFollowUp();
  const fullscreen = displayMode === "fullscreen";
  const canFullscreen = availableDisplayModes.includes("fullscreen");
  const best = board.quotes.find((q) => q.quote_id === board.recommended_quote_id);
  const winner = (board.payment?.status === "settled" || board.approval) ? board.quotes.find((q) => q.quote_id === board.approval?.quote_id) ?? best : best;
  const ask = (prompt: string) => void followUp({ prompt }).catch(() => {});
  const rankBy = board.job.compare_by && board.job.ask?.find((f) => f.key === board.job.compare_by!.field);

  return (
    <div className={`db${fullscreen ? " db-full" : ""}`}>
      <ModelContext
        content={`Haggle deal board for ${board.job.id}: ${stateLabel(board)}; ${board.quotes.length} quotes; ${
          winner ? `recommended ${winner.business} ${totalText(winner)}` : "no recommendation yet"
        }; ${board.open_questions.length} open question(s)${board.payment?.status === "settled" ? "; deposit paid" : ""}.`}
      />
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

      <div className="db-body">
        <section className="db-ladder" aria-label="Quotes, best first">
          <Ladder board={board} winnerId={winner?.quote_id} onChanged={onChanged} />
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
          {sync.trouble ? "Reconnecting…" : sync.at ? `Updated ${relativeTime(new Date(sync.at).toISOString())}` : TERMINAL.has(board.job.state) ? "" : "Live"}
          <button className="db-link" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {!TERMINAL.has(board.job.state) && (
            <label className="db-keep" title="When a quote, question or call result arrives, post a short update in the chat so your agent keeps going">
              <input type="checkbox" checked={keepChat} onChange={(e) => onKeepChat(e.currentTarget.checked)} />
              Keep chat updated
            </label>
          )}
        </p>
        <div className="db-foot-actions">
          {board.quotes.length > 1 && (
            <button className="hg-btn" onClick={() => ask(`Compare the quotes on Haggle job ${board.job.id} and tell me which one to approve and why.`)}>
              Compare quotes
            </button>
          )}
          {winner && board.payment?.status === "settled" && (
            <button className="hg-btn" onClick={() => ask(`Show what Haggle learned about ${winner.business} (business_profile).`)}>
              What Haggle learned
            </button>
          )}
          <button className="hg-btn" onClick={() => ask("Start another Haggle deal. Ask me what to buy, for how many, when and where.")}>
            New deal
          </button>
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

function Ladder({ board, winnerId, onChanged }: { board: DealBoard; winnerId?: string; onChanged: () => Promise<void> }) {
  if (board.quotes.length === 0) {
    return (
      <p className="db-empty">
        No quotes yet. A2A answers in seconds, texts and calls in minutes, email within the hour. This board updates by itself.
      </p>
    );
  }
  const scale = Math.max(board.job.budget_usd ?? 0, ...board.quotes.filter(knownTotal).map((q) => q.total_usd)) * 1.05;
  return (
    <ol className="db-quotes">
      {board.quotes.map((q, i) => (
        <QuoteRow key={q.quote_id} quote={q} rank={i + 1} scale={scale} board={board} winner={q.quote_id === winnerId} onChanged={onChanged} />
      ))}
    </ol>
  );
}

function QuoteRow({ quote: q, rank, scale, board, winner, onChanged }: { quote: Quote; rank: number; scale: number; board: DealBoard; winner: boolean; onChanged: () => Promise<void> }) {
  const rejected = board.rejected?.find((r) => r.quote_id === q.quote_id);
  const out = !!rejected || q.flags.some(isRiskFlag);
  const known = knownTotal(q);
  const overBudget = known && board.job.budget_usd !== undefined && q.total_usd > board.job.budget_usd;
  const followUp = useSendFollowUp();
  const flash = useFlashOnChange(q.total_usd);
  const said = board.businesses.find((b) => b.id === q.business_id)?.transcript_snippet;
  const countered = board.negotiation?.filter((n) => n.business_id === q.business_id) ?? [];

  return (
    <li className={`db-quote${winner ? " is-best" : ""}${out ? " is-out" : ""}${flash ? " is-flash" : ""}`}>
      <span className="db-rank" aria-label={`Rank ${rank}`}>
        {rank}
      </span>
      <div className="db-quote-main">
        <div className="db-quote-line">
          <span className="db-biz">{q.business}</span>
          <ChannelBadge channel={q.channel} />
          {winner && <span className="db-best-label">{board.payment?.status === "settled" ? "Won" : board.approval?.quote_id === q.quote_id ? "Chosen" : "Recommended"}</span>}
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
            tone={winner ? "win" : out ? "risk" : undefined}
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
          <button className="db-link" onClick={() => void followUp({ prompt: conversationPrompt(q.business, board.job.id, q.business_id) }).catch(() => {})}>
            Conversation
          </button>
        </div>
        {winner && <p className="db-why">{whyWinner(q, board)}</p>}
        {winner && q.items.length > 0 && <p className="db-items">{q.items.join(", ")}</p>}
        {countered.map((n) => (
          <p key={`${n.business_id}-${n.round}`} className="db-neg">
            Countered with a real {usd(n.target_total_usd)} quote
            {basisName(board, n.basis_quote_id) ? ` from ${basisName(board, n.basis_quote_id)}` : ""}
            {n.outcome_total_usd !== null ? ` → ${usd(n.outcome_total_usd)}` : " · waiting for the answer"}
          </p>
        ))}
        {rejected && <p className="db-rejected">Can't win: {rejected.detail}</p>}
        {said && !out && (
          <p className={`db-said db-said-${q.channel}`}>
            <span className="db-said-src">{q.channel === "phone" ? "On the call" : q.channel === "imessage" ? "Texted" : "Wrote"}</span> {said}
          </p>
        )}
        {winner && <DealAction board={board} quote={q} onChanged={onChanged} />}
      </div>
    </li>
  );
}

/** Approve → pay → receipt for the recommended (or approved) quote. The human taps; the model can't. */
function DealAction({ board, quote: q, onChanged }: { board: DealBoard; quote: Quote; onChanged: () => Promise<void> }) {
  const approve = useCallTool("approve");
  const approveInView = useCallTool("approve_in_view");
  const pay = useCallTool("pay");
  const openExternal = useOpenExternal();
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const approval = board.approval?.quote_id === q.quote_id ? board.approval : null;
  const payment = approval ? board.payment : null;
  const busy = approve.isPending || approveInView.isPending || pay.isPending;
  const deposit = q.deposit_usd;

  const act = async (fn: () => Promise<string | null>) => {
    markOwnAction(); // the chat isn't woken for steps the human takes here
    setErr(null);
    try {
      setNote(await fn());
    } catch (e) {
      setErr(toolErrorText(e));
    }
    await onChanged();
  };

  const onApprove = () =>
    act(async () => {
      const res = await approve.callTool({ job_id: board.job.id, quote_id: q.quote_id });
      const a = res.structuredContent as { status?: string; reason?: string; channel?: string };
      const ticket = viewTicket((res as { _meta?: Record<string, unknown> })._meta);
      if (a.status === "pending_human" && ticket) {
        const r = (await approveInView.callTool(ticket)).structuredContent as { status: string };
        return r.status === "approved" ? null : `Approval is ${r.status}.`;
      }
      if (a.status === "pending_human") return a.channel === "imessage" ? "Approval texted to the approver: reply YES with the code." : a.reason ?? "Waiting for the approver.";
      if (a.status === "refused") throw new Error(a.reason ?? "Approval refused.");
      return null;
    });

  const onPay = () =>
    act(async () => {
      const res = await pay.callTool({ job_id: board.job.id, quote_id: q.quote_id });
      const p = res.structuredContent as { status?: string; reason?: string };
      if (p.status === "refused") throw new Error(`Payment refused: ${p.reason ?? "see the deal board"}`);
      return p.status === "paid" ? null : "Payment is processing.";
    });

  let body: ReactNode;
  if (approval?.status === "confirmed" || (board.job.state === "confirmed" && !payment)) {
    // A confirm-only approval: the order went ahead, nothing was paid.
    body = <span className="db-approved">Confirmed — the business was told to go ahead (nothing paid)</span>;
  } else if (payment?.status === "settled") {
    body = (
      <>
        <span className="db-paid">
          {usd(deposit)} deposit paid · {payment.simulated ? "simulated (demo), no money moved" : "Stripe test mode"}
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
    body = (
      <>
        <span className="db-approved">Approved{approval.channel === "imessage" ? " by iMessage" : approval.channel === "simulated" ? " (simulated, demo)" : ""}</span>
        <button className="hg-btn hg-btn-primary" disabled={busy} onClick={() => void onPay()}>
          {pay.isPending ? "Paying…" : payment && ["failed", "rejected", "expired"].includes(payment.status) ? "Retry payment" : `Pay ${usd(deposit)} deposit`}
        </button>
        {payment && ["failed", "rejected", "expired"].includes(payment.status) && <span className="db-err">Last payment {payment.status}.</span>}
      </>
    );
  } else if (approval && approval.status.startsWith("pending")) {
    body = (
      <>
        <span className="db-approve-status">{approval.channel === "imessage" ? "Waiting for the approver's iMessage (YES + code)" : "Waiting for the approver"}</span>
        <button className="hg-btn" disabled={busy} onClick={() => void onApprove()}>
          {approve.isPending || approveInView.isPending ? "Approving…" : "Approve here"}
        </button>
      </>
    );
  } else {
    body = (
      <>
        <button className="hg-btn hg-btn-primary" disabled={busy} onClick={() => void onApprove()}>
          {approve.isPending || approveInView.isPending ? "Approving…" : knownTotal(q) ? `Approve ${usd(q.total_usd)}` : "Approve"}
        </button>
        <span className="hg-muted db-approve-hint">{deposit !== undefined ? `Then pay the ${usd(deposit)} deposit. ` : ""}Only you can approve; your agent can't.</span>
      </>
    );
  }

  return (
    <div className="db-approve">
      {body}
      {note && <span className="db-approve-status">{note}</span>}
      {err && (
        <span className="db-err" role="alert">
          {err}
        </span>
      )}
    </div>
  );
}

/** Why this quote is on top, said truthfully: what it meets or misses, its price among the options, the budget. */
function whyWinner(q: Quote, board: DealBoard): string {
  // Options = every quote that isn't unsafe or unusable (preferences are soft).
  // (The engine's rejected list is the safety verdict; an over-budget chip is red but not unsafe.)
  const options = board.quotes.filter((x) => !board.rejected?.some((r) => r.quote_id === x.quote_id) && knownTotal(x));
  // A custom compare_by field ranks the ladder instead of the total.
  const rankBy = board.job.compare_by && board.job.ask?.find((f) => f.key === board.job.compare_by!.field);
  const best = rankBy ? `${board.job.compare_by!.direction === "min" ? "lowest" : "highest"} ${rankBy.label.toLowerCase()}` : "lowest total";
  const n = board.job.requirements.length;
  const parts = [
    q.meets_requirements ? (n ? `Meets all ${n} requirements` : "Meets the request")
      : q.flags.includes("requirement_unmet") ? "Misses a requirement (see flags)" : "Requirements not all confirmed by the business",
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

/** The board can't open another view itself: ask the assistant to show get_conversation. */
const conversationPrompt = (business: string, jobId: string, businessId: string) =>
  `Show me the Haggle conversation with ${business} on job ${jobId} (get_conversation with job_id ${jobId}, business_id ${businessId}).`;

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
            markOwnAction();
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
  const followUp = useSendFollowUp();
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
                {b.last_event_at && <span className="hg-muted"> · {relativeTime(b.last_event_at)}</span>}
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
              <button className="db-link" onClick={() => void followUp({ prompt: conversationPrompt(b.name, jobId, b.id) }).catch(() => {})}>
                Conversation
              </button>
            </p>
            {b.transcript_snippet && <p className={`db-said db-said-${b.channel}`}>{b.transcript_snippet}</p>}
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
