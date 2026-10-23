"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

/** One-click guest access (Supabase anonymous sign-in): straight into a new request. */
export function GuestButton({ label = "Try the demo", className = "btn btn-primary" }: { label?: string; className?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setPending(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.signInAnonymously();
    if (error) {
      setError(error.message);
      setPending(false);
      return;
    }
    router.push("/chat");
    router.refresh();
  };
  return (
    <span className="guest">
      <button type="button" className={className} onClick={() => void start()} disabled={pending}>
        {pending ? "Starting…" : label}
      </button>
      {error && (
        <span className="note note-risk" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
