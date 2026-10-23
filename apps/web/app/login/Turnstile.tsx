"use client";

// Cloudflare Turnstile (bot protection on sign-in), rendered explicitly so its single-use token can be
// reset after each attempt. Supabase verifies the token (Auth → Bot and Abuse Protection, the secret key
// lives there). The CSP allows challenges.cloudflare.com only when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set.
import { useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render(el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; "expired-callback": () => void; "error-callback": () => void; theme?: "auto" | "light" | "dark" }): string;
  reset(id?: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error("Turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** The public site key (inlined at build time); null means no widget and no captcha token. */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || null;

/** Renders the widget; `onToken` gets a token, or null when it expires or errors. Bump `resetKey` after each sign-in attempt. */
export function Turnstile({ siteKey, onToken, resetKey }: { siteKey: string; onToken: (token: string | null) => void; resetKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let gone = false;
    loadScript()
      .then(() => {
        if (gone || !box.current || !window.turnstile) return;
        widget.current = window.turnstile.render(box.current, {
          sitekey: siteKey, theme: "auto",
          callback: (t) => cb.current(t), "expired-callback": () => cb.current(null), "error-callback": () => cb.current(null),
        });
      })
      .catch(() => setFailed(true));
    return () => {
      gone = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0 || !widget.current) return;
    cb.current(null);
    window.turnstile?.reset(widget.current);
  }, [resetKey]);

  return (
    <div>
      <div ref={box} />
      {failed && (
        <p className="note note-risk" role="alert">
          The bot check couldn't load. Check your connection or disable content blockers for this site, then reload.
        </p>
      )}
    </div>
  );
}
