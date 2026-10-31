"use client";
// A new approver phone or email waiting for verification: "Pending verification", where the code went,
// an input for the 6-digit code with Confirm, and Cancel change. On a demo site (mock server) nothing is
// sent, so the code is shown instead, labelled. A confirm link from the email (?confirm=<token>) shows
// ConfirmLink: one button, so a mail scanner opening the link changes nothing.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Status } from "@/components/ui/Status";
import type { PendingApprover as Pending } from "@/lib/settings/types";
import { settingsApi, type SettingsApiError } from "./api";

const KIND = { phone: "phone", email: "email" } as const;

export function PendingApprover({ p, demoCode }: { p: Pending; demoCode?: string | null }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<SettingsApiError | null>(null);
  const [pending, start] = useTransition();
  const [cancelling, startCancel] = useTransition();

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{3}[\s-]?\d{3}$/.test(code.trim())) {
      setError("Enter the 6-digit code.");
      return;
    }
    setError(null);
    setFailure(null);
    start(async () => {
      const r = await settingsApi<{ confirmed: string }>("/api/settings/confirm", { kind: p.kind, code: code.trim() });
      if (!r.ok) {
        if (r.error.code === "wrong_code" || r.error.code === "bad_code") setError(`${r.error.message} ${r.error.fix}`);
        else setFailure(r.error);
        return;
      }
      setCode("");
      router.refresh();
    });
  };
  const cancel = () =>
    startCancel(async () => {
      setFailure(null);
      const r = await settingsApi("/api/settings/cancel", { kind: p.kind });
      if (!r.ok) setFailure(r.error);
      router.refresh();
    });

  return (
    <form className="set-pending" onSubmit={confirm} noValidate aria-label={`Confirm the new approver ${KIND[p.kind]}`}>
      <p className="set-pending-head">
        <Status tone="hold">Pending verification</Status>
        <span>
          New approver {KIND[p.kind]} <strong>{p.to}</strong>. {p.kind === "phone" ? "We texted it a 6-digit code." : "We emailed it a confirm link and a code."} The current approver stays until then.
        </span>
      </p>
      {demoCode ? (
        <p className="set-sub">
          <Badge /> Nothing was sent on this demo. The code is <span className="num">{demoCode}</span>.
        </p>
      ) : null}
      <div className="set-pending-row">
        <Field label="Code" error={error}>
          <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} disabled={pending} placeholder="123456" />
        </Field>
        <div className="set-actions">
          <Button type="submit" variant="primary" size="s" pending={pending}>
            Confirm
          </Button>
          <Button size="s" variant="quiet" onClick={cancel} pending={cancelling} disabled={pending}>
            Cancel change
          </Button>
        </div>
      </div>
      {failure ? (
        <p className="set-fail" role="alert">
          {failure.message} {failure.fix}
        </p>
      ) : null}
    </form>
  );
}

export function ConfirmLink({ token }: { token: string }) {
  const router = useRouter();
  const [failure, setFailure] = useState<SettingsApiError | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const confirm = () =>
    start(async () => {
      setFailure(null);
      const r = await settingsApi<{ confirmed: string }>("/api/settings/confirm", { token });
      if (!r.ok) {
        setFailure(r.error);
        return;
      }
      setDone(true);
      router.replace("/settings");
      router.refresh();
    });
  if (done) return <p className="ui-sheet set-banner" role="status">The new approver email is confirmed.</p>;
  return (
    <div className="ui-sheet set-banner" role="region" aria-label="Confirm the new approver email">
      <p>Confirm the new approver email from the link Haggle sent.</p>
      <Button variant="primary" size="s" pending={pending} onClick={confirm}>
        Confirm approver email
      </Button>
      {failure ? (
        <p className="set-fail" role="alert">
          {failure.message} {failure.fix}
        </p>
      ) : null}
    </div>
  );
}
