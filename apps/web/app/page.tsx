import Link from "next/link";
import { redirect } from "next/navigation";
import { DemoBanner } from "@/components/DemoBanner";
import { Footer } from "@/components/Footer";
import { GuestButton } from "@/components/GuestButton";
import { LandingMotion } from "@/components/LandingMotion";
import { buttonClass, Circled, Highlighted, Icon, PenUnderline, Price, Status, Struck, type IconName } from "@/components/ui";
import { DEMO } from "@/lib/demo";
import { sessionUser } from "@/lib/workspace";
import "./landing.css";

// One example deal runs through the whole page: the quote sheet, the log and the channel samples all
// describe it. It is illustrative and labelled "Example" where it appears.
//
// The sheet and the log are one piece: each log entry the reader scrolls past moves the sheet on a step
// (components/LandingMotion.tsx sets the step, landing.css draws it). The markup is the finished sheet;
// .from-N hides a thing until step N and .until-N shows a status up to it, so without script or with
// reduced motion the sheet is simply marked up. Steps are indexes into LOG.

/** "A deal, start to finish": the example deal as Haggle would log it. */
const LOG: { at: string; who: string; you?: boolean; text: string }[] = [
  { at: "09:02", who: "You", you: true, text: "Asked for lunch for 40 next Thursday: 12 vegetarian, delivered to SoMa, under $1,300." },
  { at: "09:03", who: "Haggle", text: "Emailed Bay Catering and Sunset Deli, texted Mission Eats and called Golden Grill." },
  { at: "09:09", who: "Golden Grill", text: "Quoted $1,380 on the call, delivery included." },
  { at: "09:31", who: "Mission Eats", text: "Texted back $1,080, but can only make 8 vegetarian meals." },
  { at: "09:47", who: "Bay Catering", text: "Replied by email: $1,150 with a $200 deposit. Both requirements met." },
  { at: "09:58", who: "Sunset Deli", text: "Declined. Fully booked that day." },
  { at: "10:04", who: "Haggle", text: "Told Golden Grill it had a lower quote. Golden Grill came down to $1,240." },
  { at: "10:12", who: "Haggle", text: "Recommended Bay Catering and texted you for approval." },
  { at: "10:20", who: "You", you: true, text: "Approved Bay Catering's $200 deposit. Nothing was ordered before this." },
];

const CHANNELS: { icon: IconName; name: string; does: string }[] = [
  { icon: "mail", name: "Email", does: "Sends a clear quote request, follows up in the same thread and reads the reply, attachments included." },
  { icon: "phone", name: "Phone call", does: "A voice agent calls, says up front that it is an AI assistant, gets the quote and handles voicemail and phone menus. You get the transcript." },
  { icon: "message", name: "Text", does: "Texts businesses that run on their phones, and texts you when a quote is ready for your approval." },
];

const CONTROLS: { fact: string; detail: string }[] = [
  { fact: "Nothing is ordered or paid until you approve.", detail: "You approve one exact quote, in the app or by replying to a text, and never above your spending cap." },
  { fact: "Every call says it is an AI assistant.", detail: "Haggle never poses as you or as a person, on the phone or in writing." },
  { fact: "You confirm every business before Haggle reaches out.", detail: "Haggle finds businesses that fit your request and shows you who it will contact. Nothing goes out until you say yes." },
];

const SECTIONS: { id: string; label: string }[] = [
  { id: "how-it-works", label: "How it works" },
  { id: "channels", label: "Channels" },
  { id: "your-control", label: "Your control" },
];

