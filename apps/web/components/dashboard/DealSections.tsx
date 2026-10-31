// The deal board's sections (server components; DESIGN.md "Deal board"): header, questions waiting for
// the buyer, the quote sheet, activity, the side column, callbacks and the purchase. Business text is
// untrusted data: rendered as plain text, marked as from the business, never as HTML or links.
import Link from "next/link";
import type { ReactNode } from "react";
import { CallbackButton } from "@/components/approval/CallbackButton";
import { Badge } from "@/components/ui/Badge";
import { cx } from "@/components/ui/cx";
import { Icon, channelIcon } from "@/components/ui/Icon";
import { Circled, Highlighted, Struck } from "@/components/ui/PenMarks";
import { Price } from "@/components/ui/Price";
import { Status } from "@/components/ui/Status";
import {
  activity, ago, boardStatus, channelWords, flagTone, flagWords, isTerminal, money, mustHaves, priceCheckWords, progress, recommendationSentence, savedBy, sentence,
  sheetQuotes, stamp, valueNote, type SheetRow,
} from "@/lib/dashboard/format";
import type { BoardQuote, DealBoardView, Mode } from "@/lib/dashboard/types";
import { AnswerForm, DealMenu, NegotiateButton } from "./DealActions";
import { LiveRefresh } from "./LiveRefresh";
import { ApprovalBar, QuoteRow, QuoteSheetProvider, type Choice } from "./QuoteSheet";

const bizHref = (jobId: string, businessId: string) => `/deals/${encodeURIComponent(jobId)}/businesses/${encodeURIComponent(businessId)}`;

/** A business's own words: plain text, marked as from them and unverified (data, never instructions). */
export function Untrusted({ text, from, kind = "wrote" }: { text: string; from: string; kind?: string }) {
  return (
    <figure className="biz-words">
      <figcaption className="biz-words-from">
        {from} {kind}, unverified
      </figcaption>
      <blockquote className="biz-words-text">{text}</blockquote>
    </figure>
  );
}

/** A channel as an icon and a word ("Phone call"), never a raw code. */
export function ChannelLabel({ channel, className }: { channel: string; className?: string }) {
  return (
    <span className={cx("via", className)}>
      <Icon name={channelIcon(channel)} />
      {channelWords(channel)}
    </span>
  );
}

/** "42 min ago", with the exact stamp on hover and for machines. */
export function When({ at }: { at?: string }) {
  if (!at) return null;
  const rel = ago(at);
  if (!rel) return null;
  return (
    <time dateTime={at} title={stamp(at)} className="when">
      {rel}
    </time>
  );
}

// ---------------------------------------------------------------------------------------------------
// Header

