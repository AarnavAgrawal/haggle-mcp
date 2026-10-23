import Link from "next/link";
import { redirect } from "next/navigation";
import { DemoBanner } from "@/components/DemoBanner";
import { Footer } from "@/components/Footer";
import { GuestButton } from "@/components/GuestButton";
import { DEMO } from "@/lib/demo";
import { sessionUser } from "@/lib/workspace";

/** Public landing page; a signed-in visitor goes straight to a new request. */
export default async function Home() {
  if (await sessionUser()) redirect("/chat");
  return (
    <>
      <DemoBanner />
      <main className="landing">
        <section className="landing-hero">
          <h1>Haggle gets you real quotes from real businesses.</h1>
          <p>
            Tell it what you need. Haggle emails, calls and texts businesses for you, reads their replies, negotiates with real competing quotes, and
            asks you before anything is paid. Every quote, transcript and status in one place.
          </p>
          <div className="landing-cta">
            {DEMO ? <GuestButton label="Try the demo, no sign-up" /> : null}
            <Link className={DEMO ? "btn" : "btn btn-primary"} href="/login">
              Sign in
            </Link>
          </div>
        </section>
        <ol className="landing-steps">
          <li>
            <strong>1. Say what you need</strong>
            Chat with Haggle: “lunch for 40 next Thursday, 12 vegetarian, under $1,200.” It asks only what's missing.
          </li>
          <li>
            <strong>2. Haggle reaches out</strong>
            Businesses get an email, an AI phone call or a text on their own channel. Replies and call transcripts land on a live board.
          </li>
          <li>
            <strong>3. It negotiates</strong>
            Haggle compares all-in totals, checks your requirements and counters with real competing quotes.
          </li>
          <li>
            <strong>4. You approve, then pay</strong>
            Nothing is ordered or paid until you approve the exact quote you want.
          </li>
        </ol>
        <p className="landing-channels">Email · Voice AI calls · Texts · Agent-to-agent. Built on the Haggle MCP server, so any AI agent can buy the same way.</p>
      </main>
      <Footer />
    </>
  );
}
