"use client";

import { useState, type FormEvent } from "react";
import { GuestButton } from "@/components/GuestButton";
import { DEMO } from "@/lib/demo";
import { supabaseBrowser } from "@/lib/supabase/browser";

/** Sign in with an emailed magic link, or Google. Both land on /auth/callback. */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const redirectTo = () => `${window.location.origin}/auth/callback`;

  const sendLink = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setState("sending");
    const { error } = await supabaseBrowser().auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: redirectTo() } });
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

  return (
    <main className="shell" style={{ maxWidth: 420, paddingTop: 72 }}>
      <div className="card stack">
        <h1>Sign in to Haggle</h1>
        <p className="muted">Get quotes from real businesses by email, phone and text, compare them and approve the one you want.</p>
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
        {DEMO && <GuestButton label="Continue as a guest (demo)" className="btn" />}
        {error && (
          <p className="note note-risk" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
