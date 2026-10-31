"use client";
// "Add vendor": name, email or phone, channel, how the business agreed (plain-language choices), an
// optional note and a required attestation. The same rules run again on this app's server and on the
// MCP server: a business found only in a public listing may be emailed, never called or texted.
import { useEffect, useRef, useState } from "react";
import { ATTESTATION, basisAllows, CHANNEL_OPTIONS, CONSENT_OPTIONS, normalizeContact, validateVendorForm, type ConsentBasis, type FormField, type VendorChannel } from "@/lib/vendors/form";
import { vendorApi, type VendorApiError } from "./api";

export interface VendorPrefill {
  key: number;
  name: string;
  /** An address the business publishes on its own website, when one was found. */
  contact?: string;
  note?: string;
  consent_basis?: ConsentBasis;
}

export function AddVendorForm({ prefill, onAdded }: { prefill: VendorPrefill | null; onAdded: (message: string) => void }) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [channel, setChannel] = useState<VendorChannel | "">("");
  const [basis, setBasis] = useState<ConsentBasis | "">("");
  const [note, setNote] = useState("");
  const [attested, setAttested] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<FormField, string>>>({});
  const [failure, setFailure] = useState<VendorApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const contactRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!prefill) return;
    setName(prefill.name);
    setContact(prefill.contact ?? "");
    setChannel("email");
    setBasis(prefill.consent_basis ?? "");
    setNote(prefill.note ?? "");
    setAttested(false);
    setErrors({});
    setFailure(null);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    contactRef.current?.focus({ preventScroll: true });
  }, [prefill]);

  const kind = normalizeContact(contact)?.kind ?? (contact.includes("@") ? "email" : null);
  const effective: VendorChannel | "" = kind === "email" ? "email" : kind === "phone" && channel === "email" ? "phone" : channel;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFailure(null);
    const input = { name, contact, channel: effective || undefined, consent_basis: basis || undefined, note, attested };
    const v = validateVendorForm(input);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    const r = await vendorApi<{ vendor: { name: string }; next: string }>("/api/vendors", { ...input });
    setBusy(false);
    if (!r.ok) {
      if (r.fields) setErrors(r.fields as Partial<Record<FormField, string>>);
      setFailure(r.error);
      return;
    }
    setName("");
    setContact("");
    setChannel("");
    setBasis("");
    setNote("");
    setAttested(false);
    onAdded(r.next);
  }

  const err = (f: FormField) => (errors[f] ? <p className="vend-err" id={`vf-${f}-err`}>{errors[f]}</p> : null);
  const described = (f: FormField, hint?: string) => [errors[f] ? `vf-${f}-err` : null, hint ?? null].filter(Boolean).join(" ") || undefined;

  return (
    <section className="section" aria-labelledby="add-h">
    <div className="section-head">
      <h2 id="add-h">Add a vendor</h2>
      <p>Haggle contacts only the businesses you add, on the channel and basis you record. A business that asks Haggle to stop is never contacted again.</p>
    </div>
    <form ref={formRef} className="vend-form" onSubmit={submit} noValidate aria-labelledby="add-h">
      <div className="vend-grid">
        <div>
          <label htmlFor="vf-name">Business name</label>
          <input id="vf-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} aria-describedby={described("name")} autoComplete="organization" />
          {err("name")}
        </div>
        <div>
          <label htmlFor="vf-contact">
            Email or phone <span className="hint">phone with country code, e.g. +1 415 555 0123</span>
          </label>
          <input ref={contactRef} id="vf-contact" value={contact} maxLength={254} onChange={(e) => setContact(e.target.value)} aria-invalid={!!errors.contact} aria-describedby={described("contact")} inputMode="email" autoComplete="off" />
          {err("contact")}
        </div>
      </div>

      <div>
        <label htmlFor="vf-channel">How Haggle reaches them</label>
        <select id="vf-channel" className="vend-select" value={effective} onChange={(e) => setChannel(e.target.value as VendorChannel)} disabled={kind === "email"} aria-invalid={!!errors.channel} aria-describedby={described("channel")}>
          {!effective ? <option value="">{kind ? "Choose a call or a text" : "Enter the email or phone first"}</option> : null}
          {CHANNEL_OPTIONS.filter((o) => !kind || (kind === "email") === (o.value === "email")).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {err("channel")}
      </div>

      <fieldset className="vend-fieldset" aria-describedby={described("consent_basis")}>
        <legend>How did this business agree to be contacted?</legend>
        {CONSENT_OPTIONS.map((o) => {
          const blocked = !!effective && !basisAllows(o.value, effective);
          return (
            <label key={o.value} className={`vend-radio${blocked ? " vend-radio-off" : ""}`}>
              <input type="radio" name="consent_basis" value={o.value} checked={basis === o.value} onChange={() => setBasis(o.value)} disabled={blocked} />
              <span>
                <strong>{o.label}</strong>
                <span className="hint vend-explain">
                  {o.explain}
                  {blocked ? " Not available for calls or texts." : ""}
                </span>
              </span>
            </label>
          );
        })}
        {err("consent_basis")}
      </fieldset>

      <div>
        <label htmlFor="vf-note">
          Note <span className="hint">optional: who agreed, how and when (e.g. &quot;Maria, the owner, by phone on Oct 20&quot;)</span>
        </label>
        <textarea id="vf-note" className="vend-textarea" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby={described("note")} />
        {err("note")}
      </div>

      <div>
        <label className="vend-check">
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} aria-invalid={!!errors.attested} aria-describedby={described("attested")} />
          <span>{ATTESTATION}</span>
        </label>
        {err("attested")}
      </div>

      {failure ? (
        <p className="note note-risk" role="alert">
          {failure.message} <span className="fix">{failure.fix}</span>
        </p>
      ) : null}
      <div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add vendor"}
        </button>
      </div>
    </form>
    </section>
  );
}
