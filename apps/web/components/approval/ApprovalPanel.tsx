"use client";
// The human's approval panel for one quote (CLAUDE.md §7: only a signed-in human's click approves or
// pays). Approve opens a confirm step showing exactly what the server opened (business, amount paid
// now, total, caveats); the human's confirm records the approval as theirs. Approving charges nothing.
// Then, on a server that charges (demo), Pay charges the approved amount; on the manual rail (live)
// the human pays the business directly and PurchaseSteps walks the stages. No code ever reaches the
// browser: there is none to send.
//
// On the deal board it is the approval bar (components/dashboard/QuoteSheet): one line with Approve,
// docked under the quote sheet; the confirm step opens in place. Once decided it undocks and sits in the
// page's flow (paid, or the manual rail's purchase steps).
import { startTransition, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { postAction, usd, type ApiError } from "./post";
import { PurchaseSteps } from "./PurchaseSteps";
import type { PurchaseOk } from "@/lib/approval/flow";
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

type Rail = "manual" | "charge";
type Phase = "checking" | "idle" | "previewing" | "confirming" | "deciding" | "approved" | "paying" | "paid" | "confirmed";
type Preview = { approval_id: string; status: string; action: "pay" | "confirm"; amount_usd: number; quote_total_usd: number; business: string; caveats: string[]; expires_at?: string; rail?: Rail; mode?: string };
type Decided = { status: "approved" | "declined" | "used"; changed: boolean; action: "pay" | "confirm"; amount_usd: number; rail?: Rail; stage?: string; summary?: string; next: string };
type PayAnswer = { status: "pending_human" | "approved" | "paid" | "refused" | "confirmed"; amount_usd: number; receipt_url?: string; simulated?: boolean; reason?: string; next: string };
type Purchase = Omit<PurchaseOk, "ok">;

const DECIDED = new Set(["approved", "used", "paid", "settled", "confirmed"]);

const expiresIn = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const min = Math.round((t - Date.now()) / 60_000);
  return min > 0 ? `${min} min` : null;
};

