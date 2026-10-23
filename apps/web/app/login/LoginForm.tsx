"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { DEMO } from "@/lib/demo";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { Turnstile, TURNSTILE_SITE_KEY } from "./Turnstile";

/**
 * Sign in with an emailed magic link or Google (both land on /auth/callback); on a demo site, also as a
 * guest. With NEXT_PUBLIC_TURNSTILE_SITE_KEY set, the link and guest sign-in carry a Turnstile token
 * (Supabase checks it); Google's own sign-in needs none.
 */
export function LoginForm({ notice }: { notice: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "guest">("idle");
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const redirectTo = () => `${window.location.origin}/auth/callback`;
  const needsCaptcha = !!TURNSTILE_SITE_KEY && !captcha;
  const captchaOpts = captcha ? { captchaToken: captcha } : {};
  const used = () => setResetKey((k) => k + 1); // a token is single use

  const sendLink = async (e: FormEvent) => {
    e.preventDefault();
    if (needsCaptcha) return setError("Complete the check below first.");
    setError(null);
    setState("sending");
    const { error } = await supabaseBrowser().auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: redirectTo(), ...captchaOpts } });
    used();
    if (error) {
      setError(error.message);
      setState("idle");
    } else setState("sent");
  };
  const google = async () => {
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
    if (error) setError(error.message);
  };
  const guest = async () => {
    if (needsCaptcha) return setError("Complete the check below first.");
    setError(null);
    setState("guest");
    const { error } = await supabaseBrowser().auth.signInAnonymously({ options: { ...captchaOpts } });
    used();
    if (error) {
      setError(error.message);
      setState("idle");
      return;
    }
    router.push("/chat");
    router.refresh();
  };

  return (
    <div className="card stack">
      <h1>Sign in to Haggle</h1>
      <p className="muted">Get quotes from real businesses by email, phone and text, compare them and approve the one you want.</p>
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      {state === "sent" ? (
        <p className="note" role="status">
          Check {email} for a sign-in link.
        </p>
      ) : (
        <form className="stack" onSubmit={sendLink}>
          <div>
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={state === "sending"} style={{ width: "100%" }}>
            {state === "sending" ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      )}
      <button className="btn" type="button" onClick={() => void google()} style={{ width: "100%" }}>
        Continue with Google
      </button>
      {DEMO && (
        <button className="btn" type="button" onClick={() => void guest()} disabled={state === "guest"} style={{ width: "100%" }}>
          {state === "guest" ? "Starting…" : "Continue as a guest (demo)"}
        </button>
      )}
      {TURNSTILE_SITE_KEY && state !== "sent" && <Turnstile siteKey={TURNSTILE_SITE_KEY} onToken={setCaptcha} resetKey={resetKey} />}
      {error && (
        <p className="note note-risk" role="alert">
          {error}
        </p>
      )}
      <p className="hint">
        By signing in you agree to the <Link href="/terms">Terms</Link> and the <Link href="/acceptable-use">Acceptable Use policy</Link>. See how we handle data in the{" "}
        <Link href="/privacy">Privacy policy</Link>.
      </p>
    </div>
  );
}
