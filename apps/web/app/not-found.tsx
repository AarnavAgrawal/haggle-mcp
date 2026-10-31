import Link from "next/link";
import { Footer } from "@/components/Footer";
import { buttonClass } from "@/components/ui/Button";
import "./auth.css";

export default function NotFound() {
  return (
    <>
      <main className="auth">
        <Link className="brand auth-brand" href="/">
          Haggle
        </Link>
        <div className="ui-sheet auth-sheet auth-wide">
          <h1>Nothing at this address</h1>
          <p className="auth-sub">
            The link may be mistyped, or the deal or conversation belongs to another workspace. Your own deals are all in one list.
          </p>
          <div className="oops-actions">
            <Link className={buttonClass("primary")} href="/deals">
              Your deals
            </Link>
            <Link className={buttonClass()} href="/">
              Home
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
