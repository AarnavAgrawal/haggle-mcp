"use client";
// The conversation: streams one turn at a time from POST /api/chat (newline-delimited JSON events).
// Everything is rendered as plain text (business text quoted by the model is untrusted): no HTML,
// no markdown, no auto-linking. The only links are the deal board (/deals/<job_id>).
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatEvent } from "@/lib/chat/agent";
import { applyEvent } from "@/lib/chat/events";
import { chatExamples } from "@/lib/demo";
import type { DisplayItem } from "@/lib/chat/history";

// A demo site's examples are catering requests the simulated businesses answer (lib/demo.ts).
const EXAMPLES = chatExamples();

export function Chat({ threadId: initialThreadId, initial }: { threadId: string | null; initial: DisplayItem[] }) {
  const [threadId, setThreadId] = useState<string | null>(initialThreadId);
  const [items, setItems] = useState<DisplayItem[]>(initial);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, sending]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || sending) return;
      setSending(true);
      setDraft("");
      setItems((xs) => [...xs, { kind: "user", text: message }]);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, ...(threadId ? { thread_id: threadId } : {}) }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          const msg = body.error?.message ?? (res.status === 401 ? "Your session ended. Sign in again." : `The chat failed (HTTP ${res.status}).`);
          setItems((xs) => applyEvent(xs, { type: "error", message: msg }));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let e: ChatEvent;
            try {
              e = JSON.parse(line) as ChatEvent;
            } catch {
              continue;
            }
            if (e.type === "done") {
              if (e.thread_id && e.thread_id !== threadId) {
                setThreadId(e.thread_id);
                // Keep this page (and its state); the URL now resumes this conversation.
                window.history.replaceState(null, "", `/chat/${e.thread_id}`);
              }
            } else {
              setItems((xs) => applyEvent(xs, e));
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") setItems((xs) => applyEvent(xs, { type: "error", message: "Lost the connection to Haggle. Try again." }));
      } finally {
        abortRef.current = null;
        setSending(false);
        // Any chip still spinning ended with the turn.
        setItems((xs) => xs.map((it) => (it.kind === "tool" && it.status === "start" ? { ...it, status: "done" } : it)));
        inputRef.current?.focus();
      }
    },
    [sending, threadId],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  const waitingForText = sending && items[items.length - 1]?.kind !== "assistant";

  return (
    <section className="chat-main" aria-label="Chat with Haggle">
      <div className="chat-log" ref={logRef} role="log" aria-live="polite" aria-busy={sending} aria-label="Conversation">
        <div className="chat-col chat-thread">
        {items.length === 0 && (
          <div className="chat-empty">
            <h1>What do you need?</h1>
            <p>Tell Haggle what to buy. It asks a couple of questions, shows who it will contact, and starts once you confirm.</p>
            <ul className="examples">
              {EXAMPLES.map((x) => (
                <li key={x}>
                  <button type="button" onClick={() => { setDraft(x); inputRef.current?.focus(); }}>
                    {x}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {items.map((it, i) => {
          switch (it.kind) {
            case "user":
              return (
                <div key={i} className="chat-msg chat-msg-user">
                  <span className="sr-only">You: </span>
                  {it.text}
                </div>
              );
            case "assistant":
              return (
                <div key={i} className="chat-msg chat-msg-assistant">
                  <span className="sr-only">Haggle: </span>
                  {it.text}
                </div>
              );
            case "tool":
              return (
                <div key={i} className="tool-chip" data-status={it.status} title={it.summary}>
                  <span className="tool-dot" aria-hidden="true" />
                  <span>
                    <span className="sr-only">{it.status === "start" ? "Working: " : it.status === "error" ? "Failed: " : "Done: "}</span>
                    {it.summary}
                  </span>
                </div>
              );
            case "deal":
              return (
                <div key={i} className="chat-deal">
                  <div>
                    <strong>Deal started</strong>
                    <p>Haggle is contacting businesses. Quotes, calls and messages show up live on the deal board.</p>
                  </div>
                  <Link className="btn btn-primary" href={`/deals/${encodeURIComponent(it.job_id)}`}>
                    Open deal board
                  </Link>
                </div>
              );
            case "error":
              return (
                <p key={i} className="note note-risk" role="alert">
                  {it.text}
                </p>
              );
          }
        })}
        {waitingForText && <p className="typing">Haggle is thinking…</p>}
        </div>
      </div>
      <form className="chat-form" onSubmit={onSubmit}>
        <div className="chat-col">
          <div className="composer">
            <label htmlFor="chat-input" className="sr-only">
              Message Haggle
            </label>
            <textarea
              id="chat-input"
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={items.length ? "Reply to Haggle" : "Lunch for 40 next Thursday in SoMa, under $1,500"}
              rows={1}
              maxLength={4000}
              disabled={sending}
              autoFocus
            />
            {sending ? (
              <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
                Send
              </button>
            )}
          </div>
          <p className="composer-hint">Enter sends. Shift+Enter adds a line. Nothing is sent to a business until you confirm.</p>
        </div>
      </form>
    </section>
  );
}
