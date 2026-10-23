"use client";

import Link from "next/link";
import { Footer } from "@/components/Footer";

/** A page failed to render: say so plainly, offer a retry. The error's message is never shown (it may hold server details). */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <main className="shell" style={{ maxWidth: 520, paddingTop: 72 }}>
        <div className="card stack" role="alert">
          <h1>Something went wrong</h1>
          <p className="muted">This page couldn't load. Your deals keep running on the Haggle server; nothing was sent or paid because of this error.</p>
          {error.digest ? <p className="hint">Reference: {error.digest}</p> : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" type="button" onClick={() => reset()}>
              Try again
            </button>
            <Link className="btn" href="/deals">
              Go to your deals
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
