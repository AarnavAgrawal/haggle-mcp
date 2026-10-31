"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

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
    <form className="acct-delete" onSubmit={submit}>
      <Field
        label={
          <span>
            Type <strong className="acct-word">{CONFIRM}</strong> to confirm
          </span>
        }
        className="acct-confirm"
      >
        <input id="confirm_delete" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={pending} />
      </Field>
      <Button type="submit" variant="danger" className="acct-delete-btn" disabled={typed !== CONFIRM} pending={pending}>
        {pending ? "Deleting…" : "Delete my account"}
      </Button>
      {error ? (
        <p className="note note-risk acct-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