/** Public landing page; a signed-in visitor goes straight to a new request. */
export default async function Home() {
  if (await sessionUser()) redirect("/dashboard");
  return (
    <div className="lp-page">
      <LandingMotion />
      <DemoBanner />
      <header className="lp-bar on-blotter" data-top="">
        <div className="wrap lp-bar-inner">
          <Link className="brand" href="/">
            Haggle
          </Link>
          <nav className="lp-nav" aria-label="Sections">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                {s.label}
                <PenUnderline animate />
              </a>
            ))}
          </nav>
          <div className="lp-bar-actions">
            <Link className={buttonClass("quiet")} href="/login">
              Sign in
            </Link>
            <Link className={buttonClass("primary")} href="/login">
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main className="lp">
        <div className="lp-blotter">
          <section className="lp-hero on-blotter" aria-labelledby="lp-title">
            <div className="wrap lp-hero-inner">
              <h1 id="lp-title">
                <span className="lp-wordmark">
                  <span className="sr-only">Haggle: </span>
                  <span className="lp-letters" aria-hidden="true">
                    {[..."Haggle"].map((letter, i) => (
                      <span key={i}>{letter}</span>
                    ))}
                  </span>
                </span>
                <span className="lp-line">Real quotes from real businesses, without making the calls.</span>
              </h1>
              <p className="lp-lede">
                Tell Haggle what you need. It finds the right businesses, emails, phones and texts them, reads every reply, and pushes the price down with the other
                quotes it gets. You pick the winner.
              </p>
              <Ctas />
            </div>
          </section>

          <section id="how-it-works" className="deal" data-step="0" aria-labelledby="log-title">
            <div className="wrap deal-grid">
              <div className="deal-stage">
                <QuoteSheet />
              </div>
              <div className="deal-log on-blotter">
                <header className="deal-head">
                  <h2 id="log-title">A deal, start to finish</h2>
                  <p>This example, as Haggle logged it. Seventy-eight minutes, four businesses, no phone calls for you.</p>
                </header>
                <ol className="log">
                  {LOG.map((e) => (
                    <li key={e.at} className={e.you ? "log-row log-you" : "log-row"}>
                      <span className="log-meta">
                        <time className="log-at num">{e.at}</time>
                        <span className="log-who">{e.who}</span>
                      </span>
                      <span className="log-text">{e.text}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </section>
        </div>

        <section id="channels" className="lp-channels" aria-labelledby="ch-title">
          <div className="wrap">
            <div className="lp-head" data-reveal>
              <h2 id="ch-title">Whichever way the business answers</h2>
              <p>Haggle uses the channel each business already replies on.</p>
            </div>
            <ul className="ch-list">
              {CHANNELS.map((c, i) => (
                <li key={c.name} className="ch-row" data-reveal>
                  <div className="ch-copy">
                    <h3>
                      <Icon name={c.icon} size={24} />
                      {c.name}
                    </h3>
                    <p>{c.does}</p>
                  </div>
                  {i === 0 ? <EmailSample /> : i === 1 ? <CallSample /> : <TextSample />}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="your-control" className="lp-trust" aria-labelledby="trust-title">
          <div className="wrap">
            <div className="lp-head" data-reveal>
              <h2 id="trust-title">You stay in control</h2>
            </div>
            <dl className="trust">
              {CONTROLS.map((p) => (
                <div key={p.fact} className="trust-row" data-reveal>
                  <dt>{p.fact}</dt>
                  <dd>{p.detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="lp-close on-blotter" aria-labelledby="close-title">
          <div className="wrap" data-reveal>
            <h2 id="close-title">Your next order, quoted by lunchtime.</h2>
            <Ctas />
          </div>
        </section>
      </main>

      <div className="lp-end on-blotter">
        <Footer />
      </div>
    </div>
  );
}

/** Get started (sign in) and, on a demo site, a one-click guest demo. */
function Ctas() {
  return (
    <div className="lp-ctas">
      {DEMO ? <GuestButton label="Try the demo" /> : null}
      <Link className={buttonClass(DEMO ? "default" : "primary")} href="/login">
        Get started
      </Link>
    </div>
  );
}

/** A status the sheet shows until the business has answered. Decorative: the log carries the words. */
function Waiting({ until, children }: { until: number; children: string }) {
  return (
    <span className={`qs-wait until-${until}`} aria-hidden="true">
      <Status tone="live">{children}</Status>
    </span>
  );
}

/** The example deal's quote sheet, finished. See the note at the top of this file for how it steps. */
function QuoteSheet() {
  return (
    <figure className="qs" aria-labelledby="qs-title">
      <div className="qs-head">
        <div>
          <p className="qs-title" id="qs-title">
            Lunch for 40, next Thursday
          </p>
          <p className="qs-meta">
            <span>12 vegetarian</span>
            <span>Delivered to SoMa</span>
            <span>
              Budget <span className="num">$1,300</span>
            </span>
          </p>
        </div>
        <span className="qs-example">Example</span>
      </div>
      <ol className="qs-rows">
        <li className="qs-row qs-short arrive-3">
          <div className="qs-biz">
            <span className="qs-name">Mission Eats</span>
            <span className="qs-via">
              <span className="qs-channel">
                <Icon name="message" /> Text
              </span>
              <span className="qs-req qs-req-miss from-3">
                <Icon name="x" /> 1 of 2
              </span>
            </span>
          </div>
          <div className="qs-right">
            <Waiting until={3}>Waiting for a reply</Waiting>
            <div className="qs-total from-3">
              <Price amount={1080} size="l" />
              <span className="qs-sub">
                <span className="num">$27</span> a person
              </span>
            </div>
          </div>
          <p className="qs-note from-3">Only 8 vegetarian meals.</p>
        </li>
        <li className="qs-row qs-best arrive-4">
          <div className="qs-biz">
            <span className="qs-name">Bay Catering</span>
            <span className="qs-via">
              <span className="qs-channel">
                <Icon name="mail" /> Email
              </span>
              <span className="qs-req from-4">
                <Icon name="check" /> 2 of 2
              </span>
            </span>
          </div>
          <div className="qs-right">
            <Waiting until={4}>Waiting for a reply</Waiting>
            <div className="qs-total from-4">
              <Circled animate>
                <Price amount={1150} size="l" />
              </Circled>
              <span className="qs-sub">
                <span>
                  <span className="num">$200</span> deposit
                </span>
              </span>
            </div>
          </div>
          <p className="qs-note qs-why from-7">Recommended: the lowest quote that meets both requirements.</p>
        </li>
        <li className="qs-row arrive-2">
          <div className="qs-biz">
            <span className="qs-name">Golden Grill</span>
            <span className="qs-via">
              <span className="qs-channel">
                <Icon name="phone" /> Phone call
              </span>
              <span className="qs-req from-2">
                <Icon name="check" /> 2 of 2
              </span>
            </span>
          </div>
          <div className="qs-right">
            <Waiting until={2}>Calling now</Waiting>
            <div className="qs-total from-2">
              <span className="qs-nego">
                <Struck animate className="qs-was">
                  <Price amount={1380} size="s" />
                </Struck>
                <span className="qs-new">
                  <Price amount={1240} size="l" />
                </span>
              </span>
              <Highlighted animate delay={420} className="qs-saved from-6">
                <Price amount={140} sign="-" size="s" />
              </Highlighted>
            </div>
          </div>
          <p className="qs-note from-6">Came down after Haggle mentioned a lower quote.</p>
        </li>
        <li className="qs-row qs-out arrive-5">
          <div className="qs-biz">
            <span className="qs-name">Sunset Deli</span>
            <span className="qs-via">
              <span className="qs-channel">
                <Icon name="mail" /> Email
              </span>
            </span>
          </div>
          <div className="qs-right">
            <Waiting until={5}>Waiting for a reply</Waiting>
            <span className="qs-declined from-5">Declined</span>
          </div>
        </li>
      </ol>
      <figcaption className="qs-foot">
        <span className="qs-caption from-5">Three quotes from the four caterers asked. Sunset Deli is booked that day.</span>
        <span className="qs-approved from-8">
          <Icon name="check" /> You approved the $200 deposit
        </span>
      </figcaption>
    </figure>
  );
}

function EmailSample() {
  return (
    <figure className="sample sample-mail" aria-label="Example email from Haggle">
      <p className="mail-line">
        <span className="mail-k">To</span> orders@baycatering.example
      </p>
      <p className="mail-line">
        <span className="mail-k">Subject</span> Quote request: lunch for 40, Thursday
      </p>
      <p className="mail-body">
        Hi Bay Catering, I&rsquo;m Haggle, an AI assistant getting quotes for a customer. Could you quote lunch for 40 next Thursday, 12 of them vegetarian, delivered to SoMa
        by noon? An all-in total and any deposit would be ideal.
      </p>
    </figure>
  );
}

function CallSample() {
  return (
    <figure className="sample sample-call" aria-label="Example call transcript">
      <p className="call-head">
        <span>Call with Golden Grill</span>
        <span className="num">4:12</span>
      </p>
      <p className="call-line">
        <span className="call-who call-us">Haggle</span>
        <span>Hi, I&rsquo;m an AI assistant calling for a customer who&rsquo;d like a catering quote. Is now a good time?</span>
      </p>
      <p className="call-line">
        <span className="call-who">Golden Grill</span>
        <span>Sure. How many people, and when?</span>
      </p>
      <p className="call-line">
        <span className="call-who call-us">Haggle</span>
        <span>Forty, next Thursday at noon, twelve vegetarian.</span>
      </p>
    </figure>
  );
}

function TextSample() {
  return (
    <figure className="sample sample-text" aria-label="Example texts between Haggle and you">
      <p className="call-head">
        <span>Texts with Haggle</span>
      </p>
      <p className="bubble bubble-in">Bay Catering quoted $1,150 for lunch for 40, with a $200 deposit. Reply YES 4821 to approve the deposit.</p>
      <p className="bubble bubble-out">YES 4821</p>
      <p className="bubble bubble-in">Approved. Nothing is charged until you pay.</p>
    </figure>
  );
}
