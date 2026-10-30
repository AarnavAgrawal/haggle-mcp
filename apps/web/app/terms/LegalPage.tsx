import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { LEGAL_DRAFT_NOTE, supportEmail, TERMS_VERSION } from "@/lib/account/legal";
import "./legal.css";

/** Shared frame for /terms, /privacy and /acceptable-use: the draft banner, title, version and footer. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <div className="wrap topbar-inner">
          <Link className="brand" href="/">
            Haggle
          </Link>
        </div>
      </header>
      <main className="shell legal">
        <p className="legal-draft" role="note">
          {LEGAL_DRAFT_NOTE}
        </p>
        <h1>{title}</h1>
        <p className="muted">Version {TERMS_VERSION}</p>
        {children}
      </main>
      <Footer />
    </>
  );
}

/** The support address as a link, or a placeholder until NEXT_PUBLIC_SUPPORT_EMAIL is set. */
export function Contact() {
  const email = supportEmail();
  return email ? <a href={`mailto:${email}`}>{email}</a> : <span>[support email]</span>;
}
