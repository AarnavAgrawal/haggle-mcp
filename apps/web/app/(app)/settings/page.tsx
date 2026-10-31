// /settings: who Haggle is to businesses and how this workspace is set up (get_identity plus the
// owner's settings, GET /internal/workspaces/settings), as one sheet of definition lists. The workspace's
// owner (signed in with an email, not a guest) gets an Edit button per group; a new approver waits for
// its code (components/settings). Everyone else reads. Approver contacts are always shown masked.
import { ApprovalGroup } from "@/components/settings/ApprovalGroup";
import { EditableGroup } from "@/components/settings/EditableGroup";
import { ConfirmLink } from "@/components/settings/PendingApprover";
import { RetryButton } from "@/components/shell/RetryButton";
import { Price } from "@/components/ui/Price";
import { Status } from "@/components/ui/Status";
import type { IdentityView } from "@/lib/dashboard/types";
import { callService, HaggleError } from "@/lib/haggle";
import type { WorkspaceSettings } from "@/lib/settings/types";
import { vendorServiceConfig } from "@/lib/vendors/deps";
import { membership, requireHaggle } from "@/lib/workspace";
import "./settings.css";

export const dynamic = "force-dynamic";

const CHANNEL_ROWS: { key: keyof IdentityView["channels"]; label: string }[] = [
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone calls" },
  { key: "imessage_approvals", label: "Text approvals" },
  { key: "a2a", label: "Agent to agent" },
];
const TIMEZONES = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];

const hour = (h: number) => `${((h + 11) % 12) + 1} ${h % 24 < 12 ? "AM" : "PM"}`;
const failure = (err: unknown) => (err instanceof HaggleError ? { message: err.message, fix: err.fix } : { message: "The Haggle server couldn't be reached.", fix: "Try again in a moment." });

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, workspaceId, haggle } = await requireHaggle();
  const q = await searchParams;
  const confirmToken = typeof q.confirm === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(q.confirm) ? q.confirm : null;
  let id: IdentityView | null = null;
  let s: WorkspaceSettings | null = null;
  let error: { message: string; fix: string } | null = null;
  const [idR, sR, m] = await Promise.allSettled([
    haggle.callTool<IdentityView>("get_identity", {}),
    callService<{ settings: WorkspaceSettings }>(vendorServiceConfig(), "/internal/workspaces/settings", { workspaceId }),
    membership(user.id),
  ]);
  if (idR.status === "fulfilled") id = idR.value.data;
  else error = failure(idR.reason);
  if (sR.status === "fulfilled") s = sR.value.settings;
  const canEdit = Boolean(s) && !user.is_anonymous && m.status === "fulfilled" && m.value?.role === "owner";

  return (
    <main className="shell set-page">
      <header className="set-head">
        <h1>Settings</h1>
      </header>
      {confirmToken && canEdit ? <ConfirmLink token={confirmToken} /> : null}
      {!id ? (
        <div className="ui-sheet set-error" role="alert">
          <p>
            <strong>Settings couldn&apos;t be loaded.</strong> {error?.message} {error?.fix}
          </p>
          <RetryButton />
        </div>
      ) : (
        <div className="ui-sheet set-sheet">
          <EditableGroup
            id="set-who"
            title="How businesses see Haggle"
            canEdit={canEdit}
            rows={[
              {
                label: "Sender name",
                view: s?.sender_name ?? <span className="set-none">{s ? s.name : "Not set"}</span>,
                ...(s ? { edit: { field: "sender_name" as const, value: s.sender_name ?? "", optional: true, placeholder: "Priya at Acme Labs", hint: "The name on Haggle's emails. Empty uses the workspace name." } } : {}),
              },
              { label: "Name", view: id.identity_name },
              { label: "Email", view: id.email },
              { label: "Phone", view: id.phone ?? <span className="set-none">No number</span> },
            ]}
          />

          <section className="set-group" aria-labelledby="set-ch">
            <h2 id="set-ch">Channels</h2>
            <dl className="set-dl">
              {CHANNEL_ROWS.map((c) => {
                const ready = id.channels[c.key] === "ready";
                return (
                  <div key={c.key}>
                    <dt>{c.label}</dt>
                    <dd className="set-dd-stack">
                      <Status tone={ready ? "ok" : "idle"}>{ready ? "On" : "Off"}</Status>
                      {c.key === "phone" && ready && id.call_hours ? (
                        <span className="set-sub">
                          Calls between {hour(id.call_hours.start)} and {hour(id.call_hours.end)}, {s?.timezone ?? id.workspace.timezone}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>

          {s ? (
            <ApprovalGroup s={s} canEdit={canEdit} />
          ) : (
            <section className="set-group" aria-labelledby="set-ap">
              <h2 id="set-ap">Approval and spending</h2>
              <dl className="set-dl">
                <div>
                  <dt>Approver phone</dt>
                  <dd>{id.approver.phone ?? <span className="set-none">Not set</span>}</dd>
                </div>
                <div>
                  <dt>Approver email</dt>
                  <dd>{id.approver.email ?? <span className="set-none">Not set</span>}</dd>
                </div>
                <div>
                  <dt>Default limit for new deals</dt>
                  <dd>
                    <Price amount={id.spend_cap_usd} size="m" /> <span className="set-sub">for deals with no budget</span>
                  </dd>
                </div>
              </dl>
              <p className="set-note">Nothing is paid without the approver&apos;s yes, and never above the limit.</p>
            </section>
          )}

          <EditableGroup
            id="set-ws"
            title="Workspace"
            canEdit={canEdit}
            rows={[
              { label: "Name", view: s?.name ?? id.workspace.name, ...(s ? { edit: { field: "name" as const, value: s.name } } : {}) },
              { label: "Time zone", view: s?.timezone ?? id.workspace.timezone, ...(s ? { edit: { field: "timezone" as const, value: s.timezone, list: "set-timezones", hint: "Calls and texts follow it, e.g. America/New_York." } } : {}) },
              {
                label: "Default area",
                view: s?.default_area ?? <span className="set-none">Not set</span>,
                ...(s ? { edit: { field: "default_area" as const, value: s.default_area ?? "", optional: true, placeholder: "Oakland, CA", hint: "Used when a request doesn't say where." } } : {}),
              },
              { label: "Mode", view: id.mode === "mock" ? "Demo, with simulated businesses" : "Live" },
            ]}
          />
          <datalist id="set-timezones">
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </div>
      )}
    </main>
  );
}
