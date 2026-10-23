import { Footer } from "@/components/Footer";
import { LoginForm } from "./LoginForm";

const NOTICES: Record<string, string> = {
  guest: "Guest access is only on the Haggle demo. Sign in with your email or Google to use Haggle with real businesses.",
  deleted: "Your account was deleted and you've been signed out.",
  sign_in_failed: "That sign-in link didn't work (it may have expired). Request a new one.",
};

/** /login: ?guest=off (a guest on a live site), ?deleted=1 (after account deletion), ?error=sign_in_failed. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const notice = q.guest === "off" ? NOTICES.guest! : q.deleted ? NOTICES.deleted! : q.error === "sign_in_failed" ? NOTICES.sign_in_failed! : null;
  return (
    <>
      <main className="shell" style={{ maxWidth: 420, paddingTop: 72 }}>
        <LoginForm notice={notice} />
      </main>
      <Footer />
    </>
  );
}
