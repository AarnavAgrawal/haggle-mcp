// /account: who you're signed in as, your workspace, "Download my data" and "Delete my account".
import { Footer } from "@/components/Footer";
import { TopBar } from "@/components/TopBar";
import { requireHaggle } from "@/lib/workspace";
import { DeleteAccount } from "./DeleteAccount";
import "./account.css";

export const dynamic = "force-dynamic";

const OPEN = (state: string) => !["paid", "confirmed", "cancelled", "failed"].includes(state);

export default async function AccountPage() {
  const { user, workspaceId, haggle } = await requireHaggle();
  // Open deals are cancelled when the account is deleted; say how many up front (best effort).
  let openDeals: number | null = null;
  try {
    const { data } = await haggle.callTool<{ deals: { state: string }[] }>("list_deals", { limit: 20 });
    openDeals = (data.deals ?? []).filter((d) => OPEN(d.state)).length;
  } catch {
    openDeals = null;
  }
  return (
    <>
      <TopBar email={user.email} active="account" />
      <main className="shell stack acct">
        <header className="page-head">
          <h1>Account</h1>
        </header>
        <section className="card stack">
          <h2>Your account</h2>
          <dl className="acct-facts">
            <dt>Signed in as</dt>
            <dd>{user.email ?? (user.is_anonymous ? "Guest (demo)" : "No email")}</dd>
            <dt>Workspace</dt>
            <dd>
              <code>{workspaceId}</code>
            </dd>
          </dl>
        </section>
        <section className="card stack">
          <h2>Download my data</h2>
          <p className="muted">A JSON file with your chats with Haggle and your workspace's recent deals: requests, quotes, status and what businesses replied.</p>
          <a className="btn" href="/api/account/export" download>
            Download my data
          </a>
        </section>
        <section className="card stack acct-danger">
          <h2>Delete my account</h2>
          <p>
            This cancels your open deals (businesses that were contacted are told the request is withdrawn), turns off your workspace so nothing more can be sent
            or approved from it, deletes your chats and signs you out for good. It can't be undone.
          </p>
          {openDeals ? (
            <p className="note note-risk">
              You have {openDeals} open deal{openDeals === 1 ? "" : "s"}. {openDeals === 1 ? "It" : "They"} will be cancelled. A booking a business already
              confirmed can only be cancelled by your approver; contact that business directly.
            </p>
          ) : null}
          <DeleteAccount />
        </section>
      </main>
      <Footer />
    </>
  );
}
