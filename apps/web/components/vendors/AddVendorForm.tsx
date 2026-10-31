"use client";
// "Add a vendor" (inside the page's drawer): name, email or phone, how Haggle reaches it, how the
// business agreed (plain-language choices), an optional note and a required attestation. Errors show
// inline as each field is left, using the same rules (lib/vendors/form.ts) that run again on this app's
// server and on the MCP server: a business found only in a public listing may be emailed, never called
// or texted. Mount it with key={prefill.key} so a prefill from Find businesses starts a fresh form.
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Icon, channelIcon } from "@/components/ui/Icon";
import { ATTESTATION, basisAllows, CHANNEL_OPTIONS, CONSENT_OPTIONS, normalizeContact, validateVendorForm, type ConsentBasis, type FormField, type VendorChannel } from "@/lib/vendors/form";
import type { VendorView } from "@/lib/vendors/types";
import { vendorApi, type VendorApiError } from "./api";

export interface VendorPrefill {
  key: number;
  name: string;
  /** An address the business publishes on its own website, when one was found. */
  contact?: string;
  note?: string;
  consent_basis?: ConsentBasis;
  /** The listing it was found in: the server keeps its opening hours with the vendor. */
  business_ref?: string;
}

const CHANNEL_SHORT: Record<VendorChannel, string> = { email: "Email", phone: "Phone call", imessage: "Text" };

interface Props {
  open: boolean;
  prefill: VendorPrefill | null;
  /** How many more vendors can be added today. */
  left: number;
  onAdded: (vendor: VendorView, next: string) => void;
  onCancel: () => void;
}

