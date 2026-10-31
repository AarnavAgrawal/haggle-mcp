"use client";
// After approval on the manual rail (Haggle moves no money): the purchase stages from the board, with
// the human's own steps as buttons. Waiting for the vendor's written confirmation → its payment
// instructions, shown as untrusted plain text to verify before paying → "I've paid the vendor" →
// waiting for the vendor to confirm receipt → done. The server decides every step; this only asks.
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { postAction, usd, type ApiError } from "./post";
import type { PurchaseOk } from "@/lib/approval/flow";
import "./approval.css";

type Purchase = Omit<PurchaseOk, "ok">;
type Step = "booking" | "instructions" | "pay" | "receipt" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "booking", label: "Vendor confirms the booking in writing" },
  { key: "instructions", label: "Vendor sends how to pay" },
  { key: "pay", label: "You pay the vendor directly" },
  { key: "receipt", label: "Vendor confirms it received the money" },
  { key: "done", label: "Done" },
];
const STEP_OF: Record<string, Step> = {
  awaiting_vendor_confirmation: "booking", instructions_requested: "instructions", instructions_received: "pay", human_reported_paid: "receipt", settled_verified: "done",
};
/** Stages that end the flow (no more polling). */
const SETTLED = new Set(["settled_verified", "cancelled", "booking_declined", "booking_changed", "order_confirmed", "cancel_requested_after_payment"]);
const POLL_MS = 15_000;

type Confirming = null | "paid" | "booked" | "cancel";
type ActionAnswer = { action: string; outcome?: string; state?: string; stage?: string; summary?: string; note?: string; next: string };

/** The business's own words: plain text, labelled, never a link. */
function VendorWords({ text, label, hasLink }: { text: string; label: string; hasLink: boolean }) {
  return (
    <div className="ap-untrusted-box">
      <span className="ap-untrusted-label">{label}</span>
      <p className="ap-untrusted">{text}</p>
      {hasLink && <p className="note note-risk">This contains a link. Haggle never opens payment links; don&apos;t pay through a link you didn&apos;t expect.</p>}
    </div>
  );
}

export function PurchaseSteps({ jobId, business, initial }: { jobId: string; business: string; initial?: Purchase | null }) {
  const router = useRouter();
  const [p, setP] = useState<Purchase | null>(initial ?? null);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const url = `/api/deals/${encodeURIComponent(jobId)}/purchase`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: "no-store", redirect: "manual" });
      const body = (await res.json()) as ({ ok: true } & Purchase) | { ok: false; error: ApiError };
      if (body.ok) {
        const { ok: _ok, ...rest } = body;
        setP(rest);
      } else setError(body.error);
    } catch {
      /* a missed refresh: the next poll retries */
    }
  }, [url]);

  const settled = p?.stage ? SETTLED.has(p.stage) : false;
  const settledRef = useRef(settled);
  useEffect(() => {
    // Settled while open: one refresh of the page (the board's own sections catch up), then quiet.
    if (settled && !settledRef.current) startTransition(() => router.refresh());
    settledRef.current = settled;
  }, [settled, router]);

  const hasInitial = initial != null;
  useEffect(() => {
    // Poll while the vendor or the human still has a step to take; stop once settled.
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stop || settledRef.current) return;
      if (typeof document === "undefined" || !document.hidden) await load();
      if (!stop) timer = setTimeout(tick, POLL_MS);
    };
    if (hasInitial) timer = setTimeout(tick, POLL_MS);
    else void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, hasInitial]);

  async function act(action: "paid" | "booked" | "cancel") {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setError(null);
    const r = await postAction<ActionAnswer>(url, { action });
    if (!r.ok) {
      busy.current = false;
      setSending(false);
      setConfirming(null);
      setError(r.error);
      return;
    }
    // Keep the button pending until the new stage has loaded, then let the board catch up.
    await load();
    busy.current = false;
    setSending(false);
    setConfirming(null);
    setNote(r.note ?? r.summary ?? (action === "paid" ? "Recorded that you paid. The vendor was told." : action === "booked" ? "Booking accepted." : "Cancelled."));
    startTransition(() => router.refresh());
  }

  if (!p) return <p className="ap-sub">Loading the purchase status…</p>;
  if (p.rail !== "manual" || !p.stage) return null;

  const current = STEP_OF[p.stage];
  const index = current ? STEPS.findIndex((s) => s.key === current) : -1;
  const amount = p.amount_usd !== undefined ? usd(p.amount_usd) : "the approved amount";

  return (
    <div className="ap-purchase">
      {p.confirm_only ? (
        <p className="ap-sub">Confirm-only order: nothing is paid through Haggle; you arrange payment with {business} under its terms.</p>
      ) : index >= 0 ? (
        <ol className="ap-steps" aria-label="Purchase progress">
          {STEPS.map((s, i) => (
            <li key={s.key} data-status={i < index ? "done" : i === index ? "current" : "todo"} aria-current={i === index ? "step" : undefined}>
              {s.label}
            </li>
          ))}
        </ol>
      ) : null}

      <div aria-live="polite" className="ap-status">
        {p.summary && <p className={p.stage === "settled_verified" ? "ap-ok" : "ap-wait"}>{p.summary}</p>}
        {p.next && <p className="ap-sub">Next: {p.next}</p>}
        {note && <p className="ap-sub">{note}</p>}
        {error && (
          <p className="note note-risk" role="alert">
            {error.message}
            {error.fix && <span className="ap-sub"> {error.fix}</span>}
          </p>
        )}
      </div>

      {p.instructions && <VendorWords text={p.instructions.text} hasLink={p.instructions.has_link} label={`Payment instructions from ${business}: unverified, confirm them with ${business} on a number you already know before paying`} />}
      {!p.instructions && p.vendor_reply && <VendorWords text={p.vendor_reply.text} hasLink={p.vendor_reply.has_link} label={`${business}'s reply (unverified)`} />}

      {confirming && (
        <div className="ap-confirm" role="group" aria-label="Confirm">
          {confirming === "paid" && <p>Only press this after you paid {business} {amount} yourself. Haggle tells {business} you report paying; it can&apos;t verify or reverse the payment.</p>}
          {confirming === "booked" && <p>Only if you confirmed the date, the total and every must-have with {business} directly. Haggle then asks them how to pay.</p>}
          {confirming === "cancel" && <p>Cancel the booking with {business}? Haggle tells them not to hold it. Don&apos;t pay them after this.</p>}
          <div className="ap-actions">
            <Button variant={confirming === "cancel" ? "danger" : "primary"} onClick={() => act(confirming)} pending={sending}>
              {confirming === "paid" ? `Yes, I paid ${amount}` : confirming === "booked" ? "Yes, it's booked" : "Yes, cancel it"}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(null)} disabled={sending}>
              Back
            </Button>
          </div>
        </div>
      )}

      {!confirming && (p.can.report_paid || p.can.accept_booking || p.can.cancel) && (
        <div className="ap-actions">
          {p.can.accept_booking && (
            <Button variant="primary" onClick={() => setConfirming("booked")}>
              The booking is confirmed
            </Button>
          )}
          {p.can.report_paid && (
            <Button variant="primary" onClick={() => setConfirming("paid")}>
              I&apos;ve paid the vendor
            </Button>
          )}
          {p.can.cancel && (
            <Button onClick={() => setConfirming("cancel")}>
              Cancel this booking
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
