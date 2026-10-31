import Link from "next/link";
import { redirect } from "next/navigation";
import { DemoBanner } from "@/components/DemoBanner";
import { Footer } from "@/components/Footer";
import { GuestButton } from "@/components/GuestButton";
import { buttonClass, Circled, Highlighted, Icon, Price, Struck, type IconName } from "@/components/ui";
import { DEMO } from "@/lib/demo";
import { sessionUser } from "@/lib/workspace";
import "./landing.css";

// One example deal runs through the whole page: the hero's quote sheet, the log and the channel
// samples all describe it. It is illustrative and labelled "Example" where it appears.

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

const PROMISES: { fact: string; detail: string }[] = [
  { fact: "Nothing is ordered or paid until you approve.", detail: "You approve one exact quote, in the app or by replying to a text, and never above your spending cap." },
  { fact: "Every call says it is an AI assistant.", detail: "Haggle never poses as you or as a person, on the phone or in writing." },
  { fact: "Haggle only contacts businesses you add.", detail: "Your vendors list is the whole list. No cold lists, no surprise outreach." },
];

/** Public landing page; a signed-in visitor goes straight to a new request. */
export default async function Home() {
  if (await sessionUser()) redirect("/chat");
  return (
    <>
      <DemoBanner />
      <header className="lp-bar">
        <div className="wrap lp-bar-inner">
          <Link className="brand" href="/">
            Haggle
          </Link>
          <Link className={buttonClass("quiet")} href="/login">
            Sign in
          </Link>
        </div>
      </header>
      <main className="lp">
        <section className="wrap lp-hero" aria-labelledby="lp-title">
          <div className="lp-copy">
            <h1 id="lp-title">Real quotes from real businesses, without making the calls.</h1>
            <p className="lp-lede">
              Tell Haggle what you need. It emails, phones and texts the businesses you choose, reads every reply, and pushes the price down with the other quotes
              it gets. You pick the winner.
            </p>
            <Ctas />
          </div>
          <QuoteSheet />
        </section>

        <section className="wrap lp-section lp-log" aria-labelledby="log-title">
          <div className="lp-section-head">
            <h2 id="log-title">A deal, start to finish</h2>
            <p>The example above, as Haggle logged it. Seventy-eight minutes, four businesses, no phone calls for you.</p>
          </div>
          <ol className="log">
            {LOG.map((e) => (
              <li key={e.at} className={e.you ? "log-row log-you" : "log-row"}>
                <time className="log-at num">{e.at}</time>
                <span className="log-who">{e.who}</span>
                <span className="log-text">{e.text}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="wrap lp-section lp-channels" aria-labelledby="ch-title">
          <div className="lp-section-head">
            <h2 id="ch-title">Whichever way the business answers</h2>
            <p>Haggle uses the channel each business already replies on.</p>
          </div>
          <ul className="ch-list">
            {CHANNELS.map((c, i) => (
              <li key={c.name} className="ch-row">
                <div className="ch-copy">
                  <h3>
                    <Icon name={c.icon} size={20} />
                    {c.name}
                  </h3>
                  <p>{c.does}</p>
                </div>
                {i === 0 ? <EmailSample /> : i === 1 ? <CallSample /> : <TextSample />}
              </li>
            ))}
          </ul>
        </section>

        <section className="wrap lp-section lp-trust" aria-labelledby="trust-title">
          <div className="lp-section-head">
            <h2 id="trust-title">What Haggle promises</h2>
          </div>
          <dl className="trust">
            {PROMISES.map((p) => (
              <div key={p.fact} className="trust-row">
                <dt>{p.fact}</dt>
                <dd>{p.detail}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="wrap lp-close" aria-labelledby="close-title">
          <h2 id="close-title">Your next order, quoted by lunchtime.</h2>
          <Ctas />
        </section>
      </main>
      <Footer />
    </>
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

/**
 * The hero: the example deal's quote sheet. On load the pen strikes Golden Grill's $1,380, writes in
 * $1,240, highlights the $140 saved and circles Bay Catering's total (the page's one orchestrated
 * motion; landing.css times the write-in, prefers-reduced-motion shows the marked-up sheet at once).
 */
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
        <li className="qs-row qs-short">
          <div className="qs-biz">
            <span className="qs-name">Mission Eats</span>
            <span className="qs-via">
              <span className="qs-channel">
                <Icon name="message" /> Text
              </span>
              <span className="qs-req qs-req-miss">
                <Icon name="x" /> 1 of 2
              </span>
            </span>
          </div>
          <div className="qs-total">
            <Price amount={1080} size="l" />
            <span className="qs-sub">
              <span className="num">$27</span> a person
            </span>
          </div>
          <p className="qs-note">Only 8 vegetarian meals.</p>
        </li>
        <li className="qs-row qs-best">
          <div className="qs-biz">
            <span className="qs-name">Bay Catering</span>
            <span className="qs-via">
              <span className="qs-channel">
                <Icon name="mail" /> Email
              </span>
              <span className="qs-req">
                <Icon name="check" /> 2 of 2
              </span>
            </span>
          </div>
          <div className="qs-total">
            <Circled animate delay={1000}>
              <Price amount={1150} size="l" />
            </Circled>
            <span className="qs-sub">
              <span>
                <span className="num">$200</span> deposit
              </span>
            </span>
          </div>
          <p className="qs-note qs-why">Recommended: the lowest quote that meets both requirements.</p>
        </li>
        <li className="qs-row">
          <div className="qs-biz">
            <span className="qs-name">Golden Grill</span>
            <span className="qs-via">
              <span className="qs-channel">
                <Icon name="phone" /> Phone call
              </span>
              <span className="qs-req">
                <Icon name="check" /> 2 of 2
              </span>
            </span>
          </div>
          <div className="qs-total">
            <span className="qs-nego">
              <Struck animate delay={250} className="qs-was">
                <Price amount={1380} size="s" />
              </Struck>
              <span className="qs-new">
                <Price amount={1240} size="l" />
              </span>
            </span>
            <Highlighted animate delay={720} className="qs-saved">
              <Price amount={140} sign="-" size="s" />
            </Highlighted>
          </div>
          <p className="qs-note">Came down after Haggle mentioned a lower quote.</p>
        </li>
      </ol>
      <figcaption className="qs-foot">
        Three quotes from the four caterers asked. Sunset Deli is booked that day.
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