export function ApprovalPanel({ jobId, quoteId, business, amountUsd, depositUsd, status, mode }: ApprovalPanelProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(() => (status && DECIDED.has(status) ? "checking" : "idle"));
  const [rail, setRail] = useState<Rail | null>(null);
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(status === "pending" || status === "pending_human" ? "An approval is waiting for this quote: you can approve it here." : null);
  const [paid, setPaid] = useState<{ amount: number; receipt?: string; simulated?: boolean } | null>(null);
  const busy = useRef(false); // a second click before React re-renders can't send a second request
  // Re-read the board (and the shell rail) in a transition: the panel's own answer shows at once, the
  // page's sections catch up without a flash.
  const refresh = () => startTransition(() => router.refresh());
  // Keyboard focus follows the step: into the confirm when it opens, back to Approve on "Not now".
  const approveBtn = useRef<HTMLButtonElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const backToApprove = useRef(false);
  useEffect(() => {
    if (phase === "confirming") confirmBtn.current?.focus();
    if (phase === "idle" && backToApprove.current) {
      backToApprove.current = false;
      approveBtn.current?.focus();
    }
  }, [phase]);

  const hasDeposit = depositUsd !== null && depositUsd > 0 && depositUsd < amountUsd;
  const payNow = hasDeposit ? depositUsd : amountUsd;
  const base = `/api/deals/${encodeURIComponent(jobId)}`;

  // Already decided (page load or refresh): learn the rail and where the purchase stands.
  useEffect(() => {
    if (phase !== "checking") return;
    let gone = false;
    void (async () => {
      type Answer = ({ ok: true } & Purchase) | { ok: false };
      const p: Answer | null = await fetch(`${base}/purchase`, { cache: "no-store", redirect: "manual" })
        .then((res) => res.json() as Promise<Answer>)
        .catch(() => null);
      if (gone) return;
      if (p?.ok && p.rail === "manual") {
        const { ok: _ok, ...rest } = p;
        setRail("manual");
        setPurchase(rest);
        setPhase(rest.confirm_only ? "confirmed" : "approved");
      } else if (p?.ok && p.payment?.status === "settled") {
        setRail("charge");
        setPaid({ amount: payNow, ...(p.payment.receipt_url ? { receipt: p.payment.receipt_url } : {}), ...(p.payment.simulated !== undefined ? { simulated: p.payment.simulated } : {}) });
        setPhase("paid");
      } else {
        setRail(p?.ok ? (p.rail ?? "charge") : null);
        setPhase(status === "confirmed" ? "confirmed" : status === "paid" || status === "settled" ? "paid" : "approved");
      }
    })();
    return () => {
      gone = true;
    };
  }, [phase, base, status, payNow]);

  async function startApprove() {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setPhase("previewing");
    const r = await postAction<Preview>(`${base}/approve`, { quote_id: quoteId });
    busy.current = false;
    if (!r.ok) {
      setError(r.error);
      setPhase("idle");
      return;
    }
    setRail(r.rail ?? null);
    if (r.status === "approved" || r.status === "used") {
      setNote("Already approved.");
      setPhase(r.action === "confirm" ? "confirmed" : "approved");
      refresh();
      return;
    }
    if (r.status !== "pending") {
      setNote(`That approval is ${r.status}. Try again.`);
      setPhase("idle");
      return;
    }
    setPreview(r);
    setNote(null);
    setPhase("confirming");
  }

  async function confirm() {
    if (busy.current || !preview) return;
    busy.current = true;
    setError(null);
    setPhase("deciding");
    const r = await postAction<Decided>(`${base}/approve`, { quote_id: quoteId, approval_id: preview.approval_id, decision: "approve" });
    busy.current = false;
    if (!r.ok) {
      setError(r.error);
      setPhase(r.error.code === "approval_expired" ? "idle" : "confirming");
      if (r.error.code === "approval_expired") setPreview(null);
      return;
    }
    if (r.status === "declined") {
      setNote("This approval was declined.");
      setPhase("idle");
      return;
    }
    setRail(r.rail ?? rail);
    setNote(r.changed ? null : "Already approved.");
    setPhase(r.action === "confirm" ? "confirmed" : "approved");
    refresh();
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
    refresh();
  }

  const shownNow = preview?.amount_usd ?? payNow;
  const manual = rail === "manual";
  const caveats = preview?.caveats ?? [];
  const expires = expiresIn(preview?.expires_at);
  const asking = phase === "idle" || phase === "previewing" || phase === "confirming" || phase === "deciding";
  // Docked (sticky under the sheet) while there's a decision or a payment to make; in the page's flow
  // once it's settled or the purchase steps take over.
  const docked = asking || (!manual && (phase === "approved" || phase === "paying"));
  const done = phase === "paid" || phase === "confirmed";
  const heading = asking ? `Approve ${business}` : done ? business : phase === "checking" ? business : `${business}, approved`;

  return (
    <section className={`ap-bar${docked ? " ap-docked" : ""}${done ? " ap-done" : ""}`} data-phase={phase} aria-labelledby={`ap-${quoteId}`}>
      <div className="ap-line" hidden={(phase === "confirming" || phase === "deciding") && !!preview}>
        <div className="ap-what">
          <h3 id={`ap-${quoteId}`} className="ap-title">
            {done ? <Icon name="check" className="ap-check" /> : null}
            {heading}
          </h3>
          <p className="ap-terms">
            {hasDeposit ? (
              <>
                <span className="num">{usd(payNow)}</span> deposit {phase === "paid" ? "paid" : manual ? "to them" : "now"}, <span className="num">{usd(amountUsd)}</span> total
              </>
            ) : (
              <>
                <span className="num">{usd(amountUsd)}</span> {phase === "paid" ? "paid" : manual ? "paid to them" : "now"}, the full total (no deposit stated)
              </>
            )}
          </p>
        </div>
        <div className="ap-actions ap-line-actions">
          {(phase === "idle" || phase === "previewing") && (
            <Button ref={approveBtn} variant="primary" onClick={startApprove} pending={phase === "previewing"}>
              {`Approve ${usd(payNow)}`}
            </Button>
          )}
          {!manual && (phase === "approved" || phase === "paying") && (
            <Button variant="primary" onClick={pay} pending={phase === "paying"}>
              {`Pay ${usd(payNow)}`}
            </Button>
          )}
        </div>
      </div>

      {(phase === "confirming" || phase === "deciding") && preview && (
        <div className="ap-confirm" role="group" aria-label={`Confirm approval for ${preview.business}`}>
          <p className="ap-ask">Approve {preview.business}?</p>
          <dl className="ap-amounts">
            <div>
              <dt>{preview.action === "confirm" ? "Paid now" : manual ? "You pay them" : "Paid now"}</dt>
              <dd className="ap-big">{preview.action === "confirm" ? usd(0) : usd(shownNow)}</dd>
              {preview.action !== "confirm" && <dd className="ap-small">{shownNow < preview.quote_total_usd ? "deposit" : "full total"}</dd>}
            </div>
            <div>
              <dt>Order total</dt>
              <dd className="ap-mid">{usd(preview.quote_total_usd)}</dd>
            </div>
            <div>
              <dt>Paid to</dt>
              <dd className="ap-to">{preview.business}</dd>
            </div>
          </dl>
          {caveats.length > 0 && (
            <div>
              <p className="ap-sub ap-accepting">You&apos;re accepting:</p>
              <ul className="ap-caveats">
                {caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="ap-sub">
            {manual
              ? `Haggle asks ${preview.business} to confirm the booking first. You then pay them directly; Haggle never moves money.`
              : "Approving charges nothing. You pay with a separate click."}
            {expires ? ` This approval expires in ${expires}.` : ""}
            {mode === "mock" ? " Demo: simulated, no money moves." : ""}
          </p>
          <div className="ap-actions">
            <Button ref={confirmBtn} variant="primary" onClick={confirm} pending={phase === "deciding"}>
              {preview.action === "confirm" ? "Yes, confirm the order" : `Yes, approve ${usd(shownNow)}`}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                backToApprove.current = true;
                setPhase("idle");
              }}
              disabled={phase === "deciding"}
            >
              Not now
            </Button>
          </div>
        </div>
      )}

      <div aria-live="polite" className="ap-status">
        {phase === "checking" && <p className="ap-sub">Checking where this purchase stands…</p>}
        {phase === "approved" && !manual && <p className="ap-ok">Approved. Nothing is charged until you pay.</p>}
        {phase === "approved" && manual && !purchase && <p className="ap-ok">Approved. Haggle asked {business} to confirm the booking; don&apos;t pay yet.</p>}
        {phase === "confirmed" && !manual && <p className="ap-ok">Order confirmed with {business}. Nothing is paid through Haggle.</p>}
        {phase === "paid" && (
          <p className="ap-ok">
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
        {note && <p className="ap-sub">{note}</p>}
        {error && (
          <p className="note note-risk" role="alert">
            {error.message}
            {error.fix && <span className="ap-sub"> {error.fix}</span>}
          </p>
        )}
      </div>

      {manual && (phase === "approved" || phase === "confirmed") && <PurchaseSteps jobId={jobId} business={business} initial={purchase} />}
    </section>
  );
}
