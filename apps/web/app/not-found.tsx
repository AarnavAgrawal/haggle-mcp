import Link from "next/link";
import { Footer } from "@/components/Footer";

export default function NotFound() {
  return (
    <>
      <main className="shell shell-narrow">
        <div className="card stack">
          <h1>Page not found</h1>
          <p className="muted">There's nothing at this address. A deal or conversation you're looking for may belong to another workspace.</p>
          <div className="actions">
            <Link className="btn btn-primary" href="/deals">
              Your deals
            </Link>
            <Link className="btn" href="/">
              Home
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
