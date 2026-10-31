// /settings: who Haggle is to businesses and how this workspace is set up (get_identity), as one
// sheet of definition lists. Read-only: the operator changes the approver or raises the cap (CLAUDE.md §7).
import { RetryButton } from "@/components/shell/RetryButton";
import { Price } from "@/components/ui/Price";
import { Status } from "@/components/ui/Status";
import type { IdentityView } from "@/lib/dashboard/types";
import { HaggleError } from "@/lib/haggle";
import { requireHaggle } from "@/lib/workspace";
import "./settings.css";

export const dynamic = "force-dynamic";

const CHANNEL_ROWS: { key: keyof IdentityView["channels"]; label: string }[] = [
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone calls" },
  { key: "imessage_approvals", label: "Text approvals" },
  { key: "a2a", label: "Agent to agent" },
];

const hour = (h: number) => `${((h + 11) % 12) + 1} ${h % 24 < 12 ? "AM" : "PM"}`;

export default async function SettingsPage() {
  const { haggle } = await requireHaggle();
  let id: IdentityView | null = null;
  let error: { message: string; fix: string } | null = null;
  try {
    id = (await haggle.callTool<IdentityView>("get_identity", {})).data;
  } catch (err) {
    error = err instanceof HaggleError ? { message: err.message, fix: err.fix } : { message: "The Haggle server couldn't be reached.", fix: "Try again in a moment." };
  }

  return (
    <main className="shell set-page">
      <header className="set-head">
        <h1>Settings</h1>
      </header>
      {!id ? (
        <div className="ui-sheet set-error" role="alert">
          <p>
            <strong>Settings couldn&apos;t be loaded.</strong> {error?.message} {error?.fix}
          </p>
          <RetryButton />
        </div>
      ) : (
        <div className="ui-sheet set-sheet">
          <section className="set-group" aria-labelledby="set-who">
            <h2 id="set-who">How businesses see Haggle</h2>
            <dl className="set-dl">
              <div>
                <dt>Name</dt>
                <dd>{id.identity_name}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{id.email}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>{id.phone ?? <span className="set-none">No number</span>}</dd>
              </div>
            </dl>
          </section>

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
                          Calls between {hour(id.call_hours.start)} and {hour(id.call_hours.end)}, {id.workspace.timezone}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>

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
                <dt>Spending cap</dt>
                <dd>
                  <Price amount={id.spend_cap_usd} size="m" /> <span className="set-sub">per payment</span>
                </dd>
              </div>
            </dl>
            <p className="set-note">Nothing is paid without the approver&apos;s yes, and never above the cap. To change either, ask whoever runs this Haggle workspace.</p>
          </section>

          <section className="set-group" aria-labelledby="set-ws">
            <h2 id="set-ws">Workspace</h2>
            <dl className="set-dl">
              <div>
                <dt>Name</dt>
                <dd>{id.workspace.name}</dd>
              </div>
              <div>
                <dt>Time zone</dt>
                <dd>{id.workspace.timezone}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{id.mode === "mock" ? "Demo, with simulated businesses" : "Live"}</dd>
              </div>
            </dl>
          </section>
        </div>
      )}
    </main>
  );
}
