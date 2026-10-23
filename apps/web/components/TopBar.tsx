import Link from "next/link";
import { DemoBanner } from "@/components/DemoBanner";

/** App navigation for signed-in pages: deals, a new request (chat), and sign-out. */
export function TopBar({ email, active }: { email?: string | null; active?: "deals" | "chat" | "vendors" | "settings" | "account" }) {
  const item = (href: string, label: string, key: typeof active) => (
    <Link href={href} className="navlink" aria-current={active === key ? "page" : undefined}>
      {label}
    </Link>
  );
  return (
    <>
    <DemoBanner />
    <header className="topbar">
      <nav style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Link className="brand" href="/deals">
          Haggle
        </Link>
        {item("/chat", "New request", "chat")}
        {item("/deals", "Deals", "deals")}
        {item("/vendors", "Vendors", "vendors")}
        {item("/settings", "Settings", "settings")}
      </nav>
      <form action="/auth/sign-out" method="post" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {email && <span className="muted">{email}</span>}
        <button className="btn" type="submit">
          Sign out
        </button>
      </form>
    </header>
    </>
  );
}
