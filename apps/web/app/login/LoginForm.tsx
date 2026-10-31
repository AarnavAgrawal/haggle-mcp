"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
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
  const [state, setState] = useState<"idle" | "sending" | "sent" | "guest" | "google">("idle");
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [navigating, startTransition] = useTransition();
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
    setState("google"); // stays pending while the browser leaves for Google
    const { error } = await supabaseBrowser().auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
    if (error) {
      setError(error.message);
      setState("idle");
    }
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
    // The button stays pending until /chat has rendered.
    startTransition(() => {
      router.push("/chat");
      router.refresh();
    });
  };
  // Back from Google's page (restored from the back/forward cache): the Google button is usable again.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setState((s) => (s === "google" ? "idle" : s));
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  const busy = state === "sending" || state === "google" || state === "guest" || navigating;

  return (
    <div className="ui-sheet auth-sheet">
      <h1>Sign in to Haggle</h1>
      <p className="auth-sub">New here? Signing in creates your account.</p>
      {notice && (
        <p className="note auth-notice" role="status">
          {notice}
        </p>
      )}
      <Button block className="auth-google" pending={state === "google"} disabled={busy && state !== "google"} onClick={() => void google()}>
        <GoogleMark />
        Continue with Google
      </Button>
      <p className="auth-or" aria-hidden="true">
        <span>or</span>
      </p>
      {state === "sent" ? (
        <div className="auth-sent" role="status">
          <p className="auth-sent-title">Check your email</p>
          <p>
            We sent a sign-in link to <strong>{email.trim()}</strong>. Open it on this device to finish signing in.
          </p>
          <Button variant="quiet" size="s" className="auth-sent-again" onClick={() => setState("idle")}>
            Use a different email
          </Button>
        </div>
      ) : (
        <form className="auth-form" onSubmit={sendLink}>
          <Field label="Email">
            <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          <Button type="submit" variant="primary" block pending={state === "sending"} disabled={busy && state !== "sending"}>
            Email me a sign-in link
          </Button>
        </form>
      )}
      {DEMO && (
        <div className="auth-guest">
          <Button block pending={state === "guest" || navigating} disabled={busy && state !== "guest"} onClick={() => void guest()}>
            Continue as a guest
          </Button>
          <p className="auth-guest-hint">Demo only: simulated businesses, nothing real is contacted or paid.</p>
        </div>
      )}
      {TURNSTILE_SITE_KEY && state !== "sent" && <Turnstile siteKey={TURNSTILE_SITE_KEY} onToken={setCaptcha} resetKey={resetKey} />}
      {error && (
        <p className="note note-risk auth-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Google's "G" (inline, so the CSP's same-origin image rule is untouched). */
function GoogleMark() {
  return (
    <svg className="icon" width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** The links under the sign-in sheet. */
export function LoginLegal() {
  return (
    <p className="auth-legal">
      By signing in you agree to the <Link href="/terms">Terms</Link> and the <Link href="/acceptable-use">Acceptable Use policy</Link>. How we handle data:{" "}
      <Link href="/privacy">Privacy policy</Link>.
    </p>
  );
}
