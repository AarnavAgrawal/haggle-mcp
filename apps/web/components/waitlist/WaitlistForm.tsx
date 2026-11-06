"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { parseJoin, type WaitlistErrors, type WaitlistField } from "@/lib/waitlist/schema";
import "./waitlist.css";

type Values = Record<WaitlistField | "hp_ref", string>;

const FIELD_ORDER: WaitlistField[] = ["email", "full_name", "organization", "use_case"];

/**
 * The waitlist form: self-contained, with its own styles, so it can sit on any page. `email` fixes the
 * address for someone already signed in. The server checks everything again (lib/waitlist/route.ts).
 * `hp_ref` is a trap: people never see it, so only a bot fills it in. Its name means nothing, so browser
 * autofill leaves it alone and a real person is never taken for a bot.
 */
export function WaitlistForm({ email: fixedEmail }: { email?: string }) {
  const [values, setValues] = useState<Values>({ email: fixedEmail ?? "", full_name: "", organization: "", use_case: "", hp_ref: "" });
  const [errors, setErrors] = useState<WaitlistErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "joined">("idle");

  const set = (k: keyof Values) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    setErrors((x) => ({ ...x, [k]: undefined }));
  };
  const showErrors = (next: WaitlistErrors) => {
    setErrors(next);
    const first = FIELD_ORDER.find((f) => next[f]);
    if (first) document.getElementById(`wl-${first}`)?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseJoin(values);
    if (!parsed.ok) return showErrors(parsed.errors);
    setFailure(null);
    setState("sending");
    try {
      const res = await fetch("/api/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { field?: WaitlistField; message?: string; fix?: string } };
      if (res.ok && body.ok) {
        setState("joined");
        return;
      }
      setState("idle");
      if (body.error?.field && body.error.message && FIELD_ORDER.includes(body.error.field)) showErrors({ [body.error.field]: body.error.message });
      else setFailure([body.error?.message ?? "We couldn't add you to the list.", body.error?.fix].filter(Boolean).join(" "));
    } catch {
      setState("idle");
      setFailure("Couldn't reach Haggle. Check your connection and try again.");
    }
  };

  if (state === "joined") {
    return (
      <div className="wl-joined" role="status">
        <p className="wl-joined-title">You&apos;re on the list</p>
        <p>
          We&apos;ll email <strong>{values.email.trim()}</strong> when you&apos;re in.
        </p>
      </div>
    );
  }

  return (
    <form className="wl-form" onSubmit={submit} noValidate>
      <Field label="Email" error={errors.email}>
        <input id="wl-email" type="email" autoComplete="email" placeholder="you@company.com" value={values.email} onChange={set("email")} readOnly={!!fixedEmail} required />
      </Field>
      <Field label="Full name" error={errors.full_name}>
        <input id="wl-full_name" autoComplete="name" maxLength={120} value={values.full_name} onChange={set("full_name")} required />
      </Field>
      <Field label="Company, organization or school" error={errors.organization}>
        <input id="wl-organization" autoComplete="organization" maxLength={160} value={values.organization} onChange={set("organization")} required />
      </Field>
      <Field label="What would you use Haggle for?" optional error={errors.use_case}>
        <textarea id="wl-use_case" rows={3} maxLength={500} placeholder="Catering for our team offsites" value={values.use_case} onChange={set("use_case")} />
      </Field>
      <div className="wl-trap" inert>
        <label>
          Leave this empty
          <input type="text" name="hp_ref" tabIndex={-1} autoComplete="off" value={values.hp_ref} onChange={set("hp_ref")} />
        </label>
      </div>
      {failure && (
        <p className="note note-risk" role="alert">
          {failure}
        </p>
      )}
      <Button type="submit" variant="primary" block pending={state === "sending"}>
        Join the waitlist
      </Button>
    </form>
  );
}
