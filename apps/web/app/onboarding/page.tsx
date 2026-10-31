"use client";

import Link from "next/link";
import { useActionState, useState, type FormEvent } from "react";
import { Footer } from "@/components/Footer";
import { Field } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createWorkspace, type OnboardState } from "./actions";
import "../auth.css";

// The same rules the server action applies (actions.ts), checked as you leave each field so mistakes
// show next to the field before submitting. The server still validates everything.
const E164 = /^\+[1-9]\d{6,14}$/;
const phoneError = (v: string) => {
  const phone = v.replace(/[\s().-]/g, "");
  return phone && !E164.test(phone) ? "Include the country code, for example +1 415 555 0123." : null;
};
const capError = (v: string) => {
  if (!v.trim()) return null;
  const cap = Number(v.replace(/[$,\s]/g, ""));
  return cap > 0 ? null : "Enter an amount above $0, like 1500.";
};

type Values = { name: string; area: string; cap_usd: string; approver_phone: string };

/** First sign-in on a live site: name the workspace, the spending cap, optionally a phone for texted approvals, and accept the Terms. */
export default function OnboardingPage() {
  const [state, action] = useActionState<OnboardState, FormData>(createWorkspace, { error: null });
  // Controlled, so a server-side error keeps what was typed (React resets uncontrolled fields after an action).
  const [values, setValues] = useState<Values>({ name: "", area: "", cap_usd: "", approver_phone: "" });
  const [errors, setErrors] = useState<{ cap_usd?: string | null; approver_phone?: string | null }>({});
  const set = (k: keyof Values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    // Once a field has shown an error, re-check it as it's corrected.
    if (k === "cap_usd" && errors.cap_usd) setErrors((x) => ({ ...x, cap_usd: capError(e.target.value) }));
    if (k === "approver_phone" && errors.approver_phone) setErrors((x) => ({ ...x, approver_phone: phoneError(e.target.value) }));
  };
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    const next = { cap_usd: capError(values.cap_usd), approver_phone: phoneError(values.approver_phone) };
    setErrors(next);
    if (next.cap_usd || next.approver_phone) {
      e.preventDefault(); // stops the action; focus the first field to fix
      document.getElementById(next.cap_usd ? "cap_usd" : "approver_phone")?.focus();
    }
  };

  return (
    <>
      <main className="auth">
        <Link className="brand auth-brand" href="/">
          Haggle
        </Link>
        <div className="ui-sheet auth-sheet auth-wide">
          <h1>Set up your workspace</h1>
          <p className="auth-sub">Haggle contacts businesses for you and never pays anything without your approval.</p>
          <form className="onb-form" action={action} onSubmit={onSubmit}>
            <fieldset className="onb-group">
              <legend>Your workspace</legend>
              <Field label="Workspace name" hint="Usually your team or company.">
                <input id="name" name="name" placeholder="Acme events" maxLength={120} autoComplete="organization" value={values.name} onChange={set("name")} />
              </Field>
              <Field label="Usual area" optional hint="Where deliveries and visits usually go.">
                <input id="area" name="area" placeholder="San Francisco, CA" maxLength={120} value={values.area} onChange={set("area")} />
              </Field>
            </fieldset>
            <fieldset className="onb-group">
              <legend>Approvals</legend>
              <Field label="Spending cap per payment" hint="Haggle never approves a payment above it. Leave blank for $1,500." error={errors.cap_usd}>
                <CapInput id="cap_usd" value={values.cap_usd} onChange={set("cap_usd")} onBlur={() => setErrors((x) => ({ ...x, cap_usd: capError(values.cap_usd) }))} />
              </Field>
              <Field label="Approver phone" optional hint="Approve by replying to a text. You can always approve in the app." error={errors.approver_phone}>
                <input
                  id="approver_phone"
                  name="approver_phone"
                  type="tel"
                  placeholder="+1 415 555 0123"
                  autoComplete="tel"
                  value={values.approver_phone}
                  onChange={set("approver_phone")}
                  onBlur={() => setErrors((x) => ({ ...x, approver_phone: phoneError(values.approver_phone) }))}
                />
              </Field>
            </fieldset>
            <div className="onb-terms">
              <input id="accept_terms" name="accept_terms" type="checkbox" required />
              <label htmlFor="accept_terms">
                I agree to the{" "}
                <Link href="/terms" target="_blank">
                  Terms
                </Link>{" "}
                and the{" "}
                <Link href="/acceptable-use" target="_blank">
                  Acceptable Use policy
                </Link>
                , and I&apos;ll only have Haggle contact businesses for real requests.
              </label>
            </div>
            {state.error && (
              <p className="note note-risk auth-error" role="alert">
                {state.error}
              </p>
            )}
            <SubmitButton variant="primary" block className="onb-submit">
              Create workspace
            </SubmitButton>
          </form>
        </div>
      </main>
      <Footer />
    </>
  );
}

/** The cap with a "$" in front (the wrapper draws it); Field passes id and aria props through. */
function CapInput(props: { value: string; onChange: (e: { target: { value: string } }) => void; onBlur: () => void; id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" }) {
  return (
    <span className="onb-money">
      <input name="cap_usd" inputMode="decimal" placeholder="1,500" {...props} />
    </span>
  );
}
