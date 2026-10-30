import Link from "next/link";
import { redirect } from "next/navigation";
import { DemoBanner } from "@/components/DemoBanner";
import { Footer } from "@/components/Footer";
import { GuestButton } from "@/components/GuestButton";
import { DEMO } from "@/lib/demo";
import { sessionUser } from "@/lib/workspace";

/** The hero's example sheet: what a deal looks like once quotes come in. Illustrative, labelled as such. */
const EXAMPLE = [
  { name: "Bay Catering", via: "Answered by its booking agent", price: "$1,150", note: "Meets every requirement" },
  { name: "Golden Grill", via: "Replied by email", price: "$1,240", was: "$1,380", saved: "−$140", note: "Matched a lower quote" },
  { name: "Mission Eats", via: "Voice AI call in progress", price: null, note: "On the phone now" },
];

const STEPS = [
  { title: "Say what you need", body: "“Lunch for 40 next Thursday, 12 vegetarian, under $1,200.” Haggle asks only what’s missing." },
  { title: "Haggle reaches out", body: "Each business gets an email, an AI phone call or a text, on the channel it already uses." },
  { title: "It negotiates", body: "Haggle compares all-in totals, checks your requirements and counters with real competing quotes." },
  { title: "You approve", body: "Nothing is ordered or paid until you approve the exact quote you want." },
];

/** Public landing page; a signed-in visitor goes straight to a new request. */
export default async function Home() {
  if (await sessionUser()) redirect("/chat");
  return (
    <>
      <DemoBanner />
      <header className="landing-bar">
        <div className="wrap landing-bar-inner">
          <span className="brand">Haggle</span>
          <Link className="btn btn-quiet" href="/login">
            Sign in
          </Link>
        </div>
      </header>
      <main>
        <section className="wrap landing-hero">
          <div className="landing-copy">
            <h1>Real quotes from real businesses, haggled for you.</h1>
            <p>
              Haggle emails, calls and texts the businesses you choose, reads their replies and call transcripts, and negotiates with real competing quotes.
              Nothing is ordered or paid until you approve.
            </p>
            <div className="actions">
              {DEMO ? <GuestButton label="Try the demo, no sign-up" /> : null}
              <Link className={DEMO ? "btn" : "btn btn-primary"} href="/login">
                {DEMO ? "Sign in" : "Get started"}
              </Link>
            </div>
          </div>

          <figure className="sheet" aria-label="Example deal">
            <figcaption className="sheet-head">
              <span className="sheet-what">Lunch for 40, next Thursday</span>
              <span className="hint">Example</span>
            </figcaption>
            <ol className="sheet-rows">
              {EXAMPLE.map((r) => (
                <li key={r.name} className="sheet-row">
                  <div>
                    <strong>{r.name}</strong>
                    <span className="hint">{r.via}</span>
                  </div>
                  <div className="sheet-amount">
                    {r.was ? <span className="price-was">{r.was}</span> : null}
                    {r.price ? <span className="price">{r.price}</span> : <span className="sheet-live">Calling</span>}
                    {r.saved ? <span className="sticker">{r.saved}</span> : null}
                  </div>
                  <span className="sheet-note">{r.note}</span>
                </li>
              ))}
            </ol>
            <div className="sheet-foot">
              <span>Best value: Bay Catering</span>
              <span className="price">$1,150</span>
            </div>
          </figure>
        </section>

        <section className="wrap landing-how" aria-labelledby="how-h">
          <h2 id="how-h">How a deal runs</h2>
          <ol className="landing-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="landing-step-n" aria-hidden="true">
                  {i + 1}
                </span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="landing-channels">
            Works by email, Voice AI phone calls, text messages and agent-to-agent. Built on the Haggle MCP server, so any AI agent can buy the same way.
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
