import Link from "next/link";
import { supportEmail } from "@/lib/account/legal";
import "./footer.css";

/** Site footer: the legal pages and the support address (NEXT_PUBLIC_SUPPORT_EMAIL). No hooks: usable from server and client pages. */
export function Footer() {
  const email = supportEmail();
  return (
    <footer className="site-footer">
      <div className="wrap site-footer-inner">
        <nav aria-label="Legal">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/acceptable-use">Acceptable use</Link>
          {email ? <a href={`mailto:${email}`}>{email}</a> : null}
        </nav>
        <p>Every Haggle call says it is an AI assistant.</p>
      </div>
    </footer>
  );
}
