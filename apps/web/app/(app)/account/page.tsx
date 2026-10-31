// /account: who you're signed in as and your workspace, "Download my data", and, in its own bordered
// area at the end, "Delete my account".
import { Footer } from "@/components/Footer";
import type { IdentityView } from "@/lib/dashboard/types";
import { requireHaggle } from "@/lib/workspace";
import { DeleteAccount } from "./DeleteAccount";
import "../settings/settings.css";
import "./account.css";

export const dynamic = "force-dynamic";

const OPEN = (state: string) => !["paid", "confirmed", "cancelled", "failed"].includes(state);

export default async function AccountPage() {
  const { user, haggle } = await requireHaggle();
  // Both best effort, in parallel: open deals are cancelled when the account is deleted (say how many
  // up front), and the workspace's name reads better than its id.
  const [openDeals, workspaceName] = await Promise.all([
    haggle
      .callTool<{ deals: { state: string }[] }>("list_deals", { limit: 20 })
      .then(({ data }) => (data.deals ?? []).filter((d) => OPEN(d.state)).length)
      .catch(() => null),
    haggle
      .callTool<IdentityView>("get_identity", {})
      .then(({ data }) => data.workspace.name)
      .catch(() => null),
  ]);

  return (
    <>
      <main className="shell set-page">
        <header className="set-head">
          <h1>Account</h1>
        </header>

        <div className="ui-sheet set-sheet">
          <section className="set-group" aria-labelledby="acct-you">
            <h2 id="acct-you">You</h2>
            <dl className="set-dl">
              <div>
                <dt>Signed in as</dt>
                <dd>{user.email ?? <span className="set-none">{user.is_anonymous ? "Guest, trying the demo" : "No email"}</span>}</dd>
              </div>
              {workspaceName ? (
                <div>
                  <dt>Workspace</dt>
                  <dd>{workspaceName}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="set-group" aria-labelledby="acct-data">
            <h2 id="acct-data">Your data</h2>
            <div className="acct-row">
              <p className="acct-text">A JSON file of your chats with Haggle and your workspace&apos;s recent deals: requests, quotes, status and what businesses replied.</p>
              <a className="btn" href="/api/account/export" download>
                Download my data
              </a>
            </div>
          </section>
        </div>

        <section className="acct-danger" aria-labelledby="acct-del">
          <h2 id="acct-del">Delete my account</h2>
          <p className="acct-text">
            This cancels your open deals (businesses that were contacted are told the request is withdrawn), turns off your workspace so nothing more can be sent or
            approved from it, deletes your chats and signs you out for good. It can&apos;t be undone.
          </p>
          {openDeals ? (
            <p className="acct-open">
              You have <span className="num">{openDeals}</span> open deal{openDeals === 1 ? "" : "s"}. {openDeals === 1 ? "It" : "They"} will be cancelled. A booking a business
              already confirmed can only be cancelled by your approver; contact that business directly.
            </p>
          ) : null}
          <DeleteAccount />
        </section>
      </main>
      <Footer />
    </>
  );
}
