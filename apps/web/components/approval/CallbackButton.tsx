"use client";
// One Voice AI callback a deal offers, authorized by the signed-in human (CLAUDE.md §7): a confirm
// step, then one POST (/internal/callbacks/authorize on the server). The server still requires a
// justified proposal and the business's consent to be called; a refusal shows its fix.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postAction, type ApiError } from "./post";
import "./approval.css";

export interface CallbackButtonProps {
  jobId: string;
  businessId: string;
  business: string;
}

type Phase = "idle" | "confirming" | "sending" | "placed" | "scheduled" | "declined";
type CallbackAnswer = { status: "placed" | "scheduled" | "declined"; scheduled_for?: string; next: string };

const when = (iso?: string) => {
  if (!iso) return "later";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "later" : d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
};

export function CallbackButton({ jobId, businessId, business }: CallbackButtonProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<ApiError | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string | undefined>();
  const busy = useRef(false);

  async function send() {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setPhase("sending");
    const r = await postAction<CallbackAnswer>(`/api/deals/${encodeURIComponent(jobId)}/callback`, { business_id: businessId });
    busy.current = false;
    if (!r.ok) {
      setError(r.error);
      setPhase("idle");
      return;
    }
    setScheduledFor(r.scheduled_for);
    setPhase(r.status);
    router.refresh();
  }

  return (
    <div className="ap-callback">
      <div aria-live="polite">
        {phase === "placed" && <p className="note ap-ok">Calling {business} back now. The deal updates when the call ends.</p>}
        {phase === "scheduled" && <p className="note ap-ok">Callback to {business} scheduled for {when(scheduledFor)} (call hours or a recent call).</p>}
        {phase === "declined" && <p className="muted">Callback not placed.</p>}
        {error && (
          <p className="note note-risk" role="alert">
            {error.message}
            {error.fix && <span className="ap-sub">{error.fix}</span>}
          </p>
        )}
      </div>

      {phase === "idle" && (
        <button type="button" className="btn" onClick={() => setPhase("confirming")}>
          Call {business} back
        </button>
      )}
      {(phase === "confirming" || phase === "sending") && (
        <div className="ap-confirm" role="group" aria-label={`Confirm callback to ${business}`}>
          <p>Haggle&apos;s AI assistant will call {business} back once, say it is an AI, and cite a real cheaper quote. Nothing is bought.</p>
          <div className="ap-actions">
            <button type="button" className="btn btn-primary" onClick={send} disabled={phase === "sending"} aria-busy={phase === "sending"}>
              {phase === "sending" ? "Asking…" : "Yes, call them"}
            </button>
            <button type="button" className="btn" onClick={() => setPhase("idle")} disabled={phase === "sending"}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
