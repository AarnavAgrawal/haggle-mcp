"use client";
// The deal page's forms and buttons: answer a business's question, message a business, ask for a
// better price, cancel the deal (with a confirm step). Each POSTs to /api/deals/<jobId>/actions and
// shows the server's error (message + fix) or its next hint, then refreshes the page's data.
import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ActionBody } from "@/lib/dashboard/actions";

type Feedback = { kind: "error"; message: string; fix: string } | { kind: "ok"; message: string } | null;

function useDealAction(jobId: string) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const busy = useRef(false);

  async function run(body: ActionBody, okMessage: (next: string | null, data: Record<string, unknown>) => string): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/deals/${encodeURIComponent(jobId)}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => null)) as
        | { ok: true; next: string | null; data: Record<string, unknown> }
        | { ok: false; error: { message: string; fix: string } }
        | null;
      if (!out) {
        setFeedback({ kind: "error", message: `The app answered ${res.status}.`, fix: "Try again in a moment." });
        return false;
      }
      if (!out.ok) {
        setFeedback({ kind: "error", message: out.error.message, fix: out.error.fix });
        return false;
      }
      setFeedback({ kind: "ok", message: okMessage(out.next, out.data) });
      router.refresh();
      return true;
    } catch {
      setFeedback({ kind: "error", message: "Couldn't reach the app.", fix: "Check your connection and try again." });
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return { run, pending, feedback };
}

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  if (feedback.kind === "error")
    return (
      <p className="note note-risk" role="alert">
        {feedback.message}
        {feedback.fix ? <span className="fix"> {feedback.fix}</span> : null}
      </p>
    );
  return (
    <p className="note" role="status">
      {feedback.message}
    </p>
  );
}

/** Answer one open question in the business's own thread (answer_business). */
export function AnswerForm({ jobId, questionId, business }: { jobId: string; questionId: string; business: string }) {
  const { run, pending, feedback } = useDealAction(jobId);
  const [answer, setAnswer] = useState("");
  const id = useId();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!answer.trim()) return;
    if (await run({ action: "answer_business", question_id: questionId, answer }, () => `Sent your answer to ${business}.`)) setAnswer("");
  }
  return (
    <form onSubmit={submit} className="dash-form">
      <label htmlFor={id}>
        Your answer <span className="hint">sent to {business} in its own thread</span>
      </label>
      <textarea id={id} rows={2} maxLength={2000} value={answer} onChange={(e) => setAnswer(e.target.value)} required />
      <div className="dash-row">
        <button className="btn btn-primary" type="submit" disabled={pending || !answer.trim()}>
          {pending ? "Sending…" : "Send answer"}
        </button>
      </div>
      <FeedbackLine feedback={feedback} />
    </form>
  );
}

const CHANNELS = [
  ["", "Same channel as before"],
  ["email", "Email"],
  ["imessage", "Text"],
  ["phone", "Phone call (short Voice AI call)"],
  ["a2a", "Agent (A2A)"],
] as const;

/** Message one business (send_message): your own words, or ask for what its quote is missing. */
export function MessageForm({ jobId, businessId, business }: { jobId: string; businessId: string; business: string }) {
  const { run, pending, feedback } = useDealAction(jobId);
  const [text, setText] = useState("");
  const [askMissing, setAskMissing] = useState(false);
  const [channel, setChannel] = useState<string>("");
  const ids = { text: useId(), missing: useId(), channel: useId() };
  const canSend = askMissing || text.trim().length > 0;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    const body: ActionBody = {
      action: "send_message",
      business_id: businessId,
      ...(text.trim() ? { text } : {}),
      ...(askMissing ? { ask_missing: true } : {}),
      ...(channel ? { channel: channel as "email" | "phone" | "a2a" | "imessage" } : {}),
    };
    const ok = await run(body, (next, data) => {
      if (data.sent === false) return `Not sent yet. ${next ?? ""}`.trim();
      const when = typeof data.scheduled_for === "string" ? ` (scheduled for ${data.scheduled_for})` : "";
      return `Sent to ${business}${typeof data.channel === "string" ? ` by ${data.channel}` : ""}${when}.`;
    });
    if (ok) {
      setText("");
      setAskMissing(false);
    }
  }
  return (
    <form onSubmit={submit} className="dash-form card">
      <h2 className="dash-h2">Message {business}</h2>
      <p className="hint">
        Guarded like everything Haggle sends: real amounts only, no other business names, no commitments (approve the quote to commit).
      </p>
      <label htmlFor={ids.text}>Message</label>
      <textarea id={ids.text} rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Plain text" />
      <div className="dash-row dash-wrap">
        <label htmlFor={ids.missing} className="dash-check">
          <input id={ids.missing} type="checkbox" checked={askMissing} onChange={(e) => setAskMissing(e.target.checked)} />
          Ask only for what its quote is missing
        </label>
        <span className="dash-select">
          <label htmlFor={ids.channel} className="sr-only">
            Channel
          </label>
          <select id={ids.channel} value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </span>
        <button className="btn btn-primary" type="submit" disabled={pending || !canSend}>
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
      <FeedbackLine feedback={feedback} />
    </form>
  );
}

/** Run the counteroffer round (negotiate): businesses above the best real quote are asked to match it. */
export function NegotiateButton({ jobId }: { jobId: string }) {
  const { run, pending, feedback } = useDealAction(jobId);
  return (
    <div className="stack">
      <div className="dash-row dash-wrap">
        <button
          className="btn"
          type="button"
          disabled={pending}
          onClick={() =>
            run({ action: "negotiate" }, (next, data) => {
              const asked = Array.isArray(data.asked) ? (data.asked as { business?: string }[]).map((a) => a.business).filter(Boolean) : [];
              return asked.length ? `Asked ${asked.join(", ")} to match the best quote.` : `Nobody needed asking. ${next ?? ""}`.trim();
            })
          }
        >
          {pending ? "Asking…" : "Ask for a better price"}
        </button>
        <span className="hint">Cites only a real quote's total and never names the other business. At most one counteroffer round.</span>
      </div>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

/** Cancel the deal, after an explicit confirm step (cancel_deal). */
export function CancelDealButton({ jobId }: { jobId: string }) {
  const { run, pending, feedback } = useDealAction(jobId);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="stack">
      {confirming ? (
        <div className="note note-risk dash-confirm" role="group" aria-label="Confirm cancelling this deal">
          <span>Cancel this deal? Businesses that replied are told; any approval is withdrawn.</span>
          <div className="dash-row">
            <button
              className="btn btn-danger"
              type="button"
              disabled={pending}
              onClick={async () => {
                await run({ action: "cancel_deal", confirm: true }, (next, data) => {
                  const note = typeof data.note === "string" ? data.note : "";
                  if (data.needs_approver) return `Not cancelled yet: ${note} ${next ?? ""}`.trim();
                  if (data.flagged) return `Not cancelled: ${note} ${next ?? ""}`.trim();
                  return next ?? "Deal cancelled.";
                });
                setConfirming(false);
              }}
            >
              {pending ? "Cancelling…" : "Yes, cancel the deal"}
            </button>
            <button className="btn" type="button" disabled={pending} onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <button className="btn" type="button" onClick={() => setConfirming(true)}>
          Cancel deal
        </button>
      )}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
