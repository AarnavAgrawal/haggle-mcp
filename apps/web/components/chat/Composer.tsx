"use client";
// The message box: an auto-growing textarea (no scrollbar until ~8 lines) with the send button inside.
// Enter sends, Shift+Enter adds a line. While Haggle replies the box stays focused and editable (the
// next message can be typed), sending waits, and the button becomes Stop (Esc also stops).
import { useLayoutEffect, type FormEvent, type KeyboardEvent, type Ref, type RefObject } from "react";

const MAX_LINES = 8;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  sending,
  placeholder,
  inputRef,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  sending: boolean;
  placeholder: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  hint?: boolean;
}) {
  // Grow with the text: measure at auto height, cap at MAX_LINES, scroll only past that.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 24;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const max = line * MAX_LINES + pad;
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight, max);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > max + 1 ? "auto" : "hidden";
  }, [value, inputRef]);

  const canSend = !sending && value.trim().length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSend) onSend();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    } else if (e.key === "Escape" && sending) {
      e.preventDefault();
      onStop();
    }
  };

  return (
    <form className="chat-form" onSubmit={submit}>
      <div className="chat-col">
        <div className="composer" data-sending={sending || undefined}>
          <label htmlFor="chat-input" className="sr-only">
            Message Haggle
          </label>
          <textarea
            id="chat-input"
            ref={inputRef as Ref<HTMLTextAreaElement>}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            rows={1}
            maxLength={4000}
            enterKeyHint="send"
            aria-describedby={hint ? "chat-hint" : undefined}
          />
          {sending ? (
            <button type="button" className="composer-btn composer-stop" onClick={onStop} aria-label="Stop">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button type="submit" className="composer-btn composer-send" disabled={!canSend} aria-label="Send">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" />
              </svg>
            </button>
          )}
        </div>
        {hint ? (
          <p id="chat-hint" className="composer-hint">
            <span>Enter sends</span>
            <span>Shift+Enter adds a line</span>
          </p>
        ) : null}
      </div>
    </form>
  );
}
