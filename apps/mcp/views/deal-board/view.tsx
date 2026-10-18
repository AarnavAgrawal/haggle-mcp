/**
 * Deal board (get_quotes, open_haggle): who Haggle contacted on which channel, what each business
 * said, the quotes as a ranked ladder against the budget, why the winner wins, and the human's
 * approve → pay → receipt steps. Renders only DealBoard fields; every action is an MCP tool call.
 */
import { ModelContext, useCallTool, useDisplayMode, useOpenExternal, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DealBoard as CoreDealBoard, DealBoardBusiness, DealBoardOrEmpty as CoreDealBoardOrEmpty, OpenQuestion, Quote } from "@haggle/core";
import { ChannelBadge, ErrorNote, FlagChip, Meter, ModeBadge, Shell, Skeleton, VerdictChip, isRiskFlag, relativeTime, usd, viewTicket } from "../_shared/ui.tsx";
import "./view.css";

const TERMINAL = new Set(["paid", "cancelled", "failed"]);
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

/** Server additions to the shared board (apps/mcp/src/views.ts DealBoardPlus); all optional. */
type Extras = {
  request_details?: { what: string; headcount: number; when: string; place: string; requirements: string[]; budget_usd: number | null; budget_source?: "request" | "settings_default" };
  payment_ceiling_usd?: number;
  payments_enabled?: boolean;
  setup?: { ready: number; total: number; blockers: { vendor: string; channel: string; reason: string; fix: string }[] };
  not_contacted?: { business: string; channel: string; reason: string }[];
  value?: {
    weights: Record<string, number>;
    recommendedQuoteId: string | null;
    ranked: { quoteId: string; business: string; score: number; confidence: number; factors: { name: string; score: number; weight: number; neutral: boolean; note: string }[] }[];
    explanation: { winner: string; others: { quote_id: string; text: string }[] } | null;
  };
  callbacks?: { business_id: string; business: string; their_total_usd: number; basis_total_usd: number; basis_business: string; why: string }[];
  stages?: Record<string, { stage: string; negotiation: string; first_total_usd?: number; current_total_usd?: number; quote_version?: number; saved_usd?: number }>;
  contact_learning?: Record<string, { channels: Record<string, { contacted_jobs: number; replied_jobs: number; quotes: number; median_reply_minutes?: number }>; stated_preference?: { channel: string; excerpt: string } }>;
  terms?: Record<string, { fees?: { label: string; amount_usd?: number; included: boolean | null; excerpt: string }[]; deposit_terms?: string | null; cancellation?: string | null; exclusions?: string[] }>;
};

/** Fees and commercial terms exactly as the business stated them. */
function Terms({ t }: { t?: NonNullable<Extras["terms"]>[string] }) {
  if (!t) return null;
  const lines = [
    ...(t.fees ?? []).map((f) => `${f.label}${f.amount_usd !== undefined ? ` ${usd(f.amount_usd)}` : ""}: ${f.included === true ? "included" : f.included === false ? "added to the all-in total" : "unclear if included"}`),
    ...(t.deposit_terms ? [`Deposit: ${t.deposit_terms}`] : []),
    ...(t.cancellation ? [`Cancellation: ${t.cancellation}`] : []),
    ...(t.exclusions?.length ? [`Excludes: ${t.exclusions.join(", ")}`] : []),
  ];
  return lines.length ? <ul className="db-terms">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : null;
}

/** Finer stage words than the shared status (a counteroffer is never shown as a price). */
const STAGE_LABEL: Record<string, string> = {
  sending: "Sending", waiting: "Waiting for reply", calling: "Calling", responded: "Replied", asked_question: "Asked a question", clarifying: "Confirming details",
  quoted: "Quoted", countered: "Countered, awaiting answer", vendor_revised: "Lowered their price", held_firm: "Held firm", final: "Final quote", excluded: "Can't win",
  buyer_approved: "Approved by you", paid: "Paid", no_reply: "No reply", unreachable: "Can't reach", declined: "Declined",
};
type DealBoard = CoreDealBoard & Extras;
type DealBoardOrEmpty = CoreDealBoardOrEmpty & Extras;

