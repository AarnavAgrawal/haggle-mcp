import Link from "next/link";
import { Footer } from "@/components/Footer";

export default function NotFound() {
  return (
    <>
      <main className="shell" style={{ maxWidth: 520, paddingTop: 72 }}>
        <div className="card stack">
          <h1>Page not found</h1>
          <p className="muted">There's nothing at this address. A deal or conversation you're looking for may belong to another workspace.</p>
          <div style={{ display: "flex", gap: 8 }}>
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
