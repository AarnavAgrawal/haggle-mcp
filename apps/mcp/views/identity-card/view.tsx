/**
 * Identity card (get_identity): who Haggle is to businesses (name, email, phone), which channels
 * work on this server, who approves (masked) and the spending cap. Renders only Identity fields.
 */
import { ModelContext, useToolContext } from "mcp-use/react";
import { useEffect, useState } from "react";
import type { Identity } from "@haggle/core";
import { DemoTag, ErrorNote, Shell, Skeleton, copyText, usd } from "../_shared/ui.tsx";
import { callHoursText } from "../_shared/format.ts";
import "./view.css";

const CHANNELS: { key: keyof Identity["channels"]; label: string; hint: string }[] = [
  { key: "email", label: "Email", hint: "Quotes and replies by email" },
  { key: "phone", label: "Voice calls", hint: "Voice AI calls to phone-only businesses" },
  { key: "a2a", label: "A2A", hint: "Agent-to-agent tasks with agent-ready businesses" },
  { key: "imessage_approvals", label: "iMessage approvals", hint: "The approver replies YES on iMessage" },
];

export default function IdentityCardView() {
  const ctx = useToolContext<"get_identity">();
  if (ctx.status !== "ready") {
    return (
      <Shell>
        {ctx.status === "error" ? <ErrorNote title="Couldn't load Haggle's identity." detail={ctx.error.message} /> : <Skeleton rows={4} />}
      </Shell>
    );
  }
  return (
    <Shell>
      <Card id={ctx.toolOutput as Identity} />
    </Shell>
  );
}

function Card({ id }: { id: Identity }) {
  const ready = CHANNELS.filter((c) => id.channels[c.key] === "ready").map((c) => c.label);
  return (
    <div className="ic">
      <ModelContext
        content={`Haggle identity card: ${id.identity_name} <${id.email}>${id.phone ? ` ${id.phone}` : ""}; channels ready: ${ready.join(", ") || "none"}; cap ${usd(id.spend_cap_usd)}.`}
      />
      <header className="ic-head">
        <div className="ic-title">
          <p className="hg-muted ic-kicker">How businesses see Haggle</p>
          <h1>{id.identity_name}</h1>
        </div>
        <DemoTag mode={id.mode} />
      </header>

      <ul className="ic-contacts" aria-label="Haggle's contact details">
        <Contact label="Email" value={id.email} />
        <Contact label="Phone" value={id.phone} empty="No phone number" />
      </ul>

      <section className="ic-section">
        <h2>Channels</h2>
        <ul className="ic-channels">
          {CHANNELS.map((c) => {
            const on = id.channels[c.key] === "ready";
            return (
              <li key={c.key} className={`ic-ch${on ? " is-ready" : " is-off"}`} title={c.hint}>
                <span className="ic-dot" aria-hidden="true" />
                <span className="ic-ch-label">{c.label}</span>
                <span className="ic-ch-state">{on ? "Ready" : "Off"}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <dl className="ic-facts">
        <div>
          <dt>Approver phone</dt>
          <dd className={id.approver.phone ? "" : "ic-unset"}>{id.approver.phone ?? "Not set"}</dd>
        </div>
        <div>
          <dt>Approver email</dt>
          <dd className={id.approver.email ? "" : "ic-unset"}>{id.approver.email ?? "Not set"}</dd>
        </div>
        <div>
          <dt>Spending cap</dt>
          <dd>{usd(id.spend_cap_usd)}</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>
            {id.workspace.name}
            <span className="ic-sub">{id.workspace.timezone}</span>
          </dd>
        </div>
        {id.call_hours && (
          <div>
            <dt>Call hours</dt>
            <dd>
              {callHoursText(id.call_hours)}
              <span className="ic-sub">local time</span>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function Contact({ label, value, empty }: { label: string; value: string | null; empty?: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <li className="ic-contact">
      <span className="ic-contact-label">{label}</span>
      {value ? (
        <>
          <span className="ic-contact-value">{value}</span>
          <button
            className="hg-btn hg-btn-quiet ic-copy"
            onClick={() => void copyText(value).then((ok) => setCopied(ok ? "yes" : "no"))}
            aria-label={`Copy ${label.toLowerCase()}`}
          >
            {copied === "yes" ? "Copied" : copied === "no" ? "Select to copy" : "Copy"}
          </button>
        </>
      ) : (
        <span className="ic-contact-value ic-unset">{empty ?? "Not set"}</span>
      )}
    </li>
  );
}
