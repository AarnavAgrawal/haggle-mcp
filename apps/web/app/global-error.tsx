"use client";

// Replaces the root layout when the layout itself fails, so it brings its own <html>, <body> and styles.
import "./globals.css";
// Next always prerenders this page (it becomes .next/server/pages/500.html, served only when a request
// fails outside rendering), so its scripts have no CSP nonce and don't run there: the message and the
// plain "Home" link still work, the "Try again" button doesn't. Next can't render it per request
// (build/utils.js isPageStatic: _global-error is always static); see docs/web-app.md.

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="shell" style={{ maxWidth: 520, paddingTop: 72 }}>
          <div className="card stack" role="alert">
            <h1>Something went wrong</h1>
            <p className="muted">Haggle couldn't load. Your deals keep running on the Haggle server; nothing was sent or paid because of this error.</p>
            {error.digest ? <p className="hint">Reference: {error.digest}</p> : null}
            <div style={{ display: "flex", gap: 8 }}>
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
