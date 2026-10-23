"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Footer } from "@/components/Footer";
import { createWorkspace, type OnboardState } from "./actions";
import "./onboarding.css";

/** First sign-in on a live site: name the workspace, the spending cap, optionally a phone for texted approvals, and accept the Terms. */
export default function OnboardingPage() {
  const [state, action, pending] = useActionState<OnboardState, FormData>(createWorkspace, { error: null });
  return (
    <>
      <main className="shell" style={{ maxWidth: 520, paddingTop: 48 }}>
        <form className="card stack" action={action}>
          <h1>Set up your workspace</h1>
          <p className="muted">Haggle contacts businesses for you and never pays anything without your approval.</p>
          <div>
            <label htmlFor="name">Workspace name</label>
            <input id="name" name="name" placeholder="Acme events" maxLength={120} />
          </div>
          <div>
            <label htmlFor="cap_usd">
              Spending cap per payment <span className="hint">(USD, default $1,500)</span>
            </label>
            <input id="cap_usd" name="cap_usd" inputMode="decimal" placeholder="1500" />
          </div>
          <div>
            <label htmlFor="area">
              Usual area <span className="hint">(optional)</span>
            </label>
            <input id="area" name="area" placeholder="San Francisco, CA" maxLength={120} />
          </div>
          <div>
            <label htmlFor="approver_phone">
              Approver phone <span className="hint">(optional: you approve in the app; add a number to also approve by replying to a text)</span>
            </label>
            <input id="approver_phone" name="approver_phone" type="tel" placeholder="+14155550123" autoComplete="tel" />
          </div>
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
              , and I'll only have Haggle contact businesses for real requests.
            </label>
          </div>
          {state.error && (
            <p className="note note-risk" role="alert">
              {state.error}
            </p>
          )}
          <button className="btn btn-primary" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create workspace"}
          </button>
        </form>
      </main>
      <Footer />
    </>
  );
}
