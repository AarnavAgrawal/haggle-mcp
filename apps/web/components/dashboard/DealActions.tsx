"use client";
// The deal page's forms and buttons: answer a business's question, message a business, ask for a
// better price, and the deal menu (cancel, with an inline confirm step). Each POSTs to
// /api/deals/<jobId>/actions and shows the server's error (message + fix) or its answer. The control
// stays pending from the click until the refreshed board has arrived (one async transition: the POST,
// then router.refresh(), which also updates the shell rail).
import { startTransition, useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ActionBody } from "@/lib/dashboard/actions";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";

type Feedback = { kind: "error"; message: string; fix: string } | { kind: "ok"; message: string } | null;
type Answer = { ok: true; next: string | null; data: Record<string, unknown> } | { ok: false; error: { message: string; fix: string } } | null;

function useDealAction(jobId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const busy = useRef(false);

  /** POST the action; on success refresh the board inside the same transition. Resolves to whether it worked. */
  function run(body: ActionBody, okMessage: (next: string | null, data: Record<string, unknown>) => string, onOk?: () => void): void {
    if (busy.current) return;
    busy.current = true;
    setFeedback(null);
    start(async () => {
      try {
        const res = await fetch(`/api/deals/${encodeURIComponent(jobId)}/actions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const out = (await res.json().catch(() => null)) as Answer;
        if (!out) {
          setFeedback({ kind: "error", message: `The app answered ${res.status}.`, fix: "Try again in a moment." });
          return;
        }
        if (!out.ok) {
          setFeedback({ kind: "error", message: out.error.message, fix: out.error.fix });
          return;
        }
        const message = okMessage(out.next, out.data);
        startTransition(() => {
          setFeedback({ kind: "ok", message });
          onOk?.();
          router.refresh();
        });
      } catch {
        setFeedback({ kind: "error", message: "Couldn't reach the app.", fix: "Check your connection and try again." });
      } finally {
        busy.current = false;
      }
    });
  }
  return { run, pending, feedback, clear: () => setFeedback(null) };
}

function FeedbackLine({ feedback, onDismiss }: { feedback: Feedback; onDismiss?: () => void }) {
  if (!feedback) return null;
  const close = onDismiss ? (
    <button type="button" className="act-close" aria-label="Dismiss" onClick={onDismiss}>
      <Icon name="close" />
    </button>
  ) : null;
  if (feedback.kind === "error")
    return (
      <p className="act-feedback act-error" role="alert">
        {feedback.message}
        {feedback.fix ? <span className="fix"> {feedback.fix}</span> : null}
        {close}
      </p>
    );
  return (
    <p className="act-feedback act-ok" role="status">
      <Icon name="check" /> {feedback.message}
      {close}
    </p>
  );
}

/** Answer one open question in the business's own thread (answer_business). */
export function AnswerForm({ jobId, questionId, business }: { jobId: string; questionId: string; business: string }) {
  const { run, pending, feedback } = useDealAction(jobId);
  const [answer, setAnswer] = useState("");
  const id = useId();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!answer.trim()) return;
    run({ action: "answer_business", question_id: questionId, answer }, () => `Sent your answer to ${business}.`, () => setAnswer(""));
  }
  return (
    <form onSubmit={submit} className="answer-form">
      <label htmlFor={id} className="sr-only">
        Your answer to {business}
      </label>
      <textarea
        id={id}
        rows={2}
        maxLength={2000}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
        placeholder={`Your answer, sent to ${business} in its own thread`}
        required
        readOnly={pending}
      />
      <Button variant="primary" type="submit" pending={pending} disabled={!answer.trim()}>
        Send answer
      </Button>
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
  const ids = { text: useId(), missing: useId(), channel: useId(), hint: useId() };
  const canSend = askMissing || text.trim().length > 0;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    const body: ActionBody = {
      action: "send_message",
      business_id: businessId,
      ...(text.trim() ? { text } : {}),
      ...(askMissing ? { ask_missing: true } : {}),
      ...(channel ? { channel: channel as "email" | "phone" | "a2a" | "imessage" } : {}),
    };
    run(
      body,
      (next, data) => {
        if (data.sent === false) return `Not sent yet. ${next ?? ""}`.trim();
        const when = typeof data.scheduled_for === "string" ? ` (scheduled for ${data.scheduled_for})` : "";
        return `Sent to ${business}${typeof data.channel === "string" ? ` by ${data.channel}` : ""}${when}.`;
      },
      () => {
        setText("");
        setAskMissing(false);
      },
    );
  }
  return (
    <form onSubmit={submit} className="msg-form" aria-labelledby={`${ids.text}-h`}>
      <h2 id={`${ids.text}-h`} className="msg-form-title">
        Message {business}
      </h2>
      <label htmlFor={ids.text} className="sr-only">
        Message
      </label>
      <textarea
        id={ids.text}
        rows={3}
        maxLength={1000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Write to ${business}`}
        aria-describedby={ids.hint}
        readOnly={pending}
      />
      <p id={ids.hint} className="hint">
        Guarded like everything Haggle sends: real amounts only, no other business names, no commitments.
      </p>
      <div className="msg-form-row">
        <label htmlFor={ids.missing} className="msg-check">
          <input id={ids.missing} type="checkbox" checked={askMissing} onChange={(e) => setAskMissing(e.target.checked)} />
          Ask only for what its quote is missing
        </label>
        <span className="msg-form-send">
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
          <Button variant="primary" type="submit" pending={pending} disabled={!canSend}>
            Send
          </Button>
        </span>
      </div>
      <FeedbackLine feedback={feedback} />
    </form>
  );
}

/** Run the counteroffer round (negotiate): businesses above the best real quote are asked to match it. */
export function NegotiateButton({ jobId }: { jobId: string }) {
  const { run, pending, feedback, clear } = useDealAction(jobId);
  const hint = useId();
  return (
    <div className="negotiate">
      <Button
        pending={pending}
        aria-describedby={hint}
        onClick={() =>
          run({ action: "negotiate" }, (next, data) => {
            const asked = Array.isArray(data.asked) ? (data.asked as { business?: string }[]).map((a) => a.business).filter(Boolean) : [];
            return asked.length ? `Asked ${asked.join(", ")} to match the best quote.` : `Nobody needed asking. ${next ?? ""}`.trim();
          })
        }
      >
        Ask for a better price
      </Button>
      <span id={hint} className="sr-only">
        Cites only a real quote&apos;s total and never names the other business. At most one counteroffer round.
      </span>
      <FeedbackLine feedback={feedback} onDismiss={clear} />
    </div>
  );
}

/**
 * The deal's menu (top right of the board): Cancel deal, confirmed inline in the menu itself (no
 * browser dialog). Esc or a click outside closes it; focus returns to the menu button.
 */
export function DealMenu({ jobId, canCancel }: { jobId: string; canCancel: boolean }) {
  const { run, pending, feedback } = useDealAction(jobId);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const panel = useId();

  const close = (focus = true) => {
    setOpen(false);
    setConfirming(false);
    if (focus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, confirming]);

  if (!canCancel) return null;
  return (
    <div
      className="deal-menu"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open && !pending) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <Button ref={trigger} icon aria-label="More actions for this deal" aria-expanded={open} aria-controls={panel} onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="more" size={20} />
      </Button>
      {open ? (
        <div id={panel} className="deal-menu-panel" role="group" aria-label="Deal actions">
          {confirming ? (
            <div className="deal-menu-confirm">
              <p>
                <strong>Cancel this deal?</strong> Businesses that replied are told; any approval is withdrawn.
              </p>
              <div className="deal-menu-actions">
                <Button
                  ref={first}
                  variant="danger"
                  size="s"
                  pending={pending}
                  onClick={() =>
                    run(
                      { action: "cancel_deal", confirm: true },
                      (next, data) => {
                        const note = typeof data.note === "string" ? data.note : "";
                        if (data.needs_approver) return `Not cancelled yet: ${note} ${next ?? ""}`.trim();
                        if (data.flagged) return `Not cancelled: ${note} ${next ?? ""}`.trim();
                        return next ?? "Deal cancelled.";
                      },
                      () => setConfirming(false),
                    )
                  }
                >
                  Yes, cancel the deal
                </Button>
                <Button size="s" variant="quiet" disabled={pending} onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </div>
              <FeedbackLine feedback={feedback} />
            </div>
          ) : (
            <>
              <button ref={first} type="button" className="deal-menu-item deal-menu-danger" onClick={() => setConfirming(true)}>
                Cancel deal…
              </button>
              <FeedbackLine feedback={feedback} />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
