import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { buttonClass } from "@/components/ui/Button";
import { PenUnderline } from "@/components/ui/PenMarks";
import { LEGAL_DRAFT_NOTE, supportEmail, TERMS_VERSION } from "@/lib/account/legal";
import "./legal.css";

const DOCS = [
  { key: "terms", href: "/terms", label: "Terms of Service" },
  { key: "privacy", href: "/privacy", label: "Privacy Policy" },
  { key: "acceptable-use", href: "/acceptable-use", label: "Acceptable Use" },
] as const;

export type LegalDoc = (typeof DOCS)[number]["key"];

/** Shared frame for /terms, /privacy and /acceptable-use: the policies nav, draft note, title, version and footer. */
export function LegalPage({ title, current, children }: { title: string; current: LegalDoc; children: ReactNode }) {
  return (
    <>
      <header className="legal-bar">
        <div className="wrap legal-bar-inner">
          <Link className="brand" href="/">
            Haggle
          </Link>
          <Link className={buttonClass("quiet", { size: "s" })} href="/">
            Back to Haggle
          </Link>
        </div>
      </header>
      <main className="wrap legal">
        <nav className="legal-nav" aria-label="Policies">
          <ul>
            {DOCS.map((d) => (
              <li key={d.key}>
                <Link href={d.href} aria-current={d.key === current ? "page" : undefined}>
                  {d.label}
                  {d.key === current ? <PenUnderline /> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <article className="legal-article">
          <p className="legal-draft" role="note">
            {LEGAL_DRAFT_NOTE}
          </p>
          <h1>{title}</h1>
          <p className="legal-meta">Version {TERMS_VERSION}</p>
          {children}
        </article>
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