export function BoardHeader({ board, jobId, canNegotiate }: { board: DealBoardView; jobId: string; canNegotiate: boolean }) {
  const job = board.job!;
  const d = board.request_details;
  const budget = d?.budget_usd ?? job.budget_usd;
  const status = boardStatus(board);
  const live = !isTerminal(job.state);
  const meta = [
    d?.headcount !== undefined ? `${d.headcount} people` : null,
    d?.when && d.when !== "not set" ? d.when : null,
    d?.place && d.place !== "not set" ? d.place : null,
    budget !== undefined && budget !== null ? `Budget ${money(budget)}` : null,
  ].filter((x): x is string => !!x);
  return (
    <header className="board-head">
      <Link className="board-back" href="/deals">
        All deals
      </Link>
      <div className="board-title-row">
        <h1 id="deal-h" className="board-title">
          {sentence(d?.what ?? job.request)}
        </h1>
        {board.mode === "mock" ? <Badge title="Simulated businesses; nothing real is contacted or paid." /> : null}
        <div className="board-actions">
          {canNegotiate ? <NegotiateButton jobId={jobId} /> : null}
          <DealMenu jobId={jobId} canCancel={live} />
        </div>
      </div>
      {meta.length ? (
        <ul className="board-meta" aria-label="The request">
          {meta.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
      <div className="board-status">
        <Status tone={status.tone}>{status.words}</Status>
        {live ? <LiveRefresh jobId={jobId} /> : null}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------------------------------
// Questions from businesses

export function NeedsAnswer({ board, jobId }: { board: DealBoardView; jobId: string }) {
  // A finished or stopped deal has nothing left to answer.
  if (!board.open_questions.length || isTerminal(board.job?.state ?? "")) return null;
  return (
    <section className="needs" aria-labelledby="needs-h">
      <h2 id="needs-h" className="needs-h">
        <Status tone="hold">Needs your answer</Status>
      </h2>
      <ul className="needs-list">
        {board.open_questions.map((q) => (
          <li key={q.question_id} className="needs-item">
            <div className="needs-who">
              <Link href={bizHref(jobId, q.business_id)} className="needs-biz">
                {q.business}
              </Link>
              <span className="hint">asked before quoting</span>
              <When at={q.asked_at} />
            </div>
            <Untrusted text={q.text} from={q.business} kind="asked" />
            <AnswerForm jobId={jobId} questionId={q.question_id} business={q.business} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// The quote sheet

const PRICE_CHECK_TONE: Record<string, string> = { good: "pc-good", typical: "pc-typical", high: "pc-high", too_low: "pc-low" };
const SOURCE_WORDS: [RegExp, string][] = [
  [/transcript|call/i, "the call transcript"],
  [/pdf/i, "a PDF quote"],
  [/a2a|agent/i, "its booking agent"],
  [/imessage|text|sms/i, "a text message"],
  [/email/i, "the email"],
];
const sourceWords = (s: string) => SOURCE_WORDS.find(([re]) => re.test(s))?.[1] ?? s;

function MustHaveLine({ q, board }: { q: BoardQuote; board: DealBoardView }) {
  const m = mustHaves(q, board);
  if (!m || !m.total) return null;
  if (m.met === m.total && !m.unconfirmed.length) {
    return (
      <span className="must must-ok">
        <Icon name="check" />
        {m.met} of {m.total} must-haves
      </span>
    );
  }
  if (m.met === null) {
    return (
      <span className="must must-miss">
        <Icon name="x" />
        Misses a must-have
      </span>
    );
  }
  return (
    <span className={cx("must", m.unmet.length ? "must-miss" : "must-unsure")}>
      <Icon name={m.unmet.length ? "x" : "clock"} />
      {m.met} of {m.total} must-haves
    </span>
  );
}

function RowSummary({ row, board }: { row: SheetRow; board: DealBoardView }) {
  const q = row.quote;
  const m = mustHaves(q, board);
  const why = row.rank === "recommended" ? recommendationSentence(board) : null;
  const risks = q.flags.filter((f) => flagTone(f) === "risk" && f !== "requirement_unmet");
  const rejected = board.rejected?.find((r) => r.quote_id === q.quote_id);
  return (
    <div className="qrow-summary">
      <p className="qrow-meta">
        <ChannelLabel channel={q.channel} />
        <MustHaveLine q={q} board={board} />
        {q.price_check ? <span className={cx("pc", PRICE_CHECK_TONE[q.price_check])}>{priceCheckWords(q.price_check)}</span> : null}
      </p>
      {m?.unmet.length ? <p className="qrow-note qrow-miss">Misses: {m.unmet.join("; ")}</p> : null}
      {m?.unconfirmed.length ? <p className="qrow-note qrow-unsure">Not confirmed: {m.unconfirmed.join("; ")}</p> : null}
      {m?.other.length ? <p className="qrow-note qrow-unsure">{m.other.join("; ")}</p> : null}
      {risks.length ? <p className="qrow-note qrow-miss">{sentence(risks.map(flagWords).join(", "))}</p> : null}
      {rejected ? <p className="qrow-note qrow-miss">Can&apos;t win: {rejected.detail}</p> : q.excluded_reason && row.rank === "excluded" ? <p className="qrow-note qrow-miss">Can&apos;t win: {q.excluded_reason.replace(/_/g, " ")}</p> : null}
      {why ? (
        <p className="qrow-why">
          <strong>Recommended.</strong> {why}
        </p>
      ) : null}
    </div>
  );
}

function RowPrice({ row, board }: { row: SheetRow; board: DealBoardView }) {
  const q = row.quote;
  if (q.total_usd === null) return <span className="qp-none">Total not stated</span>;
  const saved = savedBy(q);
  const approx = board.quote_status?.[q.quote_id]?.approximate;
  const perWord = board.request_details?.headcount !== undefined ? "a person" : "each";
  const total = <Price amount={q.total_usd} size="l" />;
  const sub = [
    q.per_unit_usd !== undefined ? `${money(q.per_unit_usd)} ${perWord}` : null,
    q.deposit_usd !== undefined && q.deposit_usd > 0 ? `${money(q.deposit_usd)} deposit` : null,
  ].filter(Boolean);
  return (
    <>
      <span className="qp-total">
        {saved !== null && q.negotiated_from !== undefined ? (
          <Struck className="qp-was">
            <Price amount={q.negotiated_from} size="s" />
          </Struck>
        ) : null}
        {approx ? <span className="qp-approx">about</span> : null}
        {row.rank === "recommended" ? <Circled>{total}</Circled> : total}
      </span>
      {sub.length ? <span className="qp-sub">{sub.join(", ")}</span> : null}
      {saved !== null ? (
        <span className="qp-saved">
          <Highlighted>
            <Price amount={saved} sign="-" size="s" />
          </Highlighted>{" "}
          negotiated
        </span>
      ) : null}
    </>
  );
}

function RowDetails({ row, board, jobId }: { row: SheetRow; board: DealBoardView; jobId: string }) {
  const q = row.quote;
  const status = board.quote_status?.[q.quote_id];
  const compliance = board.compliance?.[q.quote_id];
  const fresh = board.freshness?.[q.quote_id];
  const terms = board.terms?.[q.quote_id];
  const biz = board.businesses.find((b) => b.id === q.business_id);
  const others = board.value?.explanation?.others.find((o) => o.quote_id === q.quote_id);
  const warnFlags = q.flags.filter((f) => flagTone(f) !== "risk");
  const facts: [string, ReactNode][] = [];
  if (q.deposit_usd !== undefined) facts.push(["Deposit", money(q.deposit_usd)]);
  else facts.push(["Deposit", "None stated"]);
  if (q.delivery_usd !== undefined) facts.push(["Delivery", money(q.delivery_usd)]);
  if (q.tax_usd !== undefined) facts.push(["Tax", money(q.tax_usd)]);
  if (q.valid_until) facts.push(["Valid until", stamp(q.valid_until)]);
  for (const a of board.job?.ask ?? []) {
    const v = q.fields?.[a.key];
    if (v === undefined) continue;
    facts.push([a.label, v === null ? "Not stated" : typeof v === "number" && a.type === "money" ? money(v) : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)]);
  }
  if (terms?.deposit_terms) facts.push(["Deposit terms", terms.deposit_terms]);
  if (terms?.fees?.length) {
    facts.push(["Fees", terms.fees.map((f) => `${f.label}${f.amount_usd !== undefined ? ` ${money(f.amount_usd)}` : ""}${f.included === true ? " (included)" : f.included === false ? " (extra)" : ""}`).join("; ")]);
  }
  if (terms?.cancellation) facts.push(["Cancellation", terms.cancellation]);
  if (terms?.exclusions?.length) facts.push(["Not included", terms.exclusions.join("; ")]);
  facts.push(["Read from", `${sentence(sourceWords(q.source))}, ${Math.round(q.confidence * 100)}% confidence${q.round > 1 ? `, round ${q.round}` : ""}`]);
  return (
    <div className="qd">
      {q.items.length ? (
        <ul className="qd-items" aria-label="What's included">
          {q.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      ) : null}
      <dl className="qd-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {(() => {
        const notes = [
          ...(compliance?.assumed?.length ? [`Taken from your request, not stated by ${q.business}: ${compliance.assumed.join("; ")}.`] : []),
          ...(q.missing_fields?.length ? [`Still missing: ${q.missing_fields.join(", ")}.`] : []),
          ...(warnFlags.length ? [sentence(warnFlags.map(flagWords).join(", ")) + "."] : []),
          ...(status?.price_note && status.block?.code !== "price_implausible" ? [status.price_note] : []),
          ...(status?.block ? [`Can't be approved yet: ${status.block.reason}`] : []),
          ...(fresh?.stale ? [`This quote is stale${fresh.reconfirmation ? "; Haggle is re-confirming it with the business" : ""}.`] : []),
          ...(others ? [valueNote(others.text)] : []),
          ...(row.rank === "recommended" && board.value?.explanation?.winner ? [valueNote(board.value.explanation.winner)] : []),
        ];
        return notes.length ? (
          <ul className="qd-notes">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null;
      })()}
      {biz?.transcript_snippet ? <Untrusted text={biz.transcript_snippet} from={q.business} kind={biz.channel === "phone" ? "said on the call" : "wrote"} /> : null}
      <Link className="qd-link" href={bizHref(jobId, q.business_id)}>
        Conversation with {q.business}
        <Icon name="chevron-right" />
      </Link>
    </div>
  );
}

function Row({ row, board, jobId, dim, choosable }: { row: SheetRow; board: DealBoardView; jobId: string; dim?: boolean; choosable: boolean }) {
  return (
    <QuoteRow
      quoteId={row.quote.quote_id}
      business={row.quote.business}
      choosable={choosable}
      recommended={row.rank === "recommended"}
      dim={dim}
      summary={<RowSummary row={row} board={board} />}
      price={<RowPrice row={row} board={board} />}
      details={<RowDetails row={row} board={board} jobId={jobId} />}
    />
  );
}

/** The businesses still working on a quote, shaped like rows so the sheet doesn't jump when one lands. */
function Waiting({ board }: { board: DealBoardView }) {
  const quoted = new Set(board.quotes.map((q) => q.business_id));
  const waiting = board.businesses.filter((b) => !quoted.has(b.id) && !["declined", "unavailable"].includes(b.status));
  if (!waiting.length || isTerminal(board.job?.state ?? "")) return null;
  return (
    <ul className="qwait" aria-label="Still waiting for">
      {waiting.map((b) => {
        const calling = b.status === "on_call" || b.status === "ringing";
        return (
          <li key={b.id} className="qwait-row">
            <span className="qwait-name">{b.name}</span>
            <ChannelLabel channel={b.channel} />
            <span className="qwait-state">
              {calling ? <CallBars /> : null}
              {calling ? (b.status === "on_call" ? "On the call now" : "Ringing") : board.open_questions.some((x) => x.business_id === b.id) ? "Waiting for your answer" : "Waiting for a quote"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The quote sheet and the approval bar docked under it. The provider wraps the rest of the main column
 * (children) so the bar can sit between the sheet and the activity.
 */
export function QuoteSheet({ board, jobId, mode, children }: { board: DealBoardView; jobId: string; mode: Mode; children?: ReactNode }) {
  const { rows, excluded, older } = sheetQuotes(board);
  const state = board.job?.state ?? "";
  const stopped = state === "cancelled" || state === "failed";
  // A finished deal (paid, confirmed) offers only the quote it was settled on; a stopped one offers none.
  const finished = isTerminal(state) && !stopped;
  const choosable = (r: SheetRow) => !stopped && r.selectable && r.quote.total_usd !== null && (!finished || r.quote.quote_id === board.approval?.quote_id);
  const choices: Choice[] = stopped
    ? []
    : [...rows, ...excluded]
        .filter(choosable)
        .map((r) => ({
          quoteId: r.quote.quote_id,
          business: r.quote.business,
          totalUsd: r.quote.total_usd as number,
          depositUsd: r.quote.deposit_usd ?? null,
          status: board.approval && board.approval.quote_id === r.quote.quote_id ? board.approval.status : null,
        }));
  const approvedId = board.approval && ["approved", "used"].includes(board.approval.status) ? board.approval.quote_id : undefined;
  const recommended = board.recommended_quote_id ?? null;
  const approvalQuote = board.approval?.quote_id;
  const initial = approvalQuote && choices.some((c) => c.quoteId === approvalQuote) ? approvalQuote : recommended && choices.some((c) => c.quoteId === recommended) ? recommended : null;
  const noRecNote = board.recommendation_note && !recommended ? board.recommendation_note : null;
  return (
    <QuoteSheetProvider initial={initial} ids={board.quotes.map((q) => q.quote_id)} recommended={recommended}>
      <section className="sheet" aria-labelledby="quotes-h">
        <div className="sheet-head">
          <h2 id="quotes-h" className="sheet-title">
            Quotes
          </h2>
          {rows.length > 1 ? <span className="sheet-order">Lowest total first</span> : null}
          {board.ready && !approvedId && !isTerminal(state) && state !== "paying" ? (
            <Status tone="ok" className="sheet-final">
              Ready to approve
            </Status>
          ) : null}
        </div>
        {noRecNote ? <p className="sheet-note">{sentence(noRecNote)}</p> : null}
        {rows.length ? (
          <ol className="qlist" aria-label="Quotes, lowest total first">
            {rows.map((r) => (
              <Row key={r.quote.quote_id} row={r} board={board} jobId={jobId} dim={stopped} choosable={choosable(r) && !finished} />
            ))}
          </ol>
        ) : (
          <p className="sheet-empty">{stopped ? "No quotes came in before the deal stopped." : "No quotes yet. They appear here as businesses reply."}</p>
        )}
        <Waiting board={board} />
        {excluded.length ? (
          <div className="sheet-out">
            <h3 className="sheet-out-h">Can&apos;t win</h3>
            <ol className="qlist">
              {excluded.map((r) => (
                <Row key={r.quote.quote_id} row={r} board={board} jobId={jobId} dim choosable={choosable(r) && !finished} />
              ))}
            </ol>
          </div>
        ) : null}
        {older.length ? (
          <details className="sheet-older">
            <summary>
              Earlier quotes <span className="hint">{older.length}</span>
            </summary>
            <ul>
              {older.map((q) => (
                <li key={q.quote_id}>
                  <span>{q.business}</span>
                  <span className="hint">round {q.round}, replaced by a newer quote</span>
                  <Price amount={q.total_usd} size="s" />
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
      <ApprovalBar jobId={jobId} choices={choices} mode={mode} />
      {children}
    </QuoteSheetProvider>
  );
}

// ---------------------------------------------------------------------------------------------------
// Activity

/** The one ambient motion in the app: three bars while a call is ringing or in progress. */
export function CallBars() {
  return (
    <span className="callbars" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function Activity({ board, jobId }: { board: DealBoardView; jobId: string }) {
  const items = activity(board);
  if (!items.length) return null;
  return (
    <section className="activity" aria-labelledby="act-h">
      <h2 id="act-h" className="section-h">
        Activity
      </h2>
      <ol className="act-list">
        {items.map((a) => (
          <li key={a.business_id}>
            <Link href={bizHref(jobId, a.business_id)} className={cx("act-row", `act-${a.tone}`)}>
              <span className="act-icon" aria-hidden="true">
                <Icon name={channelIcon(a.channel)} />
              </span>
              <span className="act-body">
                <span className="act-text">
                  {a.text}
                  {a.live ? <CallBars /> : null}
                </span>
                {a.detail ? <span className="act-detail">{a.detail}</span> : null}
              </span>
              <When at={a.at} />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------
// Side column

export function RequestAside({ board }: { board: DealBoardView }) {
  const job = board.job!;
  const d = board.request_details;
  const budget = d?.budget_usd ?? job.budget_usd;
  const current = board.quotes.filter((q) => q.total_usd !== null && (!q.status || q.status === "current"));
  const metAll = current.filter((q) => {
    const m = mustHaves(q, board);
    return m && m.met === m.total && !m.unconfirmed.length;
  }).length;
  const steps = progress(board);
  const facts: [string, ReactNode][] = [];
  if (d?.headcount !== undefined) facts.push(["For", `${d.headcount} people`]);
  facts.push(["When", d?.when ?? "Not set"]);
  facts.push(["Where", d?.place ?? "Not set"]);
  facts.push([
    "Budget",
    <>
      {budget !== undefined && budget !== null ? money(budget) : "None set"}
      {d?.budget_source === "settings_default" ? <span className="hint"> (your default)</span> : null}
    </>,
  ]);
  if (board.payment_ceiling_usd !== undefined) facts.push(["Spending cap", money(board.payment_ceiling_usd)]);
  return (
    <aside className="board-aside" aria-label="The request">
      <section aria-labelledby="req-h">
        <h2 id="req-h" className="aside-h">
          Request
        </h2>
        <dl className="aside-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      {job.requirements.length ? (
        <section aria-labelledby="must-h">
          <h2 id="must-h" className="aside-h">
            Must-haves
          </h2>
          <ul className="musts">
            {job.requirements.map((r) => (
              <li key={r}>{sentence(r)}</li>
            ))}
          </ul>
          {current.length ? (
            <p className="aside-note">
              {metAll === current.length ? `Every quote so far meets all of them.` : `${metAll} of ${current.length} quotes meet all of them.`}
            </p>
          ) : null}
        </section>
      ) : null}
      <section aria-labelledby="prog-h">
        <h2 id="prog-h" className="aside-h">
          Progress
        </h2>
        <ol className="prog">
          {steps.map((s) => (
            <li key={s.key} data-status={s.status} aria-current={s.status === "current" ? "step" : undefined}>
              {s.label}
              <span className="sr-only">{s.status === "done" ? " (done)" : s.status === "current" ? " (now)" : ""}</span>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------------
// Callbacks, purchase, setup notes

export function Callbacks({ board, jobId }: { board: DealBoardView; jobId: string }) {
  const rows = board.callbacks ?? [];
  if (!rows.length || isTerminal(board.job?.state ?? "")) return null;
  return (
    <section className="callbacks" aria-labelledby="cb-h">
      <h2 id="cb-h" className="section-h">
        Callbacks Haggle suggests
      </h2>
      <p className="hint">A short Voice AI call asking a business to match a real lower quote. Nothing is placed without your go-ahead.</p>
      <ul className="cb-list">
        {rows.map((c) => (
          <li key={c.business_id} className="cb-row">
            <p>
              <strong>{c.business}</strong> quoted <span className="num">{money(c.their_total_usd)}</span>; {c.basis_business} quoted{" "}
              <span className="num">{money(c.basis_total_usd)}</span>. <span className="hint">{c.why}</span>
            </p>
            <CallbackButton jobId={jobId} businessId={c.business_id} business={c.business} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The purchase as the board reports it, when the approval bar isn't already showing it. */
export function PurchaseStatus({ board }: { board: DealBoardView }) {
  const p = board.purchase;
  const pay = board.payment;
  if (!p && !pay) return null;
  const who = board.quotes.find((q) => q.quote_id === board.approval?.quote_id)?.business ?? "The business";
  return (
    <section className="purchase" aria-labelledby="buy-h">
      <h2 id="buy-h" className="section-h">
        Purchase
      </h2>
      {p ? (
        <>
          <p className="purchase-summary">
            <Status tone={p.money_verified ? "ok" : "hold"}>{sentence(p.stage.replace(/_/g, " "))}</Status>
            {p.confirm_only ? <span className="hint">Confirm only, nothing paid through Haggle</span> : null}
          </p>
          <p>{p.summary}</p>
          {p.order ? <p className="hint">Order: {p.order}</p> : null}
          {p.vendor_reply ? <Untrusted text={p.vendor_reply.text} from={who} /> : null}
          {p.instructions ? (
            <>
              <Untrusted text={p.instructions.text} from={who} kind="sent payment instructions" />
              {p.instructions.has_link ? (
                <p className="note note-risk">These instructions contain a link. Haggle never opens payment links; don&apos;t pay through one you didn&apos;t expect.</p>
              ) : null}
            </>
          ) : null}
          <p className="hint">Next: {p.next}</p>
        </>
      ) : null}
      {pay ? (
        <p className="purchase-pay">
          <Status tone={pay.status === "paid" || pay.status === "settled" ? "ok" : "hold"}>
            Payment {pay.status}
            {pay.simulated ? " (simulated)" : ""}
          </Status>
          {pay.receipt_url && /^https:\/\//.test(pay.receipt_url) ? (
            <a href={pay.receipt_url} target="_blank" rel="noopener noreferrer">
              Receipt
            </a>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

export function SetupNotes({ board }: { board: DealBoardView }) {
  const blockers = board.setup?.blockers ?? [];
  const notContacted = board.not_contacted ?? [];
  const warnings = board.warnings ?? [];
  if (!blockers.length && !notContacted.length && !warnings.length) return null;
  return (
    <section className="setup-notes" aria-label="Notes">
      <ul>
        {warnings.map((w, i) => (
          <li key={`w${i}`}>{w}</li>
        ))}
        {notContacted.map((n, i) => (
          <li key={`n${i}`}>
            Not contacted: <strong>{n.business}</strong> by {channelWords(n.channel).toLowerCase()}. {sentence(n.reason)}
          </li>
        ))}
        {blockers.map((b, i) => (
          <li key={`b${i}`}>
            Can&apos;t reach <strong>{b.vendor}</strong> by {channelWords(b.channel).toLowerCase()}: {b.reason} <span className="fix">{b.fix}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
