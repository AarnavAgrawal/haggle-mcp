"use client";

import Link from "next/link";
import { useTransition } from "react";
import { Footer } from "@/components/Footer";
import { Button, buttonClass } from "@/components/ui/Button";
import "./auth.css";

/** A page failed to render: say so plainly, offer a retry. The error's message is never shown (it may hold server details). */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [retrying, startTransition] = useTransition();
  return (
    <>
      <main className="auth">
        <Link className="brand auth-brand" href="/">
          Haggle
        </Link>
        <div className="ui-sheet auth-sheet auth-wide" role="alert">
          <h1>This page didn&apos;t load</h1>
          <p className="auth-sub">
            Your deals keep running on the Haggle server, and nothing was sent or paid because of this. Try again, or go back to your deals.
          </p>
          {error.digest ? (
            <p className="oops-ref">
              If it keeps happening, send support this reference: <code>{error.digest}</code>
            </p>
          ) : null}
          <div className="oops-actions">
            <Button variant="primary" pending={retrying} onClick={() => startTransition(() => reset())}>
              Try again
            </Button>
            <Link className={buttonClass()} href="/deals">
              Go to your deals
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
