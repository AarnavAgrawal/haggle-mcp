"use client";

// Replaces the root layout when the layout itself fails, so it brings its own <html>, <body>, fonts and styles.
import { Bricolage_Grotesque, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";
import "@/components/ui/ui.css";
import "./auth.css";
// Next always prerenders this page (it becomes .next/server/pages/500.html, served only when a request
// fails outside rendering), so its scripts have no CSP nonce and don't run there: the message and the
// plain "Home" link still work, the "Try again" button doesn't. Next can't render it per request
// (build/utils.js isPageStatic: _global-error is always static); see docs/web-app.md.

const bricolage = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz", "wdth"], variable: "--font-bricolage", display: "swap" });
const schibsted = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap" });

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${schibsted.variable}`}>
      <body>
        <main className="auth">
          {/* A plain link: the client router may be what failed. */}
          <a className="brand auth-brand" href="/">
            Haggle
          </a>
          <div className="ui-sheet auth-sheet auth-wide" role="alert">
            <h1>Haggle didn&apos;t load</h1>
            <p className="auth-sub">
              Your deals keep running on the Haggle server, and nothing was sent or paid because of this. Try again, or reload the page in a minute.
            </p>
            {error.digest ? (
              <p className="oops-ref">
                If it keeps happening, send support this reference: <code>{error.digest}</code>
              </p>
            ) : null}
            <div className="oops-actions">
              <button className="btn btn-primary" type="button" onClick={() => reset()}>
                Try again
              </button>
              <a className="btn" href="/">
                Home
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
