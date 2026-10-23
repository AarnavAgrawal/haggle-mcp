"use client";

// Replaces the root layout when the layout itself fails, so it brings its own <html>, <body> and styles.
import "./globals.css";

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
