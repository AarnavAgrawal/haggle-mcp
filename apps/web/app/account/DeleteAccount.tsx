"use client";

import { useState, type FormEvent } from "react";

const CONFIRM = "DELETE";

/** Type DELETE, then POST /api/account/delete; on success the session is gone, so go to /login. */
export function DeleteAccount() {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (typed !== CONFIRM) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: CONFIRM }) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { message?: string; fix?: string } };
      if (res.ok && body.ok) {
        window.location.assign("/login?deleted=1");
        return;
      }
      setError([body.error?.message ?? "Your account couldn't be deleted.", body.error?.fix].filter(Boolean).join(" "));
    } catch {
      setError("Couldn't reach Haggle. Check your connection and try again.");
    }
    setPending(false);
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div>
        <label htmlFor="confirm_delete">
          Type <strong>{CONFIRM}</strong> to confirm
        </label>
        <input id="confirm_delete" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </div>
      {error && (
        <p className="note note-risk" role="alert">
          {error}
        </p>
      )}
      <button className="btn acct-delete" type="submit" disabled={typed !== CONFIRM || pending}>
        {pending ? "Deleting…" : "Delete my account"}
      </button>
    </form>
  );
}
