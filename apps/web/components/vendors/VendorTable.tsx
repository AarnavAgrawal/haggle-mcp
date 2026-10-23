"use client";
// This workspace's vendors: channel, the consent each rests on, who added it, and whether Haggle may
// contact it. Remove asks for a confirmation first. Everything shown is plain text.
import { useState } from "react";
import { CONSENT_OPTIONS } from "@/lib/vendors/form";
import type { VendorView } from "@/lib/vendors/types";
import { vendorApi, type VendorApiError } from "./api";

const CHANNEL_WORDS: Record<string, string> = { email: "Email", phone: "Phone call", imessage: "Text", a2a: "Agent (A2A)" };
const basisWords = (b: VendorView["consent"]["basis"]) => CONSENT_OPTIONS.find((o) => o.value === b)?.label ?? "Recorded by the operator";
const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export function VendorTable({ vendors, onChanged }: { vendors: VendorView[]; onChanged: (message: string) => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VendorApiError | null>(null);

  async function remove(v: VendorView) {
    setBusy(true);
    setFailure(null);
    const r = await vendorApi<{ next: string }>("/api/vendors/remove", { contact: v.contact });
    setBusy(false);
    setConfirming(null);
    if (!r.ok) setFailure(r.error);
    else onChanged(`${v.name} (${v.contact}) removed. ${r.next}`);
  }

  if (!vendors.length) {
    return (
      <p className="note" style={{ margin: 0 }}>
        No vendors yet. Add the businesses you buy from below, or find some with the search. Haggle contacts nobody until you do.
      </p>
    );
  }
  return (
    <>
      {failure ? (
        <p className="note note-risk" role="alert" style={{ margin: 0 }}>
          {failure.message} <span className="fix">{failure.fix}</span>
        </p>
      ) : null}
      <ul className="vend-list" aria-label="Vendors">
        {vendors.map((v) => {
          const key = v.contact;
          return (
            <li key={key} className="vend-item">
              <div className="vend-main">
                <div className="dash-row dash-wrap">
                  <strong>{v.name}</strong>
                  <span className="chip chip-plain">{CHANNEL_WORDS[v.channel] ?? v.channel}</span>
                  {v.suppressed ? (
                    <span className="chip chip-risk">{v.suppressed === "opt_out" ? "Asked not to be contacted" : "Address bounced"}</span>
                  ) : (
                    <span className="chip chip-win">Haggle may contact</span>
                  )}
                </div>
                <div className="vend-contact">{v.contact}</div>
                <div className="hint">
                  {basisWords(v.consent.basis)} · added {day(v.added_at)}
                </div>
                <details className="vend-consent">
                  <summary className="hint">Recorded consent</summary>
                  <p className="hint vend-consent-text">{v.consent.text}</p>
                </details>
              </div>
              <div className="vend-actions">
                {confirming === key ? (
                  <div className="dash-confirm" role="group" aria-label={`Remove ${v.name}?`}>
                    <span className="hint">Remove {v.name}? Haggle won&apos;t contact it on new deals.</span>
                    <div className="dash-row">
                      <button className="btn btn-danger" type="button" disabled={busy} onClick={() => remove(v)}>
                        {busy ? "Removing…" : "Remove"}
                      </button>
                      <button className="btn" type="button" disabled={busy} onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </div>
                  </div>
                ) : (
                  <button className="btn" type="button" onClick={() => { setFailure(null); setConfirming(key); }}>
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
