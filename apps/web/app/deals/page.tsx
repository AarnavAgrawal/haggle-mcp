import { HaggleError } from "@/lib/haggle";
import { requireHaggle } from "@/lib/workspace";

type DealRow = { job_id: string; what: string; state: string; date?: string; area?: string; quantity?: number; unit?: string; created_at?: string };
type Deals = { mode: "mock" | "live"; deals: DealRow[]; next: string };

const STATE_WORDS: Record<string, string> = {
  created: "Starting", contacting: "Contacting businesses", collecting: "Collecting quotes", negotiating: "Negotiating",
  awaiting_approval: "Waiting for your approval", paying: "Approved", paid: "Paid", confirmed: "Confirmed", cancelled: "Cancelled", failed: "Stopped",
};

/** The workspace's deals, read through the MCP server (list_deals). The full dashboard builds on this. */
export default async function DealsPage() {
  const { user, haggle } = await requireHaggle();
  let deals: Deals | null = null;
  let error: string | null = null;
  try {
    deals = (await haggle.callTool<Deals>("list_deals", { limit: 20 })).data;
  } catch (err) {
    error = err instanceof HaggleError ? `${err.message} ${err.fix}`.trim() : "The Haggle server couldn't be reached.";
  }

  return (
    <>
      <header className="topbar">
        <a className="brand" href="/deals">
          Haggle
        </a>
        <form action="/auth/sign-out" method="post" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="muted">{user.email}</span>
          <button className="btn" type="submit">
            Sign out
          </button>
        </form>
      </header>
      <main className="shell stack">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h1>Your deals</h1>
          {deals?.mode === "mock" && <span className="chip demo">DEMO data</span>}
        </div>
        {error ? (
          <p className="note note-risk" role="alert">
            {error}
          </p>
        ) : deals && deals.deals.length ? (
          <ul className="card deals">
            {deals.deals.map((d) => (
              <li key={d.job_id} className="deal">
                <div>
                  <strong>{d.what}</strong>
                  <div className="muted">{[d.quantity ? `${d.quantity} ${d.unit ?? "people"}` : null, d.date, d.area].filter(Boolean).join(" · ")}</div>
                </div>
                <span className="chip">{STATE_WORDS[d.state] ?? d.state}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="card muted">No deals yet. Chat with Haggle to start one.</p>
        )}
      </main>
    </>
  );
}
