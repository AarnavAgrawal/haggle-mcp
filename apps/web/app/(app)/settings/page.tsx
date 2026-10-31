// /settings: who Haggle is to businesses and how this workspace is set up (get_identity). Read-only:
// the operator changes the approver or raises the cap (CLAUDE.md §7).
import { channelWords, money } from "@/lib/dashboard/format";
import type { IdentityView } from "@/lib/dashboard/types";
import { HaggleError } from "@/lib/haggle";
import { requireHaggle } from "@/lib/workspace";
import "@/components/dashboard/dashboard.css";

export const dynamic = "force-dynamic";

const CHANNEL_ROWS: { key: keyof IdentityView["channels"]; label: string }[] = [
  { key: "email", label: channelWords("email") },
  { key: "phone", label: "Voice AI calls" },
  { key: "a2a", label: channelWords("a2a") },
  { key: "imessage_approvals", label: "Text approvals (iMessage)" },
];

const hour = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? " AM" : " PM"}`;

export default async function SettingsPage() {
  const { haggle } = await requireHaggle();
  let id: IdentityView | null = null;
  let error: { message: string; fix: string } | null = null;
  try {
    id = (await haggle.callTool<IdentityView>("get_identity", {})).data;
  } catch (err) {
    error = err instanceof HaggleError ? { message: err.message, fix: err.fix } : { message: "The Haggle server couldn't be reached.", fix: "Reload the page in a moment." };
  }

  return (
    <>
      <main className="shell stack">
        <header className="page-head">
          <div>
            <div className="page-title">
              <h1>Settings</h1>
              {id?.mode === "mock" ? <span className="chip demo">DEMO data</span> : null}
            </div>
            <p>How businesses see Haggle, which channels are on, and who approves spending.</p>
          </div>
        </header>
        {!id ? (
          <p className="note note-risk" role="alert">
            {error?.message} <span className="fix">{error?.fix}</span>
          </p>
        ) : (
          <>
            <section className="card stack" aria-labelledby="who-h">
              <h2 id="who-h" className="dash-h2">
                How businesses see Haggle
              </h2>
              <dl className="dash-meta">
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
                  <dd>{id.phone ?? "none"}</dd>
                </div>
              </dl>
            </section>

            <section className="card stack" aria-labelledby="ch-h">
              <h2 id="ch-h" className="dash-h2">
                Channels
              </h2>
              <ul className="chips plain-list">
                {CHANNEL_ROWS.map((c) => {
                  const ready = id!.channels[c.key] === "ready";
                  return (
                    <li key={c.key}>
                      <span className={`chip ${ready ? "chip-win" : "chip-plain"}`}>
                        {c.label}: {ready ? "ready" : "off"}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {id.call_hours ? (
                <p className="hint">
                  Calls are placed between {hour(id.call_hours.start)} and {hour(id.call_hours.end)} ({id.workspace.timezone}).
                </p>
              ) : null}
            </section>

            <section className="card stack" aria-labelledby="ap-h">
              <h2 id="ap-h" className="dash-h2">
                Approval and spending
              </h2>
              <dl className="dash-meta">
                <div>
                  <dt>Approver phone</dt>
                  <dd>{id.approver.phone ?? "not set"}</dd>
                </div>
                <div>
                  <dt>Approver email</dt>
                  <dd>{id.approver.email ?? "not set"}</dd>
                </div>
                <div>
                  <dt>Spending cap per payment</dt>
                  <dd>{money(id.spend_cap_usd)}</dd>
                </div>
              </dl>
              <p className="note">
                Nothing is paid without the approver&apos;s yes, and never above the cap. To change the approver or raise the cap, ask the operator of this Haggle workspace.
              </p>
            </section>

            <section className="card stack" aria-labelledby="ws-h">
              <h2 id="ws-h" className="dash-h2">
                Workspace
              </h2>
              <dl className="dash-meta">
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
                  <dd>{id.mode === "mock" ? "Demo (simulated businesses, nothing real)" : "Live"}</dd>
                </div>
              </dl>
            </section>
          </>
        )}
      </main>
    </>
  );
}
