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
        <div className="wrap topbar-inner">
          <Link className="brand" href="/deals">
            Haggle
          </Link>
          <nav className="nav" aria-label="Main">
            {item("/chat", "New request", "chat")}
            {item("/deals", "Deals", "deals")}
            {item("/vendors", "Vendors", "vendors")}
            {item("/settings", "Settings", "settings")}
            {item("/account", "Account", "account")}
          </nav>
          <form className="topbar-user" action="/auth/sign-out" method="post">
            {email && (
              <span className="topbar-email" title={email}>
                {email}
              </span>
            )}
            <button className="btn btn-quiet" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
    </>
  );
}