export default function DealBoardView() {
  const ctx = useToolContext<"get_quotes">();
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

  // Live updates: wait for a change, then re-read the board. Stops when the job ends.
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

  if (!board) {
    return (
      <Shell>
        {ctx.status === "error" ? (
          <ErrorNote title="Couldn't load this deal." detail={ctx.error.message} />
        ) : initial && !initial.job && initial.setup && initial.setup.ready === 0 ? (
          <SetupNeeded board={initial} />
        ) : initial && !initial.job ? (
          <Welcome mode={initial.mode} setup={initial.setup} />
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
        onChanged={() => reload(board.job.id).catch(() => setSync((s) => ({ ...s, trouble: true })))}
      />
    </Shell>
  );
}

/** No vendor can be contacted yet: nothing was sent; show exactly what to set up and who does it. */
function SetupNeeded({ board }: { board: DealBoardOrEmpty }) {
  const setup = board.setup!;
  return (
    <div className="db db-welcome">
      <header className="db-head">
        <div className="db-title">
          <h1>Setup needed</h1>
          <p className="hg-muted">None of the {setup.total} demo vendors can be contacted from this server yet, so no deal was started and nothing was sent.</p>
        </div>
        <ModeBadge mode={board.mode} />
      </header>
      <Blockers setup={setup} open />
    </div>
  );
}

/** Demo vendors that can't be contacted, each with the exact fix. */
function Blockers({ setup, open = false }: { setup: NonNullable<Extras["setup"]>; open?: boolean }) {
  if (!setup.blockers.length) return null;
  return (
    <details className="db-setup" open={open}>
      <summary>
        {setup.ready} of {setup.total} demo vendors ready · {setup.blockers.length} need setup
      </summary>
      <ul>
        {setup.blockers.map((b) => (
          <li key={b.vendor}>
            <strong>{b.vendor}</strong> <ChannelBadge channel={b.channel as Quote["channel"]} /> {b.reason}.
            <span className="db-setup-fix">{b.fix}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** open_haggle before any deal: what Haggle does and two ways to start. */
function Welcome({ mode, setup }: { mode?: "mock" | "live"; setup?: Extras["setup"] }) {
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
        <button className="hg-btn hg-btn-primary" onClick={() => ask("Use Haggle to get catering quotes for 200 people next Saturday at noon at the YC office in San Francisco, 40 vegetarian, budget $5,000.")}>
          Start a catering deal
        </button>
        <button className="hg-btn" onClick={() => ask("Use Haggle's ask tool for an instant estimate: lunch catering for 40 in San Francisco.")}>
          Instant estimate
        </button>
      </div>
      {setup && <Blockers setup={setup} />}
    </div>
  );
}

function Board({ board, sync, refreshing, onRefresh, onChanged }: { board: DealBoard; sync: Sync; refreshing: boolean; onRefresh: () => void; onChanged: () => Promise<void> }) {
  const { displayMode, availableDisplayModes, requestDisplayMode } = useDisplayMode();
  const followUp = useSendFollowUp();
  const fullscreen = displayMode === "fullscreen";
  const canFullscreen = availableDisplayModes.includes("fullscreen");
  const best = board.quotes.find((q) => q.quote_id === board.recommended_quote_id);
  const winner = (board.payment?.status === "settled" || board.approval) ? board.quotes.find((q) => q.quote_id === board.approval?.quote_id) ?? best : best;
  const ask = (prompt: string) => void followUp({ prompt }).catch(() => {});

  return (
    <div className={`db${fullscreen ? " db-full" : ""}`}>
      <ModelContext
        content={`Haggle deal board for ${board.job.id}: ${stateLabel(board)}; ${board.quotes.length} quotes; ${
          winner ? `recommended ${winner.business} ${usd(winner.total_usd)}` : "no recommendation yet"
        }; ${board.open_questions.length} open question(s)${board.payment?.status === "settled" ? "; deposit paid" : ""}.`}
      />
      <header className="db-head">
        <div className="db-title">
          {board.request_details ? (
            <>
              <h1>
                {capitalize(board.request_details.what)} for {board.request_details.headcount}
              </h1>
              <p className="db-when">
                {board.request_details.when} · {board.request_details.place}
              </p>
              <p className="hg-muted">
                {board.request_details.budget_usd !== null && (
                  <>
                    Budget {usd(board.request_details.budget_usd)}
                    {board.request_details.budget_source === "settings_default" ? " (settings default)" : ""}.{" "}
                  </>
                )}
                {board.request_details.requirements.join(", ")}
                {board.payments_enabled === false ? <> · Payments are off on this server</> : board.payment_ceiling_usd !== undefined && <> · Deposits only after your approval, up to {usd(board.payment_ceiling_usd)}</>}
              </p>
            </>
          ) : (
            <>
              <h1>{capitalize(board.job.request)}</h1>
              <p className="hg-muted">
                {board.job.budget_usd !== undefined && <>Budget {usd(board.job.budget_usd)}. </>}
                {board.job.requirements.join(", ")}
              </p>
            </>
          )}
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
      {board.setup && <Blockers setup={board.setup} />}

      <div className="db-body">
        <section className="db-ladder" aria-label="Quotes, best first">
          <Ladder board={board} winnerId={winner?.quote_id} onChanged={onChanged} />
        </section>
        <section className="db-side">
          {(board.callbacks ?? []).map((c) => (
            <Callback key={c.business_id} jobId={board.job.id} c={c} onChanged={onChanged} />
          ))}
          {board.open_questions.map((q) => (
            <Question key={q.question_id} jobId={board.job.id} question={q} onChanged={onChanged} />
          ))}
          <Businesses businesses={board.businesses} quotes={board.quotes} compact={!fullscreen} stages={board.stages} learning={board.contact_learning} />
        </section>
      </div>

      <footer className="db-foot">
        <p className="db-sync hg-muted" aria-live="polite">
          {sync.trouble ? "Reconnecting…" : sync.at ? `Updated ${relativeTime(new Date(sync.at).toISOString())}` : TERMINAL.has(board.job.state) ? "" : "Live"}
          <button className="db-link" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
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
  const scale = Math.max(board.job.budget_usd ?? 0, ...board.quotes.map((q) => q.total_usd)) * 1.05;
  return (
    <ol className="db-quotes">
      {board.quotes.map((q, i) => (
        <QuoteRow key={q.quote_id} quote={q} rank={i + 1} scale={scale} board={board} winner={q.quote_id === winnerId} onChanged={onChanged} />
      ))}
    </ol>
  );
}

function QuoteRow({ quote: q, rank, scale, board, winner, onChanged }: { quote: Quote; rank: number; scale: number; board: DealBoard; winner: boolean; onChanged: () => Promise<void> }) {
  const out = !q.meets_requirements || q.flags.some(isRiskFlag);
  const overBudget = board.job.budget_usd !== undefined && q.total_usd > board.job.budget_usd;
  const flash = useFlashOnChange(q.total_usd);
  const said = board.businesses.find((b) => b.id === q.business_id)?.transcript_snippet;
  const rejected = board.rejected?.find((r) => r.quote_id === q.quote_id);
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
          {winner && <span className="db-best-label">{board.payment?.status === "settled" ? "Won" : board.approval?.quote_id === q.quote_id ? "Chosen" : board.ready ? "Recommended" : "Leading so far"}</span>}
          <span className="db-total">
            {q.negotiated_from !== undefined && <s className="db-was">{usd(q.negotiated_from)}</s>}
            {usd(q.total_usd)}
          </span>
        </div>
        <Meter
          value={q.total_usd}
          max={scale}
          marker={board.job.budget_usd}
          tone={winner ? "win" : out ? "risk" : undefined}
          label={`${usd(q.total_usd)}${board.job.budget_usd !== undefined ? ` against a ${usd(board.job.budget_usd)} budget` : ""}`}
        />
        <div className="db-quote-meta">
          {q.per_unit_usd !== undefined && <span>{usd(q.per_unit_usd)} per person</span>}
          {q.deposit_usd !== undefined && <span>{usd(q.deposit_usd)} deposit</span>}
          {!q.flags.some(isRiskFlag) && <VerdictChip verdict={q.price_check} />}
          {overBudget && !q.flags.includes("over_budget") && <FlagChip flag="over_budget" />}
          {q.flags.map((f) => (
            <FlagChip key={f} flag={f} />
          ))}
        </div>
        {winner && <p className="db-why">{valueWhy(q, board) ?? whyWinner(q, board)}</p>}
        {winner && <Factors board={board} quoteId={q.quote_id} />}
        {!winner && q.meets_requirements && <WhyNot board={board} quoteId={q.quote_id} />}
        {winner && q.items.length > 0 && <p className="db-items">{q.items.join(", ")}</p>}
        <Terms t={(board as DealBoard).terms?.[q.quote_id]} />
        {countered.map((n) => (
          <p key={`${n.business_id}-${n.round}`} className="db-neg">
            {n.basis_quote_id === "buyer_target" ? (
              <>Round {n.round}: asked to get closer to your {usd(n.target_total_usd)} target</>
            ) : (
              <>
                Round {n.round}: countered with a real {usd(n.target_total_usd)} quote
                {basisName(board, n.basis_quote_id) ? ` from ${basisName(board, n.basis_quote_id)}` : ""}
              </>
            )}
            {n.outcome_total_usd !== null ? ` → ${usd(n.outcome_total_usd)}` : " · waiting for the answer"}
          </p>
        ))}
        {rejected && <p className="db-rejected">Can't win: {rejected.detail}</p>}
        {said && !out && (
          <p className={`db-said db-said-${q.channel}`}>
            <span className="db-said-src">{q.channel === "phone" ? "On the call" : q.channel === "imessage" ? "Texted" : "Wrote"}</span> {said}
          </p>
        )}
        {winner && (board.ready || board.approval?.quote_id === q.quote_id ? (
          <DealAction board={board} quote={q} onChanged={onChanged} />
        ) : (
          <p className="hg-muted db-approve-hint">Negotiation in progress. Haggle recommends once quotes are final; you approve then.</p>
        ))}
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
    setErr(null);
    try {
      setNote(await fn());
    } catch (e) {
      setErr((e as Error).message);
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
  if (payment?.status === "settled") {
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
  } else if (approval && (approval.status === "approved" || approval.status === "used") && (board as DealBoard).payments_enabled === false) {
    body = (
      <>
        <span className="db-approved">Approved</span>
        <span className="hg-muted db-approve-hint">Payments are off on this server, so nothing can be charged yet. The approval stays valid until it expires.</span>
      </>
    );
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
          {approve.isPending || approveInView.isPending ? "Approving…" : `Approve ${usd(q.total_usd)} quote`}
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

/** The best-value reason (server-computed, deterministic), without the leading business name. */
function valueWhy(q: Quote, board: DealBoard): string | null {
  const w = board.value?.explanation?.winner;
  if (!w || board.value?.recommendedQuoteId !== q.quote_id) return null;
  return w.replace(/^[^:]+:\s*/, "").replace(/^best value (\d\.\d\d) — /, "Best value ($1): ");
}

/** Each factor of the winner's score with its evidence; neutral factors say so. */
function Factors({ board, quoteId }: { board: DealBoard; quoteId: string }) {
  const r = board.value?.ranked.find((x) => x.quoteId === quoteId);
  if (!r) return null;
  return (
    <ul className="db-factors" aria-label="Why this score">
      {r.factors.filter((f) => f.weight > 0).map((f) => (
        <li key={f.name} className={f.neutral ? "is-neutral" : undefined} title={`${f.name}: ${f.score.toFixed(2)} × weight ${f.weight.toFixed(2)}`}>
          <span className="db-factor-name">{f.name}</span> {f.note}
        </li>
      ))}
    </ul>
  );
}

function WhyNot({ board, quoteId }: { board: DealBoard; quoteId: string }) {
  const t = board.value?.explanation?.others.find((o) => o.quote_id === quoteId)?.text;
  return t ? <p className="db-whynot">{t.replace(/^[^:]+:\s*/, "")}</p> : null;
}

/** A justified negotiation callback: the human taps to authorize one AI-disclosed call. */
function Callback({ jobId, c, onChanged }: { jobId: string; c: NonNullable<Extras["callbacks"]>[number]; onChanged: () => Promise<void> }) {
  const call = useCallTool("call_back");
  const inView = useCallTool("call_back_in_view");
  const [state, setState] = useState<"idle" | "placed" | "declined" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setErr(null);
    try {
      const res = await call.callTool({ job_id: jobId, business_id: c.business_id });
      const out = res.structuredContent as { status?: string };
      const code = ((res as { _meta?: Record<string, unknown> })._meta?.["haggle/callback"] as { code?: string } | undefined)?.code;
      if (out.status === "pending_human" && code) {
        await inView.callTool({ job_id: jobId, business_id: c.business_id, code });
        setState("placed");
      } else setState(out.status === "placed" ? "placed" : out.status === "declined" ? "declined" : "idle");
    } catch (e) {
      setErr((e as Error).message);
      setState("error");
    }
    await onChanged();
  };
  return (
    <div className="db-question db-callback">
      <p className="db-q-who">Negotiate by phone?</p>
      <p className="db-q-text">
        {c.business} quoted {usd(c.their_total_usd)}. {c.basis_business} quoted {usd(c.basis_total_usd)} for the same order.
      </p>
      {state === "placed" ? (
        <p className="db-q-sent">Calling {c.business} back. The AI says it's an assistant and cites only the real {usd(c.basis_total_usd)} quote.</p>
      ) : state === "declined" ? (
        <p className="hg-muted">Not called.</p>
      ) : (
        <button className="hg-btn" disabled={call.isPending || inView.isPending} onClick={() => void go()}>
          {call.isPending || inView.isPending ? "Calling…" : `Call ${c.business} back`}
        </button>
      )}
      {err && <span className="db-err">{err}</span>}
    </div>
  );
}

function whyWinner(q: Quote, board: DealBoard): string {
  const eligible = board.quotes.filter((x) => x.meets_requirements && !x.flags.some(isRiskFlag));
  const parts = [
    board.job.requirements.length ? `Meets all ${board.job.requirements.length} requirements` : "Meets the request",
    eligible.length > 1 ? `lowest total of ${eligible.length} eligible quotes` : "the only eligible quote",
  ];
  if (board.job.budget_usd !== undefined && q.total_usd <= board.job.budget_usd) parts.push(`${usd(board.job.budget_usd - q.total_usd)} under budget`);
  const excluded = board.quotes.filter((x) => x.total_usd < q.total_usd && !eligible.includes(x)).length;
  if (excluded) parts.push(`${excluded} cheaper quote${excluded > 1 ? "s" : ""} excluded`);
  return `${parts.join(" · ")}.`;
}

function basisName(board: DealBoard, quoteId: string): string | undefined {
  return board.quotes.find((x) => x.quote_id === quoteId)?.business;
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
            if (draft.trim())
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
      {answer.error && <span className="db-err">{answer.error.message}</span>}
    </div>
  );
}

function Businesses({ businesses, quotes, compact, stages, learning }: { businesses: DealBoardBusiness[]; quotes: Quote[]; compact: boolean; stages?: Extras["stages"]; learning?: Extras["contact_learning"] }) {
  /** "Replies: email 2/3 · text 1/1 (~4 min)"; only with history beyond this one deal. */
  const history = (id: string) => {
    const l = learning?.[id];
    if (!l) return null;
    const parts = Object.entries(l.channels).filter(([, r]) => r.contacted_jobs > 1).map(([c, r]) => `${c === "imessage" ? "text" : c} ${r.replied_jobs}/${r.contacted_jobs}${r.median_reply_minutes !== undefined ? ` (~${r.median_reply_minutes} min)` : ""}`);
    const pref = l.stated_preference ? `Prefers ${l.stated_preference.channel === "imessage" ? "text" : l.stated_preference.channel}: "${l.stated_preference.excerpt}"` : null;
    return [parts.length ? `Replies: ${parts.join(" · ")}` : null, pref].filter(Boolean).join(" · ") || null;
  };
  const label = (b: DealBoardBusiness) => (stages?.[b.id] ? STAGE_LABEL[stages[b.id]!.stage] ?? stages[b.id]!.stage : STATUS_LABEL[b.status] ?? b.status);
  const quoted = new Set(quotes.map((q) => q.business_id));
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
              <span className="db-chip-status">{label(b)}</span>
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
              <span className="db-bizrow-status">{label(b)}</span>
            </div>
            <p className="db-bizrow-event">
              {b.unavailable_reason ?? b.last_event}
              {b.last_event_at && <span className="hg-muted"> · {relativeTime(b.last_event_at)}</span>}
            </p>
            {history(b.id) && <p className="hg-muted db-bizrow-event">{history(b.id)}</p>}
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
  if (board.ready && (board.job.state === "collecting" || board.job.state === "negotiating")) return "Ready to approve";
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
