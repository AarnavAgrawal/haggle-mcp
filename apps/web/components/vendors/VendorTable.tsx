"use client";
// This workspace's vendors as a compact table: name, how Haggle reaches it, the contact, the consent it
// rests on and today's hours. Each row expands in place (the recorded consent, when it was added, the
// week's hours) and has Remove, which asks first in the row itself. Everything shown is plain text.
import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Icon, channelIcon } from "@/components/ui/Icon";
import { Status } from "@/components/ui/Status";
import { basisLabel, channelLabel, consentParts, displayContact, hoursToday } from "@/lib/vendors/present";
import type { VendorView } from "@/lib/vendors/types";
import { vendorApi, type VendorApiError } from "./api";

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const SUPPRESSED = { opt_out: "Asked not to be contacted", bounce: "Email bounced" } as const;

export function VendorTable({ vendors, fresh, onRemoved }: { vendors: VendorView[]; fresh: string | null; onRemoved: (v: VendorView) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="ui-sheet ui-sheet-pad-none vend-table-wrap">
      <table className="vend-table">
        <thead>
          <tr>
            <th scope="col">Business</th>
            <th scope="col" className="vt-wide">Reached at</th>
            <th scope="col" className="vt-mid">How they agreed</th>
            <th scope="col" className="vt-mid">Open today</th>
            <th scope="col" className="vt-actions">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {vendors.map((v) => (
            <VendorRow key={v.contact} v={v} fresh={fresh === v.contact} expanded={open === v.contact} onToggle={() => setOpen((o) => (o === v.contact ? null : v.contact))} onRemoved={onRemoved} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VendorRow({ v, fresh, expanded, onToggle, onRemoved }: { v: VendorView; fresh: boolean; expanded: boolean; onToggle: () => void; onRemoved: (v: VendorView) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<VendorApiError | null>(null);
  const [pending, start] = useTransition();
  const keepRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const detailsId = `vd-${v.contact.replace(/[^a-zA-Z0-9]/g, "")}`;
  // Today's hours depend on the viewer's day: computed after hydration so server and browser agree.
  const [today, setToday] = useState<string | null | undefined>(undefined);
  useEffect(() => setToday(hoursToday(v.hours)), [v.hours]);

  // Focus follows the confirmation: into it ("Keep", the safe choice) and back to Remove after.
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) removeRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const remove = () =>
    start(async () => {
      setFailure(null);
      const r = await vendorApi<{ next: string }>("/api/vendors/remove", { contact: v.contact });
      if (!r.ok) {
        setFailure(r.error);
        setConfirming(false);
        return;
      }
      onRemoved(v);
    });

  const contact = displayContact(v.contact);
  const added = day(v.added_at);
  const consent = consentParts(v.consent.text);
  return (
    <Fragment>
      <tr className={`vt-row${fresh ? " vt-fresh" : ""}${expanded ? " vt-open" : ""}`}>
        <th scope="row" className="vt-name">
          <button type="button" className="vt-toggle" data-vendor={v.contact} aria-expanded={expanded} aria-controls={detailsId} onClick={onToggle}>
            <Icon name="chevron-right" className="vt-chev" />
            <span className="vt-name-text">{v.name}</span>
          </button>
          <span className="vt-sub vt-narrow">
            <Icon name={channelIcon(v.channel)} label={channelLabel(v.channel)} />
            <span className="vt-contact-text">{contact}</span>
          </span>
          {v.suppressed ? <Status tone="risk" className="vt-supp">{SUPPRESSED[v.suppressed]}</Status> : null}
        </th>
        <td className="vt-wide vt-contact" title={`${channelLabel(v.channel)}: ${v.contact}`}>
          <span className="vt-channel">
            <Icon name={channelIcon(v.channel)} label={channelLabel(v.channel)} />
            <span className="vt-contact-text">{contact}</span>
          </span>
        </td>
        <td className="vt-mid vt-basis">{basisLabel(v.consent.basis)}</td>
        <td className="vt-mid vt-hours" suppressHydrationWarning>
          {today ? <span className={today === "Closed today" ? "vt-closed" : undefined}>{today === "Closed today" ? "Closed" : today}</span> : <span className="vt-unknown">{today === undefined && v.hours?.length ? "" : "Not listed"}</span>}
        </td>
        <td className="vt-actions">
          {confirming ? (
            <span className="vt-confirm" role="group" aria-label={`Remove ${v.name}?`} onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}>
              <Button ref={keepRef} variant="quiet" size="s" disabled={pending} onClick={() => setConfirming(false)}>
                Keep
              </Button>
              <Button variant="danger" size="s" pending={pending} onClick={remove}>
                Remove
              </Button>
            </span>
          ) : (
            <Button
              ref={removeRef}
              variant="quiet"
              size="s"
              className="vt-remove"
              aria-label={`Remove ${v.name}`}
              onClick={() => {
                setFailure(null);
                setConfirming(true);
              }}
            >
              Remove
            </Button>
          )}
        </td>
      </tr>
      {failure ? (
        <tr className="vt-fail">
          <td colSpan={5}>
            <p className="note note-risk" role="alert">
              {failure.message} <span className="fix">{failure.fix}</span>
            </p>
          </td>
        </tr>
      ) : null}
      <tr className="vt-details" id={detailsId} hidden={!expanded}>
        <td colSpan={5}>
          <dl className="vt-dl">
            <div className="vt-narrow-only">
              <dt>How they agreed</dt>
              <dd>{basisLabel(v.consent.basis)}</dd>
            </div>
            {consent.raw ? (
              <div>
                <dt>Consent on record</dt>
                <dd className="vt-consent">{consent.raw}</dd>
              </div>
            ) : null}
            {consent.note ? (
              <div>
                <dt>Note</dt>
                <dd className="vt-consent">{consent.note}</dd>
              </div>
            ) : null}
            <div>
              <dt>Reached by</dt>
              <dd>
                {channelLabel(v.channel)} at {contact}
              </dd>
            </div>
            {added ? (
              <div>
                <dt>Added</dt>
                <dd>{added}</dd>
              </div>
            ) : null}
            <div>
              <dt>Opening hours</dt>
              <dd>{v.hours?.length ? <span className="vt-week">{v.hours.map((h) => <span key={h}>{h}</span>)}</span> : "Not listed"}</dd>
            </div>
          </dl>
        </td>
      </tr>
    </Fragment>
  );
}
