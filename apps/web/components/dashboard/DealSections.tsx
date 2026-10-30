// The deal page's sections (server components): timeline, businesses, quotes comparison, negotiation
// history, callbacks and purchase status. Business text is untrusted: rendered as plain text with a
// label, never as HTML, never as links.
import Link from "next/link";
import { ApprovalPanel } from "@/components/approval/ApprovalPanel";
import { CallbackButton } from "@/components/approval/CallbackButton";
import {
  businessStatusWords, channelWords, flagTone, flagWords, isApprovable, money, priceCheckWords, recommendationReason, sortQuotes,
  stamp, timeline, type QuoteRank,
} from "@/lib/dashboard/format";
import type { DealBoardView, Mode } from "@/lib/dashboard/types";

/** Business words as plain text, labelled. */
export function Untrusted({ text, label = "from the business, unverified" }: { text: string; label?: string }) {
  return (
    <div>
      <span className="untrusted-label">{label}</span>
      <p className="untrusted">{text}</p>
    </div>
  );
}

export function ChannelBadge({ channel }: { channel: string }) {
  return <span className="via">{channelWords(channel)}</span>;
}

export function Timeline({ state }: { state: string }) {
  const { steps, stopped } = timeline(state);
  return (
    <div className="stack">
      <ol className="timeline" aria-label="Deal progress">
        {steps.map((s) => (
          <li key={s.key} data-status={s.status} aria-current={s.status === "current" ? "step" : undefined}>
            {s.label}
            <span className="sr-only">{s.status === "done" ? " (done)" : s.status === "current" ? " (now)" : ""}</span>
          </li>
        ))}
      </ol>
      {stopped ? (
        <p className="note note-risk">
          This deal was {state === "cancelled" ? "cancelled" : "stopped"}.
        </p>
      ) : null}
    </div>
  );
}

const BUSINESS_TONE: Record<string, string> = { quoted: "chip-win", won: "chip-win", declined: "chip-risk", no_reply: "chip-warn", unavailable: "chip-warn" };

