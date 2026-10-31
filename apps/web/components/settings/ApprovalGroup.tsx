"use client";
// "Approval and spending": the approver phone and email and the default limit for new deals. A new
// approver phone or email is not applied on Save: it shows as pending verification with a code input
// until confirmed (PendingApprover). The demo code from a mock server is kept here for that panel.
import { useState } from "react";
import { Price } from "@/components/ui/Price";
import type { WorkspaceSettings } from "@/lib/settings/types";
import { EditableGroup } from "./EditableGroup";
import { PendingApprover } from "./PendingApprover";

export function ApprovalGroup({ s, canEdit }: { s: WorkspaceSettings; canEdit: boolean }) {
  const [demo, setDemo] = useState<Record<string, string>>({});
  const none = <span className="set-none">Not set</span>;
  return (
    <EditableGroup
      id="set-ap"
      title="Approval and spending"
      canEdit={canEdit}
      onSaved={(r) => setDemo((d) => ({ ...d, ...Object.fromEntries((r.demo_codes ?? []).map((c) => [c.kind, c.code])) }))}
      note={canEdit
        ? "Nothing is paid without the approver's yes, and never above the limit. A new approver gets a code and takes over once it is confirmed."
        : "Nothing is paid without the approver's yes, and never above the limit. Only the workspace's owner can change these."}
      rows={[
        {
          label: "Approver phone", view: s.approver.phone ?? none,
          edit: { field: "approver_phone", value: "", inputMode: "tel", autoComplete: "tel", placeholder: "+1 415 555 0123", hint: s.approver.phone ? `Now ${s.approver.phone}. Leave empty to keep it.` : "Gets approval texts. We text it a code first." },
        },
        {
          label: "Approver email", view: s.approver.email ?? none,
          edit: { field: "approver_email", value: "", inputMode: "email", autoComplete: "email", placeholder: "you@company.com", hint: s.approver.email ? `Now ${s.approver.email}. Leave empty to keep it.` : "Gets approval emails and receipts. We email it a confirm link first." },
        },
        {
          label: "Default limit for new deals", view: <><Price amount={s.default_deal_limit_usd} size="m" /> <span className="set-sub">for deals with no budget</span></>,
          edit: { field: "default_deal_limit_usd", value: String(s.default_deal_limit_usd), inputMode: "decimal", hint: `The most Haggle may pay on a deal. Up to $${s.ceiling_usd.toLocaleString("en-US")} on this server.` },
        },
      ]}
    >
      {s.pending.length ? (
        <div className="set-pending-list">
          {s.pending.map((p) => (
            <PendingApprover key={p.kind} p={p} demoCode={demo[p.kind] ?? null} />
          ))}
        </div>
      ) : null}
    </EditableGroup>
  );
}
