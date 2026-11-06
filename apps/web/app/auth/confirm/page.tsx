import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Footer } from "@/components/Footer";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { finishEmailSignIn } from "./actions";
import "../../auth.css";

export const metadata: Metadata = { title: "Sign in · Haggle" };

/** Where an emailed sign-in link lands. Opening it does nothing: lib/auth/callback.ts says why it takes a press. */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token_hash: tokenHash, type } = await searchParams;
  if (typeof tokenHash !== "string" || typeof type !== "string") redirect("/login?error=sign_in_failed");
  return (
    <>
      <main className="auth">
        <Link className="brand auth-brand" href="/">
          Haggle
        </Link>
        <div className="ui-sheet auth-sheet">
          <h1>Sign in to Haggle</h1>
          <p className="auth-sub">Only continue if you asked for this link or we told you you&apos;re in.</p>
          <form className="auth-form auth-confirm" action={finishEmailSignIn}>
            <input type="hidden" name="token_hash" value={tokenHash} />
            <input type="hidden" name="type" value={type} />
            <SubmitButton variant="primary" block>
              Continue to Haggle
            </SubmitButton>
          </form>
        </div>
      </main>
      <Footer />
    </>
  );
}