export function BusinessTable({ board, jobId }: { board: DealBoardView; jobId: string }) {
  if (!board.businesses.length) return <p className="muted">No businesses contacted yet.</p>;
  return (
    <table className="dash-table">
      <thead>
        <tr>
          <th scope="col">Business</th>
          <th scope="col">Channel</th>
          <th scope="col">Status</th>
          <th scope="col">Latest</th>
        </tr>
      </thead>
      <tbody>
        {board.businesses.map((b) => {
          const contact = board.vendor_contact?.[b.id];
          return (
            <tr key={b.id}>
              <td>
                <Link href={`/deals/${encodeURIComponent(jobId)}/businesses/${encodeURIComponent(b.id)}`}>
                  <strong>{b.name}</strong>
                </Link>
                {b.simulated ? <span className="chip demo">simulated</span> : null}
              </td>
              <td data-label="Channel">
                <ChannelBadge channel={b.channel} />
              </td>
              <td data-label="Status">
                <span className={`chip ${BUSINESS_TONE[b.status] ?? ""}`}>{businessStatusWords(b.status)}</span>
                {contact ? <div className="hint">{contact.status.replace(/_/g, " ")}{contact.detail ? `: ${contact.detail}` : ""}</div> : null}
              </td>
              <td data-label="Latest">
                <div>{b.last_event}</div>
                {b.last_event_at ? <div className="hint">{stamp(b.last_event_at)}</div> : null}
                {b.unavailable_reason ? <div className="hint">{b.unavailable_reason}</div> : null}
                {b.transcript_snippet ? <Untrusted text={b.transcript_snippet} label="call transcript, unverified" /> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const RANK_CHIP: Record<QuoteRank, { text: string; cls: string }> = {
  recommended: { text: "Recommended", cls: "chip-win" },
  eligible: { text: "Can approve", cls: "" },
  other: { text: "Not approvable yet", cls: "chip-warn" },
  excluded: { text: "Can't win", cls: "chip-risk" },
  old: { text: "Older version", cls: "chip-plain" },
};

export function QuoteList({ board, jobId, mode, live }: { board: DealBoardView; jobId: string; mode: Mode; live: boolean }) {
  const rows = sortQuotes(board);
  if (!rows.length) return <p className="quotes-empty">No quotes yet. They appear here as businesses reply.</p>;
  const why = recommendationReason(board);
  return (
    <ol className="quotes" aria-label="Quotes, best first">
      {rows.map(({ quote: q, rank }) => {
        const chip = RANK_CHIP[rank];
        const status = board.quote_status?.[q.quote_id];
        const rejected = board.rejected?.find((r) => r.quote_id === q.quote_id);
        const compliance = board.compliance?.[q.quote_id];
        const fresh = board.freshness?.[q.quote_id];
        const terms = board.terms?.[q.quote_id];
        const approval = board.approval && board.approval.quote_id === q.quote_id ? board.approval : null;
        const showPanel = live && q.total_usd !== null && (isApprovable(q, board) || approval !== null);
        return (
          <li key={q.quote_id} className={`quote ${rank === "recommended" ? "quote-recommended" : ""} ${rank === "excluded" || rank === "old" ? "quote-dim" : ""}`}>
            <div className="quote-top">
              <div className="quote-who">
                <strong>{q.business}</strong>
                <ChannelBadge channel={q.channel} />
                <span className={`chip ${chip.cls}`}>{chip.text}</span>
                {q.round > 1 ? <span className="chip chip-plain">round {q.round}</span> : null}
              </div>
              <div className="quote-amount">
                {q.negotiated_from !== undefined ? <span className="price-was quote-was">{money(q.negotiated_from)}</span> : null}
                {q.total_usd === null ? (
                  <span className="quote-total-none">Total not stated</span>
                ) : (
                  <span className="price quote-total">{`${status?.approximate ? "≈ " : ""}${money(q.total_usd)}`}</span>
                )}
                {q.negotiated_from !== undefined && q.total_usd !== null && q.negotiated_from > q.total_usd ? (
                  <span className="sticker" title="Saved by negotiating">
                    −{money(q.negotiated_from - q.total_usd)}
                  </span>
                ) : null}
              </div>
            </div>
            {rank === "recommended" && why ? <p className="quote-why">Why: {why.replace(/^(why )?recommended:\s*/i, "")}</p> : null}
            <dl className="dash-meta quote-facts">
              {q.per_unit_usd !== undefined ? (
                <div>
                  <dt>Per unit</dt>
                  <dd>{money(q.per_unit_usd)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Deposit</dt>
                <dd>{q.deposit_usd !== undefined ? money(q.deposit_usd) : "none stated"}</dd>
              </div>
              {q.delivery_usd !== undefined ? (
                <div>
                  <dt>Delivery</dt>
                  <dd>{money(q.delivery_usd)}</dd>
                </div>
              ) : null}
              {q.tax_usd !== undefined ? (
                <div>
                  <dt>Tax</dt>
                  <dd>{money(q.tax_usd)}</dd>
                </div>
              ) : null}
              {q.price_check ? (
                <div>
                  <dt>Price check</dt>
                  <dd>{priceCheckWords(q.price_check)}</dd>
                </div>
              ) : null}
              {q.valid_until ? (
                <div>
                  <dt>Valid until</dt>
                  <dd>{stamp(q.valid_until)}</dd>
                </div>
              ) : null}
            </dl>
            {q.flags.length ? (
              <div className="chips" aria-label="Flags">
                {q.flags.map((f) => (
                  <span key={f} className={`chip chip-${flagTone(f)}`}>
                    {flagWords(f)}
                  </span>
                ))}
              </div>
            ) : null}
            {q.items.length ? (
              <ul className="items">
                {q.items.map((it, i) => (
                  <li key={i}>{it}</li>
                ))}
              </ul>
            ) : null}
            {q.missing_fields?.length ? <p className="hint">Still missing: {q.missing_fields.join(", ")}</p> : null}
            {compliance && compliance.issues.length ? (
              <ul className="hint quote-notes">
                {compliance.issues.map((x) => (
                  <li key={x.code + x.text}>{x.text}</li>
                ))}
              </ul>
            ) : null}
            {compliance?.assumed?.length ? <p className="hint">Assumed: {compliance.assumed.join("; ")}</p> : null}
            {status?.block ? <p className="hint">Can't be approved yet: {status.block.reason}</p> : null}
            {rejected ? <p className="hint">Can't win: {rejected.detail}</p> : q.excluded_reason ? <p className="hint">Excluded: {q.excluded_reason.replace(/_/g, " ")}</p> : null}
            {fresh?.stale ? <p className="hint">This quote is stale{fresh.reconfirmation ? "; Haggle is re-confirming it with the business" : ""}.</p> : null}
            {terms?.fees?.length ? (
              <p className="hint">
                Fees: {terms.fees.map((f) => `${f.label}${f.amount_usd !== undefined ? ` ${money(f.amount_usd)}` : ""}${f.included === true ? " (included)" : f.included === false ? " (extra)" : ""}`).join("; ")}
              </p>
            ) : null}
            {terms?.cancellation ? <p className="hint">Cancellation: {terms.cancellation}</p> : null}
            {terms?.exclusions?.length ? <p className="hint">Not included: {terms.exclusions.join("; ")}</p> : null}
            <p className="hint quote-notes">
              Source: {q.source}, {Math.round(q.confidence * 100)}% confidence
            </p>
            {showPanel ? (
              <div className="quote-approve">
                <ApprovalPanel
                  jobId={jobId}
                  quoteId={q.quote_id}
                  business={q.business}
                  amountUsd={q.total_usd as number}
                  depositUsd={q.deposit_usd ?? null}
                  status={approval?.status ?? null}
                  mode={mode}
                />
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function NegotiationHistory({ board }: { board: DealBoardView }) {
  const rows = board.negotiation ?? [];
  if (!rows.length) return null;
  return (
    <section className="deal-section stack" aria-labelledby="neg-h">
      <h2 id="neg-h" className="dash-h2">
        Negotiation
      </h2>
      <table className="dash-table">
        <thead>
          <tr>
            <th scope="col">Business</th>
            <th scope="col">Round</th>
            <th scope="col">Asked</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n, i) => {
            const estimate = board.negotiation_estimates?.includes(n.basis_quote_id);
            return (
              <tr key={`${n.business_id}-${n.round}-${i}`}>
                <td>
                  <strong>{n.business}</strong>
                  {n.channel ? <span className="hint"> · {channelWords(n.channel)}</span> : null}
                </td>
                <td data-label="Round">{n.round}</td>
                <td data-label="Asked">
                  {n.from_total_usd !== undefined ? `${money(n.from_total_usd)} → ` : ""}match {estimate ? "about " : ""}
                  {money(n.target_total_usd)}
                </td>
                <td data-label="Outcome">
                  {n.outcome_total_usd !== null
                    ? money(n.outcome_total_usd)
                    : n.scheduled_for
                      ? `Call scheduled ${stamp(n.scheduled_for)}`
                      : "Waiting for an answer"}
                  {board.stages?.[n.business_id]?.saved_usd ? <div className="hint">saved {money(board.stages[n.business_id]!.saved_usd)}</div> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function Callbacks({ board, jobId }: { board: DealBoardView; jobId: string }) {
  const rows = board.callbacks ?? [];
  if (!rows.length) return null;
  return (
    <section className="deal-section stack" aria-labelledby="cb-h">
      <h2 id="cb-h" className="dash-h2">
        Callbacks Haggle suggests
      </h2>
      <p className="hint">
        A short Voice AI call asking a business to match a real lower quote. Nothing is placed without your go-ahead.
      </p>
      {rows.map((c) => (
        <div key={c.business_id} className="stack">
          <div>
            <strong>{c.business}</strong>: {money(c.their_total_usd)} vs {money(c.basis_total_usd)} from {c.basis_business}. <span className="muted">{c.why}</span>
          </div>
          <CallbackButton jobId={jobId} businessId={c.business_id} business={c.business} />
        </div>
      ))}
    </section>
  );
}

export function PurchaseStatus({ board }: { board: DealBoardView }) {
  const p = board.purchase;
  const pay = board.payment;
  if (!p && !pay) return null;
  return (
    <section className="deal-section stack card" aria-labelledby="buy-h">
      <h2 id="buy-h" className="dash-h2">
        Purchase
      </h2>
      {p ? (
        <>
          <div className="dash-row dash-wrap">
            <span className={`chip ${p.money_verified ? "chip-win" : ""}`}>{p.stage.replace(/_/g, " ")}</span>
            {p.confirm_only ? <span className="chip chip-plain">confirm only, nothing paid</span> : null}
          </div>
          <p>{p.summary}</p>
          {p.order ? <p className="hint">Order: {p.order}</p> : null}
          {p.vendor_reply ? <Untrusted text={p.vendor_reply.text} /> : null}
          {p.instructions ? (
            <>
              <Untrusted text={p.instructions.text} label="payment instructions from the business, unverified" />
              {p.instructions.has_link ? (
                <p className="note note-risk">
                  These instructions contain a link. Haggle never opens payment links; don't pay through one you didn't expect.
                </p>
              ) : null}
            </>
          ) : null}
          <p className="hint">Next: {p.next}</p>
        </>
      ) : null}
      {pay ? (
        <p>
          Payment: <strong>{pay.status}</strong>
          {pay.simulated ? " (simulated)" : ""}
          {pay.receipt_url && /^https:\/\//.test(pay.receipt_url) ? (
            <>
              {" · "}
              <a href={pay.receipt_url} target="_blank" rel="noopener noreferrer">
                Receipt
              </a>
            </>
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
    <section className="note stack" aria-label="Notes">
      {warnings.map((w, i) => (
        <div key={`w${i}`}>{w}</div>
      ))}
      {notContacted.map((n, i) => (
        <div key={`n${i}`}>
          Not contacted: <strong>{n.business}</strong> ({channelWords(n.channel)}): {n.reason}
        </div>
      ))}
      {blockers.map((b, i) => (
        <div key={`b${i}`}>
          Can't reach <strong>{b.vendor}</strong> by {channelWords(b.channel)}: {b.reason} <span className="fix">{b.fix}</span>
        </div>
      ))}
    </section>
  );
}
