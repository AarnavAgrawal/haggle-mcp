/**
 * Deal board (deal, get_quotes, open_haggle): what was asked, who Haggle contacted on which channel
 * and what each said, the quotes with what is and isn't stated, the negotiation step by step, the
 * recommendation and why, and the human's approve → pay → receipt steps.
 *
 * Renders only board fields (DealBoard + apps/mcp/src/views.ts DealBoardPlus); every action is an
 * MCP tool call and the server decides. Nothing here infers a price, a winner or a payment.
 */
import { ModelContext, useCallTool, useDisplayMode, useOpenExternal, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DealBoard as CoreDealBoard, DealBoardBusiness, DealBoardOrEmpty as CoreDealBoardOrEmpty, OpenQuestion, Quote } from "@haggle/core";
import {
  ChannelBadge, FlagChip, ModeBadge, Shell, Skeleton, ToolErrorNote, VerdictChip, isApproximate, isRiskFlag, payNow, payWords, relativeTime, toolErrorText, usd, viewTicket,
} from "../_shared/ui.tsx";
import "./view.css";

const TERMINAL = new Set(["paid", "cancelled", "failed"]);
const POLL_MS = 4000;
const RETRY_MS = 10_000;

type Sync = { at: number | null; trouble: boolean };

/** Server additions to the shared board (apps/mcp/src/views.ts DealBoardPlus); all optional. */
type Stage = { stage: string; negotiation: string; first_total_usd?: number; current_total_usd?: number; quote_version?: number; saved_usd?: number };
type Extras = {
  request_details?: { what: string; headcount: number; when: string; place: string; requirements: string[]; budget_usd: number | null; budget_source?: "request" | "settings_default" };
  payment_ceiling_usd?: number;
  payments_enabled?: boolean;
  dry_run?: boolean;
  would_contact?: { name: string; channel?: string }[];
  blocked?: { name: string; contact_state: string; channel?: string; reason?: string }[];
  setup?: { ready: number; total: number; blockers: { vendor: string; channel: string; reason: string; fix: string }[] };
  not_contacted?: { business: string; channel: string; reason: string }[];
  warnings?: string[];
  value?: {
    weights: Record<string, number>;
    recommendedQuoteId: string | null;
    ranked: { quoteId: string; business: string; score: number; confidence: number; factors: { name: string; score: number; weight: number; neutral: boolean; note: string }[] }[];
    explanation: { winner: string; others: { quote_id: string; text: string }[] } | null;
  };
  callbacks?: { business_id: string; business: string; their_total_usd: number; basis_total_usd: number; basis_business: string; why: string }[];
  stages?: Record<string, Stage>;
  contact_learning?: Record<string, { channels: Record<string, { contacted_jobs: number; replied_jobs: number; quotes: number; median_reply_minutes?: number }>; stated_preference?: { channel: string; excerpt: string } }>;
  terms?: Record<string, { fees?: { label: string; amount_usd?: number; included: boolean | null; excerpt: string }[]; deposit_terms?: string | null; cancellation?: string | null; exclusions?: string[] }>;
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

  const initial = ctx.status === "ready" ? (ctx.toolOutput as DealBoardOrEmpty | undefined) : null;
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
          <ToolErrorNote title="No deal was started. Nothing was sent." error={ctx.error} content={ctx.content} />
        ) : ctx.status === "ready" && !initial ? (
          <ToolErrorNote title="This deal didn't load." content={ctx.content} />
        ) : initial?.dry_run ? (
          <DryRun board={initial} />
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

// ---------------------------------------------------------------------------
// Before a deal: preview, setup, welcome

/** deal(dry_run): exactly who would be contacted on which channel; nothing was sent. */
function DryRun({ board }: { board: DealBoardOrEmpty }) {
  const would = board.would_contact ?? [];
  const blocked = board.blocked ?? [];
  return (
    <div className="db db-welcome">
      <header className="db-head">
        <div className="db-title">
          <h1>Preview: nothing was sent</h1>
          <p className="hg-muted">No deal was started. A real deal would contact exactly the businesses below.</p>
        </div>
        <ModeBadge mode={board.mode} />
      </header>
      <section className="db-card" aria-label="Would contact">
        <h2>Would contact ({would.length})</h2>
        {would.length ? (
          <ul className="db-plain">
            {would.map((w) => (
              <li key={w.name}>
                <strong>{w.name}</strong> {w.channel && <ChannelBadge channel={w.channel} />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hg-muted">Nobody: none of the selected businesses can be contacted.</p>
        )}
      </section>
      {blocked.length > 0 && (
        <section className="db-card db-card-warn" aria-label="Can't contact">
          <h2>Can't contact ({blocked.length})</h2>
          <ul className="db-plain">
            {blocked.map((b) => (
              <li key={b.name}>
                <strong>{b.name}</strong> <span className="hg-muted">({b.contact_state.replace(/_/g, " ")})</span>
                {b.reason && <span className="db-sub">{b.reason}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="db-next">{board.next}</p>
    </div>
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
            <strong>{b.vendor}</strong> <ChannelBadge channel={b.channel} /> {b.reason}.
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

// ---------------------------------------------------------------------------
// Derived, read-only facts about the board (never a decision)

type Phase = "contact" | "quotes" | "negotiate" | "recommend" | "approve" | "pay";
const PHASES: { key: Phase; label: string }[] = [
  { key: "contact", label: "Contact" },
  { key: "quotes", label: "Quotes" },
  { key: "negotiate", label: "Negotiate" },
  { key: "recommend", label: "Recommend" },
  { key: "approve", label: "Approve" },
  { key: "pay", label: "Pay" },
];

const NEGOTIATING_STAGES = new Set(["countered", "vendor_revised", "held_firm"]);
const ACTIVE_APPROVAL = (s?: string) => !!s && (s.startsWith("pending") || s === "approved" || s === "used");

function facts(board: DealBoard) {
  const approval = board.approval && ACTIVE_APPROVAL(board.approval.status) ? board.approval : null;
  const approved = approval && (approval.status === "approved" || approval.status === "used") ? approval : null;
  const settled = approved && board.payment?.status === "settled" ? board.payment : null;
  const recommended = board.quotes.find((q) => q.quote_id === board.recommended_quote_id);
  const focus = (approval ? board.quotes.find((q) => q.quote_id === approval.quote_id) : undefined) ?? recommended;
  const negotiated = (board.negotiation?.length ?? 0) > 0 || Object.values(board.stages ?? {}).some((s) => NEGOTIATING_STAGES.has(s.stage)) || board.job.state === "negotiating";
  const counterPending = (board.negotiation ?? []).filter((n) => n.outcome_total_usd === null).length;
  const quotedIds = new Set(board.quotes.map((q) => q.business_id));
  const waiting = board.businesses.filter((b) => !quotedIds.has(b.id) && bizStatus(b, board).tone === "active").length;

  // Current step, from real state only.
  let at: number;
  if (settled) at = PHASES.length; // all done
  else if (approved) at = 5; // pay
  else if (approval || board.ready) at = 4; // approve (recommendation made)
  else if (negotiated) at = 2;
  else if (board.quotes.length > 0) at = 1;
  else at = 0;
  return { approval, approved, settled, recommended, focus, negotiated, counterPending, waiting, at };
}

/** One sentence: where the deal is and whose move it is. */
function headline(board: DealBoard, f: ReturnType<typeof facts>): { text: string; tone: "info" | "you" | "done" | "risk" } {
  const n = board.businesses.length;
  if (board.job.state === "failed") return { text: "This deal stopped with an error. Nothing was paid.", tone: "risk" };
  if (board.job.state === "cancelled") return { text: "This deal was cancelled. Nothing was paid.", tone: "risk" };
  const q = f.focus;
  if (f.settled && q) return { text: `Paid ${payWords(payNow(q))} to ${q.business}${board.payment?.simulated ? " (simulated, no money moved)" : ""}.`, tone: "done" };
  if (f.approved && q) {
    if (board.payments_enabled === false) return { text: `You approved ${q.business}. Payments are off on this server, so nothing will be charged.`, tone: "info" };
    return { text: `You approved ${q.business}. Next: pay the ${payWords(payNow(q))}.`, tone: "you" };
  }
  if (f.approval && q) return { text: `Waiting for your approval of ${q.business}'s ${usd(q.total_usd)} quote.`, tone: "you" };
  if (board.ready && q) {
    const blocked = approveBlocker(q, board);
    return blocked
      ? { text: `Quotes are final. Haggle recommends ${q.business} at ${isApproximate(q) ? `about ${usd(q.total_usd)}` : usd(q.total_usd)}, but it can't be approved yet: ${blocked.short}.`, tone: "you" }
      : { text: `Quotes are final. Haggle recommends ${q.business} at ${usd(q.total_usd)}; approve to pay the ${payWords(payNow(q))}.`, tone: "you" };
  }
  if (board.open_questions.length) return { text: `${board.open_questions.length === 1 ? `${board.open_questions[0]!.business} asked a question` : `${board.open_questions.length} businesses asked questions`}: answer below so they can quote.`, tone: "you" };
  if (f.negotiated) {
    return { text: f.counterPending ? `Negotiating: ${f.counterPending} counteroffer${f.counterPending > 1 ? "s" : ""} sent, waiting for the answer${f.counterPending > 1 ? "s" : ""}.` : "Negotiating with the businesses that quoted.", tone: "info" };
  }
  if (board.quotes.length) return { text: `${board.quotes.length} quote${board.quotes.length > 1 ? "s" : ""} in from ${n} contacted${f.waiting ? `; waiting on ${f.waiting}` : ""}. No recommendation until quotes are final.`, tone: "info" };
  if (n) return { text: `Contacted ${n} business${n > 1 ? "es" : ""}. No replies with a price yet.`, tone: "info" };
  return { text: "Starting the deal.", tone: "info" };
}

/**
 * Why the Approve button would certainly be refused, from fields the server sent (a rough total, or a
 * pay-now amount over the per-payment ceiling). The server still decides; this only avoids a dead tap.
 */
function approveBlocker(q: Quote, board: DealBoard): { short: string; long: string } | null {
  if (isApproximate(q)) return { short: "the total is approximate", long: `${q.business} gave an approximate total. It can be approved once they confirm a firm one.` };
  const now = payNow(q);
  const ceiling = board.payment_ceiling_usd;
  if (board.payments_enabled !== false && ceiling !== undefined && now.amount > ceiling) {
    return {
      short: `${now.deposit ? `its ${usd(now.amount)} deposit` : `no deposit was stated, and the ${usd(now.amount)} full total`} is over the ${usd(ceiling)} per-payment ceiling`,
      long: `Paying now means the ${payWords(now)}${now.deposit ? "" : " (no deposit stated)"}, over the ${usd(ceiling)} per-payment ceiling. Ask ${q.business} for a ${now.deposit ? "smaller " : ""}deposit, or the operator to raise the ceiling.`,
    };
  }
  return null;
}

type Tone = "good" | "active" | "attention" | "out" | "done";

/** A business's status in words that never imply a price that doesn't exist. */
function bizStatus(b: DealBoardBusiness, board: DealBoard): { label: string; tone: Tone } {
  const has = board.quotes.some((q) => q.business_id === b.id);
  const priced = (label: string, tone: Tone = "good") => (has ? { label, tone } : { label: "Replied, no price yet", tone: "attention" as Tone });
  const s = board.stages?.[b.id]?.stage;
  switch (s) {
    case "sending": return { label: "Sending request", tone: "active" };
    case "waiting": return { label: "Waiting for reply", tone: "active" };
    case "calling": return { label: "On a call", tone: "active" };
    case "responded": return priced("Replied");
    case "reply_unreadable": return { label: "Replied, couldn't read a price", tone: "attention" };
    case "asked_question": return { label: "Asked a question", tone: "attention" };
    case "clarifying": return { label: "Confirming details", tone: "active" };
    case "quoted": return priced("Quoted");
    case "countered": return priced("Counteroffer sent", "active");
    case "vendor_revised": return priced("Lowered their price");
    case "held_firm": return priced("Held their price");
    case "final": return priced("Final quote");
    case "excluded": return { label: "Excluded", tone: "out" };
    case "buyer_approved": return priced("You approved", "done");
    case "paid": return priced("Paid", "done");
    case "no_reply": return { label: "No reply", tone: "out" };
    case "unreachable": return { label: "Can't reach", tone: "out" };
    case "declined": return { label: "Declined", tone: "out" };
  }
  switch (b.status) {
    case "contacted": return { label: "Waiting for reply", tone: "active" };
    case "ringing": return { label: "Ringing", tone: "active" };
    case "on_call": return { label: "On a call", tone: "active" };
    case "negotiating": return priced("Negotiating", "active");
    case "quoted":
    case "won": return priced("Quoted");
    case "declined": return { label: "Declined", tone: "out" };
    case "no_reply": return { label: "No reply", tone: "out" };
    case "unavailable": return { label: "Can't reach", tone: "out" };
  }
  return { label: String(s ?? b.status).replace(/_/g, " "), tone: "active" };
}

// ---------------------------------------------------------------------------
// The board

function Board({ board, sync, refreshing, onRefresh, onChanged }: { board: DealBoard; sync: Sync; refreshing: boolean; onRefresh: () => void; onChanged: () => Promise<void> }) {
  const { displayMode, availableDisplayModes, requestDisplayMode } = useDisplayMode();
  const followUp = useSendFollowUp();
  const fullscreen = displayMode === "fullscreen";
  const canFullscreen = availableDisplayModes.includes("fullscreen");
  const f = facts(board);
  const head = headline(board, f);
  const ask = (prompt: string) => void followUp({ prompt }).catch(() => {});
  const others = board.quotes.filter((q) => q.quote_id !== f.focus?.quote_id);
  const notes = [
    ...(board.not_contacted ?? []).map((n) => `Not contacted: ${n.business} (${n.channel}): ${n.reason}`),
    ...(board.warnings ?? []),
  ];

  return (
    <div className={`db${fullscreen ? " db-full" : ""}`}>
      <ModelContext
        content={`Haggle deal board for ${board.job.id}: ${head.text} ${board.quotes.length} quote(s); ${board.open_questions.length} open question(s).`}
      />
      <Header board={board} fullscreen={fullscreen} canFullscreen={canFullscreen} onToggle={() => void requestDisplayMode({ mode: fullscreen ? "inline" : "fullscreen" }).catch(() => {})} />

      <Stepper board={board} f={f} />
      <p className={`db-headline db-headline-${head.tone}`} aria-live="polite">
        {head.text}
      </p>
      {board.payments_enabled === false && !f.approved && <p className="db-note">Payments are off on this server: you can approve, but nothing can be charged.</p>}
      {board.setup && <Blockers setup={board.setup} />}

      {board.open_questions.length > 0 && (
        <section className="db-input" aria-label="Questions from businesses">
          {board.open_questions.map((q) => (
            <Question key={q.question_id} jobId={board.job.id} question={q} onChanged={onChanged} />
          ))}
        </section>
      )}

      <div className="db-body">
        <div className="db-main">
          {f.focus && <Focus board={board} quote={f.focus} f={f} onChanged={onChanged} />}
          {/* Inline: the one-line-per-business overview sits between the pick and the details. */}
          {!fullscreen && <Businesses board={board} />}
          {others.length > 0 && (
            <section aria-label="Other quotes">
              <h2 className="db-h2">{f.focus ? "Other quotes" : "Quotes"}</h2>
              <ol className="db-quotes">
                {others.map((q) => (
                  <QuoteRow key={q.quote_id} quote={q} board={board} />
                ))}
              </ol>
            </section>
          )}
        </div>
        <div className="db-side">
          {fullscreen && <Businesses board={board} />}
          {(board.callbacks?.length ?? 0) > 0 && !f.approval && (
            <section className="db-input" aria-label="Optional phone negotiation">
              {(board.callbacks ?? []).map((c) => (
                <Callback key={c.business_id} jobId={board.job.id} c={c} onChanged={onChanged} />
              ))}
            </section>
          )}
          {notes.length > 0 && (
            <details className="db-notes">
              <summary>Notes ({notes.length})</summary>
              <ul>
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      <footer className="db-foot">
        <p className="db-sync hg-muted" aria-live="polite">
          {sync.trouble ? "Reconnecting…" : sync.at ? `Updated ${relativeTime(new Date(sync.at).toISOString())}` : TERMINAL.has(board.job.state) ? "" : "Live"}
          <button className="db-link" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </p>
        <div className="db-foot-actions">
          {board.quotes.length > 1 && !f.settled && (
            <button className="hg-btn" onClick={() => ask(`Compare the quotes on Haggle job ${board.job.id} and tell me which one to approve and why.`)}>
              Compare quotes
            </button>
          )}
          {f.focus && f.settled && (
            <button className="hg-btn" onClick={() => ask(`Show what Haggle learned about ${f.focus!.business} (business_profile).`)}>
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

/** What was asked, exactly as the businesses were asked it. */
function Header({ board, fullscreen, canFullscreen, onToggle }: { board: DealBoard; fullscreen: boolean; canFullscreen: boolean; onToggle: () => void }) {
  const d = board.request_details;
  const budget = d ? d.budget_usd : board.job.budget_usd ?? null;
  const reqs = d ? d.requirements : board.job.requirements;
  return (
    <header className="db-head">
      <div className="db-title">
        <h1>{d ? `${capitalize(d.what)} for ${d.headcount}` : capitalize(board.job.request)}</h1>
        {d && (
          <p className="db-when">
            {d.when} · {d.place}
          </p>
        )}
        <dl className="db-ask">
          <div>
            <dt>Budget</dt>
            <dd>{budget !== null && budget !== undefined ? `${usd(budget)}${d?.budget_source === "settings_default" ? " (settings default)" : ""}` : "None set"}</dd>
          </div>
          {reqs.length > 0 && (
            <div>
              <dt>Must have</dt>
              <dd>{reqs.join("; ")}</dd>
            </div>
          )}
          <div>
            <dt>Payment</dt>
            <dd>
              {board.payments_enabled === false
                ? "Off on this server"
                : `Only after you approve${board.payment_ceiling_usd !== undefined ? `, up to ${usd(board.payment_ceiling_usd)} per payment` : ""}`}
            </dd>
          </div>
        </dl>
      </div>
      <div className="db-head-side">
        <ModeBadge mode={board.mode} />
        {canFullscreen && (
          <button className="hg-btn hg-btn-quiet" onClick={onToggle} aria-label={fullscreen ? "Exit full screen" : "Open full screen"}>
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
        )}
      </div>
    </header>
  );
}

/** Contact → Quotes → Negotiate → Recommend → Approve → Pay, from board state only. */
function Stepper({ board, f }: { board: DealBoard; f: ReturnType<typeof facts> }) {
  const stopped = board.job.state === "failed" || board.job.state === "cancelled";
  const quotedBiz = new Set(board.quotes.map((q) => q.business_id)).size;
  const sub: Record<Phase, string> = {
    contact: `${board.businesses.length} business${board.businesses.length === 1 ? "" : "es"}`,
    quotes: `${quotedBiz} of ${board.businesses.length}`,
    negotiate: board.negotiation?.length ? `${board.negotiation.length} counter${board.negotiation.length > 1 ? "s" : ""}` : f.at > 2 ? "not needed" : "",
    recommend: f.at > 3 && f.recommended ? f.recommended.business : "",
    approve: f.approved ? "done" : f.approval ? "waiting" : f.at === 4 ? (f.focus && approveBlocker(f.focus, board) ? "blocked" : "your turn") : "",
    pay: f.settled ? (board.payment?.simulated ? "simulated" : "paid") : f.approved ? "your turn" : "",
  };
  return (
    <ol className={`db-steps${stopped ? " is-stopped" : ""}`} aria-label="Deal progress">
      {PHASES.map((p, i) => {
        const state = i < f.at ? "done" : i === f.at && !stopped ? "now" : "todo";
        const skipped = p.key === "negotiate" && state === "done" && !f.negotiated;
        return (
          <li key={p.key} className={`is-${state}${skipped ? " is-skipped" : ""}`} aria-current={state === "now" ? "step" : undefined}>
            <span className="db-step-label">{p.label}</span>
            {sub[p.key] && <span className="db-step-sub">{sub[p.key]}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// The recommended (or approved) quote

function Focus({ board, quote: q, f, onChanged }: { board: DealBoard; quote: Quote; f: ReturnType<typeof facts>; onChanged: () => Promise<void> }) {
  const flash = useFlashOnChange(q.total_usd);
  const mine = f.approval?.quote_id === q.quote_id;
  const label = mine && f.settled ? "Paid" : mine && f.approved ? "Approved by you" : mine ? "Awaiting your approval" : board.ready ? "Recommended" : "Leading so far";
  const why = valueWhy(q, board);
  const factors = board.value?.ranked.find((x) => x.quoteId === q.quote_id)?.factors.filter((x) => x.weight > 0) ?? [];
  const isRec = q.quote_id === board.recommended_quote_id;
  return (
    <section className={`db-focus${board.ready || mine ? " is-final" : ""}${flash ? " is-flash" : ""}`} aria-label={label}>
      <p className="db-focus-label">{label}{!board.ready && !mine && <span className="hg-muted"> · quotes may still change</span>}</p>
      <div className="db-quote-line">
        <span className="db-biz db-biz-lg">{q.business}</span>
        <ChannelBadge channel={q.channel} />
        <Total q={q} board={board} large />
      </div>
      <QuoteFacts q={q} board={board} />
      <NegTrail board={board} businessId={q.business_id} />
      {mine && !isRec && f.recommended && (
        <p className="db-hint hg-muted">
          Haggle recommended {f.recommended.business} ({usd(f.recommended.total_usd)}); you approved this quote instead.
        </p>
      )}
      {isRec && (board.ready || mine) && (why || factors.length > 0) && (
        <div className="db-why-box">
          <p className="db-why">{why ?? "Best value of the eligible quotes."}</p>
          {factors.length > 0 && (
            <ul className="db-factors" aria-label="Why this score">
              {factors.map((x) => (
                <li key={x.name} className={x.neutral ? "is-neutral" : undefined} title={`${x.name}: ${x.score.toFixed(2)} × weight ${x.weight.toFixed(2)}`}>
                  <span className="db-factor-name">{x.name}</span>
                  <span>{x.note}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {q.items.length > 0 && <p className="db-items">Includes: {q.items.join(", ")}</p>}
      <Terms t={board.terms?.[q.quote_id]} />
      <Said board={board} q={q} />
      {board.ready || mine ? (
        <DealAction board={board} quote={q} onChanged={onChanged} />
      ) : (
        <p className="hg-muted db-hint">You can approve once Haggle has final quotes and makes a recommendation.</p>
      )}
    </section>
  );
}

function Total({ q, board, large }: { q: Quote; board: DealBoard; large?: boolean }) {
  const st = board.stages?.[q.business_id];
  const revised = st?.negotiation === "vendor_revised" && st.first_total_usd !== undefined && st.first_total_usd > q.total_usd;
  const was = revised ? st!.first_total_usd : q.negotiated_from !== undefined && q.negotiated_from > q.total_usd ? q.negotiated_from : undefined;
  return (
    <span className={`db-total${large ? " db-total-lg" : ""}`}>
      {was !== undefined && <s className="db-was" aria-label={`was ${usd(was)}`}>{usd(was)}</s>}
      {isApproximate(q) ? <span title="Approximate: the business gave a rough figure">≈ {usd(q.total_usd)}</span> : usd(q.total_usd)}
    </span>
  );
}

/** Per person, deposit (or "not stated"), what else is unknown, how sure Haggle is, and flags. */
function QuoteFacts({ q, board }: { q: Quote; board: DealBoard }) {
  // Deposit gets its own words below; tax and delivery are listed when the business didn't say.
  const unknown = [q.tax_usd === undefined ? "tax" : null, q.delivery_usd === undefined ? "delivery" : null].filter(Boolean) as string[];
  const overBudget = board.job.budget_usd !== undefined && q.total_usd > board.job.budget_usd;
  return (
    <>
      <div className="db-quote-meta">
        {q.per_unit_usd !== undefined && <span>{usd(q.per_unit_usd)} per person</span>}
        {q.deposit_usd !== undefined ? <span>{usd(q.deposit_usd)} deposit</span> : <span className="db-unknown">Deposit not stated</span>}
        {q.delivery_usd !== undefined && <span>{q.delivery_usd === 0 ? "Delivery included" : `Delivery ${usd(q.delivery_usd)}`}</span>}
        {q.tax_usd !== undefined && <span>{q.tax_usd === 0 ? "Tax included" : `Tax ${usd(q.tax_usd)}`}</span>}
        {unknown.length > 0 && <span className="hg-muted">{capitalize(unknown.join(" and "))} not stated</span>}
        {q.confidence < 0.8 && <span className="hg-muted">Read with {Math.round(q.confidence * 100)}% confidence</span>}
        {!q.flags.some(isRiskFlag) && <VerdictChip verdict={q.price_check} />}
        {overBudget && !q.flags.includes("over_budget") && <FlagChip flag="over_budget" />}
        {q.flags.map((x) => (
          <FlagChip key={x} flag={x} />
        ))}
      </div>
      {isApproximate(q) && <p className="db-warn-line">Approximate total: not approvable until {q.business} confirms a firm total.</p>}
    </>
  );
}

/** Their first price → Haggle's counter (with its real basis) → their answer → the revised offer. */
function NegTrail({ board, businessId }: { board: DealBoard; businessId: string }) {
  const rounds = (board.negotiation ?? []).filter((n) => n.business_id === businessId);
  if (!rounds.length) return null;
  const st = board.stages?.[businessId];
  return (
    <ol className="db-trail" aria-label="Negotiation">
      {st?.first_total_usd !== undefined && (
        <li>
          <span className="db-trail-k">Their quote</span> {usd(st.first_total_usd)}
        </li>
      )}
      {rounds.map((n) => {
        const basis = n.basis_quote_id === "buyer_target" ? null : board.quotes.find((x) => x.quote_id === n.basis_quote_id)?.business;
        const first = st?.first_total_usd;
        const answer =
          n.outcome_total_usd === null
            ? { k: "Their answer", v: "waiting", cls: "is-wait" }
            : first !== undefined && n.outcome_total_usd < first
              ? { k: "They revised", v: `${usd(n.outcome_total_usd)} (−${usd(st?.saved_usd ?? first - n.outcome_total_usd)})`, cls: "is-win" }
              : { k: "They held firm", v: usd(n.outcome_total_usd), cls: "" };
        return [
          <li key={`c${n.round}`}>
            <span className="db-trail-k">Haggle countered</span>{" "}
            {n.basis_quote_id === "buyer_target" ? `asked to get closer to your ${usd(n.target_total_usd)} target` : `with ${basis ? `${basis}'s` : "a"} real ${usd(n.target_total_usd)} quote`}
          </li>,
          <li key={`a${n.round}`} className={answer.cls}>
            <span className="db-trail-k">{answer.k}</span> {answer.v}
          </li>,
        ];
      })}
    </ol>
  );
}

/** The business's own words (never shown for flagged, unsafe replies; the server strips those). */
function Said({ board, q }: { board: DealBoard; q: Quote }) {
  const said = board.businesses.find((b) => b.id === q.business_id)?.transcript_snippet;
  if (!said || q.flags.some(isRiskFlag)) return null;
  return (
    <p className={`db-said db-said-${q.channel}`}>
      <span className="db-said-src">{q.channel === "phone" ? "On the call" : q.channel === "imessage" ? "Texted" : q.channel === "a2a" ? "Agent said" : "Wrote"}</span> {said}
    </p>
  );
}

/** Fees and commercial terms exactly as the business stated them. */
function Terms({ t }: { t?: NonNullable<Extras["terms"]>[string] }) {
  if (!t) return null;
  const lines = [
    ...(t.fees ?? []).map((x) => `${x.label}${x.amount_usd !== undefined ? ` ${usd(x.amount_usd)}` : ""}: ${x.included === true ? "included" : x.included === false ? "added to the all-in total" : "unclear if included"}`),
    ...(t.deposit_terms ? [`Deposit: ${t.deposit_terms}`] : []),
    ...(t.cancellation ? [`Cancellation: ${t.cancellation}`] : []),
    ...(t.exclusions?.length ? [`Excludes: ${t.exclusions.join(", ")}`] : []),
  ];
  return lines.length ? <ul className="db-terms">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : null;
}

/** Approve → pay → receipt for the recommended (or approved) quote. The human taps; the model can't. */
function DealAction({ board, quote: q, onChanged }: { board: DealBoard; quote: Quote; onChanged: () => Promise<void> }) {
  const approve = useCallTool("approve");
  const approveInView = useCallTool("approve_in_view");
  const pay = useCallTool("pay");
  const openExternal = useOpenExternal();
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const approval = board.approval?.quote_id === q.quote_id && ACTIVE_APPROVAL(board.approval.status) ? board.approval : null;
  const payment = approval ? board.payment : null;
  const busy = approve.isPending || approveInView.isPending || pay.isPending;
  const now = payNow(q);
  const words = payWords(now);
  const blocker = approveBlocker(q, board);

  const act = async (fn: () => Promise<string | null>) => {
    setErr(null);
    try {
      setNote(await fn());
    } catch (e) {
      setErr(errorText(e));
    }
    await onChanged();
  };

  const onApprove = () =>
    act(async () => {
      const res = await approve.callTool({ job_id: board.job.id, quote_id: q.quote_id });
      const a = res.structuredContent as { status?: string; reason?: string; channel?: string } | undefined;
      if (!a) throw new Error(resultText(res) ?? "Approval was refused.");
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
      const p = res.structuredContent as { status?: string; reason?: string } | undefined;
      if (!p) throw new Error(resultText(res) ?? "Payment was refused.");
      if (p.status === "refused") throw new Error(`Payment refused: ${p.reason ?? "see the deal board"}`);
      return p.status === "paid" ? null : "Payment is processing.";
    });

  let body: ReactNode;
  if (payment?.status === "settled") {
    body = (
      <>
        <span className="db-paid">
          {words} paid{now.deposit ? ` of the ${usd(q.total_usd)} total` : ""} · {payment.simulated ? "simulated (demo), no money moved" : "Stripe test mode"}
        </span>
        {payment.receipt_url && (
          <button className="hg-btn" onClick={() => void openExternal({ url: payment.receipt_url! }).catch(() => {})}>
            View receipt
          </button>
        )}
      </>
    );
  } else if (payment && ["charging", "sent", "signed", "awaiting_invoice", "invoice_received"].includes(payment.status)) {
    body = <span className="db-status">Paying the {words}…</span>;
  } else if (approval && (approval.status === "approved" || approval.status === "used") && board.payments_enabled === false) {
    body = (
      <>
        <span className="db-approved">Approved</span>
        <span className="hg-muted db-hint">Payments are off on this server, so nothing can be charged. The approval stays valid until it expires.</span>
      </>
    );
  } else if (approval && (approval.status === "approved" || approval.status === "used")) {
    const failed = payment && ["failed", "rejected", "expired"].includes(payment.status);
    body = (
      <>
        <span className="db-approved">Approved{approval.channel === "imessage" ? " by iMessage" : approval.channel === "simulated" ? " (simulated, demo)" : ""}</span>
        <button className="hg-btn hg-btn-primary" disabled={busy} onClick={() => void onPay()}>
          {pay.isPending ? "Paying…" : failed ? `Retry: pay ${words}` : `Pay ${words}`}
        </button>
        {failed && <span className="db-err">Last payment attempt {payment!.status}.</span>}
      </>
    );
  } else if (approval) {
    body = (
      <>
        <span className="db-status">{approval.channel === "imessage" ? "Waiting for the approver's iMessage (YES + code)" : "Waiting for your approval"}</span>
        <button className="hg-btn" disabled={busy} onClick={() => void onApprove()}>
          {approve.isPending || approveInView.isPending ? "Approving…" : "Approve here"}
        </button>
      </>
    );
  } else if (blocker) {
    body = <span className="db-blocked">Can't approve yet. {blocker.long}</span>;
  } else {
    body = (
      <>
        <button className="hg-btn hg-btn-primary" disabled={busy} onClick={() => void onApprove()}>
          {approve.isPending || approveInView.isPending ? "Approving…" : `Approve ${q.business}`}
        </button>
        <span className="hg-muted db-hint">
          Then you pay the {words}
          {now.deposit ? ` of the ${usd(q.total_usd)} total` : " (no deposit stated)"}. Only you can approve; your agent can't.
        </span>
      </>
    );
  }

  return (
    <div className="db-approve">
      {body}
      {note && <span className="db-status">{note}</span>}
      {err && (
        <span className="db-err" role="alert">
          {err}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Other quotes, businesses, questions

function QuoteRow({ quote: q, board }: { quote: Quote; board: DealBoard }) {
  const out = q.eligible === false || !q.meets_requirements || q.flags.some(isRiskFlag);
  const flash = useFlashOnChange(q.total_usd);
  const rejected = board.rejected?.find((r) => r.quote_id === q.quote_id);
  const reason = rejected?.detail ?? q.excluded_reason;
  const whyNot = board.value?.explanation?.others.find((o) => o.quote_id === q.quote_id)?.text;
  const status = bizStatus(board.businesses.find((b) => b.id === q.business_id) ?? ({ id: q.business_id, status: "quoted" } as DealBoardBusiness), board);
  return (
    <li className={`db-quote${out ? " is-out" : ""}${flash ? " is-flash" : ""}`}>
      <div className="db-quote-line">
        <span className="db-biz">{q.business}</span>
        <ChannelBadge channel={q.channel} />
        <span className={`db-tag db-tone-${status.tone}`}>{status.label}</span>
        {q.quote_id === board.recommended_quote_id && board.ready && <span className="db-tag db-pick">Haggle's pick</span>}
        <Total q={q} board={board} />
      </div>
      {out ? (
        <>
          <div className="db-quote-meta">
            {q.flags.map((x) => (
              <FlagChip key={x} flag={x} />
            ))}
          </div>
          <p className="db-rejected">Can't be approved{reason ? `: ${reason}` : "."}</p>
        </>
      ) : (
        <>
          <QuoteFacts q={q} board={board} />
          {whyNot && <p className="db-whynot">{whyNotText(whyNot)}</p>}
        </>
      )}
      <NegTrail board={board} businessId={q.business_id} />
      {!out && <Terms t={board.terms?.[q.quote_id]} />}
      <Said board={board} q={q} />
    </li>
  );
}

/** Everyone contacted: channel, status in plain words, and their price when one exists. */
function Businesses({ board }: { board: DealBoard }) {
  const learning = board.contact_learning;
  const history = (id: string) => {
    const l = learning?.[id];
    if (!l) return null;
    const parts = Object.entries(l.channels)
      .filter(([, r]) => r.contacted_jobs > 1)
      .map(([c, r]) => `${c === "imessage" ? "text" : c} ${r.replied_jobs}/${r.contacted_jobs}${r.median_reply_minutes !== undefined ? ` (${r.median_reply_minutes < 1 ? "<1" : `~${r.median_reply_minutes}`} min)` : ""}`);
    const pref = l.stated_preference ? `Prefers ${l.stated_preference.channel === "imessage" ? "text" : l.stated_preference.channel}: "${l.stated_preference.excerpt}"` : null;
    return [parts.length ? `Past replies: ${parts.join(" · ")}` : null, pref].filter(Boolean).join(" · ") || null;
  };
  if (!board.businesses.length) return null;
  return (
    <section className="db-biz-list" aria-label="Businesses contacted">
      <h2 className="db-h2">Contacted ({board.businesses.length})</h2>
      <ul>
        {board.businesses.map((b) => {
          const s = bizStatus(b, board);
          const q = board.quotes.find((x) => x.business_id === b.id);
          const st = board.stages?.[b.id];
          const detail = b.unavailable_reason ?? (q ? null : b.last_event);
          const h = history(b.id);
          return (
            <li key={b.id} className={`db-bizrow db-tone-${s.tone}`}>
              <div className="db-bizrow-line">
                <span className="db-dot" aria-hidden="true" />
                <span className="db-bizrow-name">{b.name}</span>
                <ChannelBadge channel={b.channel} />
                <span className="db-bizrow-status">{s.label}</span>
                <span className="db-bizrow-price">
                  {q ? (
                    <>
                      {st?.negotiation === "vendor_revised" && st.first_total_usd !== undefined && st.first_total_usd > q.total_usd && <s className="db-was">{usd(st.first_total_usd)}</s>}
                      {isApproximate(q) ? `≈ ${usd(q.total_usd)}` : usd(q.total_usd)}
                    </>
                  ) : (
                    <span className="hg-muted">—</span>
                  )}
                </span>
              </div>
              {(detail || b.last_event_at) && (
                <p className="db-bizrow-event">
                  {detail}
                  {b.last_event_at && <span className="hg-muted">{detail ? " · " : ""}{relativeTime(b.last_event_at)}</span>}
                </p>
              )}
              {h && <p className="db-bizrow-event hg-muted">{h}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Bay: $995 (negotiated down from $1,150), value 0.80 vs 0.82; Golden Grill is ahead on price: …" → the reason only. */
function whyNotText(t: string): string {
  const s = t.replace(/^[^:]+:\s*/, "").replace(/^\$[\d,.]+(\s*\([^)]*\))?,\s*value [\d.]+ vs [\d.]+;\s*/, "");
  return capitalize(s);
}

/** The best-value reason (server-computed, deterministic), without the leading business name. */
function valueWhy(q: Quote, board: DealBoard): string | null {
  const w = board.value?.explanation?.winner;
  if (!w || board.value?.recommendedQuoteId !== q.quote_id) return null;
  return w.replace(/^[^:]+:\s*/, "").replace(/^best value (\d\.\d\d) — /, "Best value ($1): ");
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
      const out = res.structuredContent as { status?: string } | undefined;
      if (!out) throw new Error(resultText(res) ?? "The call wasn't placed.");
      const code = ((res as { _meta?: Record<string, unknown> })._meta?.["haggle/callback"] as { code?: string } | undefined)?.code;
      if (out.status === "pending_human" && code) {
        await inView.callTool({ job_id: jobId, business_id: c.business_id, code });
        setState("placed");
      } else setState(out.status === "placed" ? "placed" : out.status === "declined" ? "declined" : "idle");
    } catch (e) {
      setErr(errorText(e));
      setState("error");
    }
    await onChanged();
  };
  return (
    <div className="db-question db-callback">
      <p className="db-q-who">Negotiate by phone? (optional)</p>
      <p className="db-q-text">
        {c.business} quoted {usd(c.their_total_usd)}; {c.basis_business} quoted {usd(c.basis_total_usd)} for the same order.
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

function Question({ jobId, question, onChanged }: { jobId: string; question: OpenQuestion; onChanged: () => Promise<void> }) {
  const answer = useCallTool("answer_business");
  const [draft, setDraft] = useState("");
  const sent = answer.data !== undefined && !answer.error;
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
      {answer.error && <span className="db-err">{errorText(answer.error)}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers

function errorText(e: unknown): string {
  return toolErrorText(e) ?? "Something went wrong.";
}

function resultText(res: unknown): string | undefined {
  return toolErrorText((res as { content?: unknown })?.content);
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
