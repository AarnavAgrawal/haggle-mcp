"use client";
// The human's approve-then-pay panel for one quote (CLAUDE.md §7: only a signed-in human's click
// approves or pays). Approve records the yes (nothing is charged); Pay charges what was approved: the
// deposit, or the full total when the business stated no deposit. One-time codes never reach the
// browser: the server holds them and spends them on this click.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postAction, usd, type ApiError } from "./post";
import "./approval.css";

export interface ApprovalPanelProps {
  jobId: string;
  quoteId: string;
  business: string;
  amountUsd: number;
  depositUsd: number | null;
  status: string | null;
  mode: "mock" | "live";
}

type Phase = "idle" | "approving" | "approved" | "paying" | "paid" | "pending_text" | "confirmed" | "refused";
type ApproveAnswer = { status: "approved" | "confirmed" | "paid" | "refused" | "pending_text"; amount_usd?: number; reason?: string; next: string };
type PayAnswer = { status: "pending_human" | "approved" | "paid" | "refused" | "confirmed"; amount_usd: number; receipt_url?: string; simulated?: boolean; reason?: string; next: string };

/** Where a deal's approval already stands (from the board) as the panel's starting phase. */
function initialPhase(status: string | null): Phase {
  switch (status) {
    case "approved":
    case "used":
      return "approved";
    case "paid":
    case "settled":
      return "paid";
    case "confirmed":
      return "confirmed";
    default:
      return "idle";
  }
}

export function ApprovalPanel({ jobId, quoteId, business, amountUsd, depositUsd, status, mode }: ApprovalPanelProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(() => initialPhase(status));
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(status === "pending" || status === "pending_human" ? "An approval is already waiting for this quote." : null);
  const [paid, setPaid] = useState<{ amount: number; receipt?: string; simulated?: boolean } | null>(null);
  const busy = useRef(false); // a second click before React re-renders can't send a second request

  const hasDeposit = depositUsd !== null && depositUsd > 0 && depositUsd < amountUsd;
  const payNow = hasDeposit ? depositUsd : amountUsd;
  const base = `/api/deals/${encodeURIComponent(jobId)}`;

  async function approve() {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setPhase("approving");
    const r = await postAction<ApproveAnswer>(`${base}/approve`, { quote_id: quoteId });
    busy.current = false;
    if (!r.ok) {
      setError(r.error);
      setPhase("idle");
      return;
    }
    setNote(r.status === "refused" ? (r.reason ?? r.next) : r.status === "pending_text" ? r.next : null);
    setPhase(r.status === "refused" ? "idle" : r.status);
    router.refresh();
  }

  async function pay() {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setPhase("paying");
    const r = await postAction<PayAnswer>(`${base}/pay`, { quote_id: quoteId });
    busy.current = false;
    if (!r.ok) {
      setError(r.error);
      setPhase("approved");
      return;
    }
    if (r.status === "paid") {
      setPaid({ amount: r.amount_usd || payNow, ...(r.receipt_url ? { receipt: r.receipt_url } : {}), ...(r.simulated !== undefined ? { simulated: r.simulated } : {}) });
      setNote(null);
      setPhase("paid");
    } else if (r.status === "pending_human") {
      setNote(r.next || "Your approval isn't recorded yet.");
      setPhase("idle");
    } else if (r.status === "refused") {
      setNote(r.reason ? `Payment refused: ${r.reason}` : "Payment refused.");
      setPhase("approved");
    } else {
      setNote(r.next || "The payment is in progress.");
      setPhase(r.status === "confirmed" ? "confirmed" : "approved");
    }
    router.refresh();
  }

  return (
    <section className="card ap-panel" aria-labelledby={`ap-${quoteId}`}>
      <div className="ap-head">
        <h3 id={`ap-${quoteId}`}>Approve {business}</h3>
        {mode === "mock" && <span className="chip demo">DEMO</span>}
      </div>

      <dl className="ap-amounts">
        <div>
          <dt>Pay now</dt>
          <dd className="ap-big">{usd(payNow)}</dd>
          <dd className="muted">{hasDeposit ? "deposit" : "full total (no deposit stated)"}</dd>
        </div>
        {hasDeposit && (
          <div>
            <dt>Order total</dt>
            <dd>{usd(amountUsd)}</dd>
          </div>
        )}
        <div>
          <dt>Paid to</dt>
          <dd>{business}</dd>
        </div>
      </dl>

      {mode === "mock" && <p className="note ap-demo">DEMO: simulated, no money moves.</p>}

      <div aria-live="polite" className="ap-status">
        {phase === "approved" && <p className="note ap-ok">Approved. Nothing is charged until you pay.</p>}
        {phase === "pending_text" && (
          <p className="note ap-wait">We texted your approver: reply YES with the code from that text.{note ? <span className="ap-sub">{note}</span> : null}</p>
        )}
        {phase === "confirmed" && <p className="note ap-ok">Order confirmed with {business}. Nothing is paid through Haggle.</p>}
        {phase === "paid" && (
          <p className="note ap-ok">
            Paid {usd(paid?.amount ?? payNow)} to {business}
            {paid?.simulated ? " (simulated)" : ""}.
            {paid?.receipt && (
              <>
                {" "}
                <a href={paid.receipt} target="_blank" rel="noopener noreferrer">
                  Receipt
                </a>
              </>
            )}
          </p>
        )}
        {note && phase !== "pending_text" && <p className="muted ap-sub">{note}</p>}
        {error && (
          <p className="note note-risk" role="alert">
            {error.message}
            {error.fix && <span className="ap-sub">{error.fix}</span>}
          </p>
        )}
      </div>

      <div className="ap-actions">
        {(phase === "idle" || phase === "approving") && (
          <button type="button" className="btn btn-primary" onClick={approve} disabled={phase === "approving"} aria-busy={phase === "approving"}>
            {phase === "approving" ? "Approving…" : `Approve ${usd(payNow)}`}
          </button>
        )}
        {(phase === "approved" || phase === "paying") && (
          <button type="button" className="btn btn-primary" onClick={pay} disabled={phase === "paying"} aria-busy={phase === "paying"}>
            {phase === "paying" ? "Paying…" : `Pay ${usd(payNow)}`}
          </button>
        )}
      </div>
    </section>
  );
}