export function AddVendorForm({ open, prefill, left, onAdded, onCancel }: Props) {
  const [name, setName] = useState(prefill?.name ?? "");
  const [contact, setContact] = useState(prefill?.contact ?? "");
  const [channel, setChannel] = useState<VendorChannel | "">(prefill ? "email" : "");
  const [basis, setBasis] = useState<ConsentBasis | "">(prefill?.consent_basis ?? "");
  const [note, setNote] = useState(prefill?.note ?? "");
  const [attested, setAttested] = useState(false);
  const businessRef = prefill?.business_ref;
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<FormField, string>>>({});
  const [failure, setFailure] = useState<VendorApiError | null>(null);
  const [pending, start] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);
  const contactRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // On open, put the caret where typing starts (after the drawer's own focus handling).
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => (prefill && !prefill.contact ? contactRef : nameRef).current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, prefill]);

  const kind = normalizeContact(contact)?.kind ?? (contact.includes("@") ? "email" : null);
  const effective: VendorChannel | "" = kind === "email" ? "email" : kind === "phone" && channel === "email" ? "phone" : kind === "phone" && !channel ? "phone" : channel;
  const input = { name, contact, channel: effective || undefined, consent_basis: basis || undefined, note, attested, ...(businessRef ? { business_ref: businessRef } : {}) };
  const check = validateVendorForm(input);
  const live = check.ok ? {} : check.errors;
  const errorFor = (f: FormField) => serverErrors[f] ?? (submitted || touched[f] ? live[f] : undefined);
  const touch = (f: FormField) => () => setTouched((t) => (t[f] ? t : { ...t, [f]: true }));
  const edited = (f: FormField) => {
    if (serverErrors[f]) setServerErrors(({ [f]: _, ...rest }) => rest);
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setFailure(null);
    if (!check.ok) {
      // Move to the first field that needs fixing.
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    start(async () => {
      const r = await vendorApi<{ vendor: VendorView; next: string }>("/api/vendors", { ...input });
      if (!r.ok) {
        if (r.fields) setServerErrors(r.fields as Partial<Record<FormField, string>>);
        setFailure(r.error);
        return;
      }
      // The drawer closes; the parent mounts a fresh form (a new key) the next time it opens.
      onAdded(r.vendor, r.next);
    });
  }

  const basisError = errorFor("consent_basis");
  const channelError = errorFor("channel");
  const attestError = errorFor("attested");
  return (
    <form ref={formRef} className="vf" onSubmit={submit} noValidate aria-busy={pending || undefined}>
      <div className="vf-body">
        <p className="vf-lede">Haggle contacts only the businesses you add, only the way you record here, and never again once one asks it to stop.</p>

        <Field label="Business name" error={errorFor("name")}>
          <input ref={nameRef} value={name} maxLength={120} autoComplete="organization" onBlur={touch("name")} onChange={(e) => (setName(e.target.value), edited("name"))} />
        </Field>

        <Field label="Email or phone" hint="Phone numbers with the country code, like +1 415 555 0123." error={errorFor("contact")}>
          <input ref={contactRef} value={contact} maxLength={254} inputMode="email" autoComplete="off" spellCheck={false} onBlur={touch("contact")} onChange={(e) => (setContact(e.target.value), edited("contact"))} />
        </Field>

        <fieldset className="vf-set" aria-describedby={channelError ? "vf-channel-err" : undefined}>
          <legend className="field-label">Reached by</legend>
          <div className="vf-seg">
            {CHANNEL_OPTIONS.map((o) => {
              const off = kind ? (kind === "email") !== (o.value === "email") : false;
              return (
                <label key={o.value} className={`vf-seg-opt${off ? " is-off" : ""}`}>
                  <input type="radio" name="vf-channel" value={o.value} checked={effective === o.value} disabled={off || pending} onChange={() => (setChannel(o.value), edited("channel"))} />
                  <Icon name={channelIcon(o.value)} />
                  <span>{CHANNEL_SHORT[o.value]}</span>
                </label>
              );
            })}
          </div>
          {channelError ? (
            <p className="field-error" id="vf-channel-err">
              {channelError}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="vf-set" aria-describedby={basisError ? "vf-basis-err" : undefined}>
          <legend className="field-label">How did they agree to hear from Haggle?</legend>
          <div className="vf-choices">
            {CONSENT_OPTIONS.map((o) => {
              const blocked = !!effective && !basisAllows(o.value, effective);
              return (
                <label key={o.value} className={`vf-choice${blocked ? " is-off" : ""}`}>
                  <input
                    type="radio"
                    name="vf-basis"
                    value={o.value}
                    checked={basis === o.value}
                    disabled={blocked || pending}
                    aria-invalid={basisError && basis === o.value ? true : undefined}
                    onChange={() => (setBasis(o.value), setTouched((t) => ({ ...t, consent_basis: true })), edited("consent_basis"))}
                  />
                  <span className="vf-choice-text">
                    <span className="vf-choice-label">{o.label}</span>
                    {blocked ? <span className="vf-choice-explain">Not for calls or texts.</span> : basis === o.value ? <span className="vf-choice-explain">{o.explain}</span> : null}
                  </span>
                </label>
              );
            })}
          </div>
          {basisError ? (
            <p className="field-error" id="vf-basis-err">
              {basisError}
            </p>
          ) : null}
        </fieldset>

        <Field label="Note" optional hint={'Who agreed, how and when. "Maria, the owner, by phone on Oct 20"'} error={errorFor("note")}>
          <textarea rows={3} maxLength={300} value={note} onBlur={touch("note")} onChange={(e) => (setNote(e.target.value), edited("note"))} />
        </Field>

        <div className="vf-attest">
          <label className={`vf-check${attestError ? " is-invalid" : ""}`}>
            <input type="checkbox" checked={attested} aria-invalid={attestError ? true : undefined} aria-describedby={attestError ? "vf-attest-err" : undefined} onChange={(e) => (setAttested(e.target.checked), edited("attested"))} />
            <span>{ATTESTATION}</span>
          </label>
          {attestError ? (
            <p className="field-error" id="vf-attest-err">
              {attestError}
            </p>
          ) : null}
        </div>

        {failure ? (
          <p className="note note-risk" role="alert">
            {failure.message} <span className="fix">{failure.fix}</span>
          </p>
        ) : null}
      </div>

      <div className="vf-foot">
        <Button type="submit" variant="primary" pending={pending}>
          {pending ? "Adding…" : "Add vendor"}
        </Button>
        <Button variant="quiet" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <span className="vf-left">
          <span className="num">{left}</span> more today
        </span>
      </div>
    </form>
  );
}
