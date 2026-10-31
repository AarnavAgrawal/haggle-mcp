"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { supabaseBrowser } from "@/lib/supabase/browser";

/** One-click guest access (Supabase anonymous sign-in): straight into a new request. */
export function GuestButton({ label = "Try the demo", className = "btn btn-primary" }: { label?: string; className?: string }) {
  // With bot protection on, a guest sign-in needs the captcha token: /login has the widget.
  if (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    return (
      <Link className={className} href="/login">
        {label}
      </Link>
    );
  }
  return <GuestSignIn label={label} className={className} />;
}

function GuestSignIn({ label, className }: { label: string; className: string }) {
  const router = useRouter();
  // signingIn covers the Supabase call; the transition keeps the button pending until /chat has rendered.
  const [signingIn, setSigningIn] = useState(false);
  const [navigating, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setSigningIn(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.signInAnonymously();
    if (error) {
      setError(error.message);
      setSigningIn(false);
      return;
    }
    startTransition(() => {
      router.push("/chat");
      router.refresh();
    });
  };
  const pending = signingIn || navigating;
  return (
    <span className="guest">
      <Button className={className} pending={pending} onClick={() => void start()}>
        {label}
      </Button>
      {error && (
        <span className="note note-risk" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
