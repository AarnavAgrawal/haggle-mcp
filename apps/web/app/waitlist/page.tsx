// /waitlist: Haggle is by invitation. A visitor joins here; someone who signed in but hasn't been let in lands
// here and sees where they stand. Once admitted they move on to onboarding. Public (proxy.ts). A signed-out
// visit never touches the service-role client. A demo site has no waitlist.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DeleteAccount } from "@/app/(app)/account/DeleteAccount";
import "@/app/(app)/account/account.css";
import { Footer } from "@/components/Footer";
import { WaitlistForm } from "@/components/waitlist/WaitlistForm";
import { DEMO } from "@/lib/demo";
import type { Admission } from "@/lib/waitlist/gate";
import { admission, sessionUser } from "@/lib/workspace";
import "../auth.css";

export const metadata: Metadata = { title: "Join the waitlist · Haggle" };

export default async function WaitlistPage() {
  if (DEMO) redirect("/login");
  const user = await sessionUser();
  let state: Admission | "unknown" | null = null;
  if (user) {
    try {
      state = await admission(user);
    } catch {
      state = "unknown";
    }
  }
  if (state === "member") redirect("/chat");
  if (state === "admitted") redirect("/onboarding");

  return (
    <>
      <main className="auth">
        <Link className="brand auth-brand" href="/">
          Haggle
        </Link>
        <div className="ui-sheet auth-sheet auth-wide">
          {state === "waiting" ? (
            <>
              <h1>You&apos;re on the list</h1>
              <p className="auth-sub">
                We&apos;ll email <strong>{user?.email}</strong> when you&apos;re in. There&apos;s nothing else you need to do.
              </p>
              <YourData />
            </>
          ) : (
            <>
              <h1>Join the Haggle waitlist</h1>
              <p className="auth-sub">We&apos;re letting people in a few at a time. Tell us who you are and we&apos;ll email you a sign-in link when you&apos;re in.</p>
              {state === "unknown" ? (
                <p className="note note-risk auth-notice" role="alert">
                  Couldn&apos;t check your place on the list. Reload this page in a moment.
                </p>
              ) : (
                <WaitlistForm {...(user?.email ? { email: user.email } : {})} />
              )}
            </>
          )}
        </div>
        {user ? (
          <form className="auth-legal onb-switch" action="/auth/sign-out" method="post">
            Signed in as <strong>{user.email}</strong>.{" "}
            <button type="submit" className="onb-switch-btn">
              Sign out
            </button>
          </form>
        ) : (
          <p className="auth-legal">
            Already let in? <Link href="/login">Sign in</Link>. How we handle your details: <Link href="/privacy">Privacy policy</Link>.
          </p>
        )}
      </main>
      <Footer />
    </>
  );
}

/** /account is out of reach until someone has a workspace, so these live here while they wait. */
function YourData() {
  return (
    <details className="wl-data">
      <summary>Your data</summary>
      <div className="wl-data-body">
        <p>Download what Haggle holds about you, or delete your account and your place on the list.</p>
        <a className="btn" href="/api/account/export" download>
          Download my data
        </a>
        <DeleteAccount />
      </div>
    </details>
  );
}
