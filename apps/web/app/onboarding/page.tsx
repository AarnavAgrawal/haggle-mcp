"use client";

import { useActionState } from "react";
import { createWorkspace, type OnboardState } from "./actions";

/** First sign-in: name the workspace, who approves purchases by text, and the most one payment may be. */
export default function OnboardingPage() {
  const [state, action, pending] = useActionState<OnboardState, FormData>(createWorkspace, { error: null });
  return (
    <main className="shell" style={{ maxWidth: 520, paddingTop: 48 }}>
      <form className="card stack" action={action}>
        <h1>Set up your workspace</h1>
        <p className="muted">Haggle contacts businesses for you and never pays anything without your approval.</p>
        <div>
          <label htmlFor="name">Workspace name</label>
          <input id="name" name="name" placeholder="Acme events" maxLength={120} />
        </div>
        <div>
          <label htmlFor="approver_phone">
            Approver phone <span className="hint">(approvals arrive as a text; reply YES with the code)</span>
          </label>
          <input id="approver_phone" name="approver_phone" type="tel" placeholder="+14155550123" autoComplete="tel" />
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
  );
}
