// The deal tool's results as cards (DESIGN.md "Chat"): the preview (what Haggle understood and who it
// will contact, with Start the deal / Change something), what Haggle still needs, and the started
// deal (named by its request, linked to its board; never the job id). Every value comes from the card
// model in lib/chat/cards.ts and renders as text.
import Link from "next/link";
import { memo, useId, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Icon, channelIcon } from "@/components/ui/Icon";
import { Price } from "@/components/ui/Price";
import { Status } from "@/components/ui/Status";
import type { Brief, Contact, ToolCard } from "@/lib/chat/cards";

const CHANNEL_WORDS: Record<string, string> = { email: "Email", phone: "Phone call", imessage: "Text", a2a: "Agent" };

/** Simulated data is marked on the card, except on a demo site, where the banner already says so on every page. */
const showDemo = (card: ToolCard) => card.demo && process.env.NEXT_PUBLIC_HAGGLE_DEMO !== "true";

function Contacts({ list }: { list: Contact[] }) {
  return (
    <ul className="cc-contacts">
      {list.map((c) => (
        <li key={`${c.name}-${c.channel}`}>
          <Icon name={c.channel ? channelIcon(c.channel) : "mail"} />
          <span className="cc-contact-name">{c.name}</span>
          {c.channel ? <span className="cc-contact-channel">{CHANNEL_WORDS[c.channel] ?? c.channel}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function BriefList({ brief }: { brief: Brief }) {
  const rows: { label: string; value: ReactNode }[] = [];
  if (brief.quantity) rows.push({ label: "How many", value: brief.quantity });
  if (brief.when) rows.push({ label: "When", value: brief.when });
  if (brief.where) rows.push({ label: "Where", value: brief.where });
  rows.push({
    label: "Budget",
    value:
      brief.budget_usd !== undefined ? (
        <>
          <Price amount={brief.budget_usd} />
          {brief.hard_limit ? <span className="cc-soft"> at most</span> : null}
        </>
      ) : brief.budget_text ? (
        brief.budget_text
      ) : (
        <span className="cc-soft">None given</span>
      ),
  });
  for (const d of brief.details) rows.push({ label: d.label, value: d.value });
  return (
    <dl className="cc-brief">
      {rows.map((r) => (
        <div key={r.label} className="cc-row">
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PreviewCard({ card, active, onStart, onChange }: { card: Extract<ToolCard, { kind: "preview" }>; active: boolean; onStart: () => void; onChange: () => void }) {
  const id = useId();
  const b = card.brief;
  const n = card.contact.length;
  return (
    <article className="chat-card cc-preview" aria-labelledby={`${id}-t`}>
      <header className="cc-head">
        <h2 id={`${id}-t`} className="cc-title">
          {b ? (b.quantity && /^\d/.test(b.quantity) ? `${b.what}, ${b.quantity}` : b.what) : "Your request"}
        </h2>
        {showDemo(card) ? <Badge title="Simulated businesses: nothing real is sent or paid" /> : null}
      </header>
      <div className="cc-cols">
        <div className="cc-col">
          {b ? <BriefList brief={b} /> : null}
          {b && b.must_haves.length ? (
            <section className="cc-section" aria-labelledby={`${id}-m`}>
              <h3 id={`${id}-m`} className="cc-label">
                Must-haves
              </h3>
              <ul className="cc-checks">
                {b.must_haves.map((m) => (
                  <li key={m}>
                    <Icon name="check" />
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        <section className="cc-col cc-who" aria-labelledby={`${id}-w`}>
          <h3 id={`${id}-w`} className="cc-label">
            {n ? `Haggle will contact ${n}` : "No one can be contacted yet"}
          </h3>
          {n ? <Contacts list={card.contact} /> : null}
          {card.blocked.length ? (
            <ul className="cc-blocked">
              {card.blocked.map((x) => (
                <li key={x.name}>
                  <span className="cc-contact-name">{x.name}</span> <span className="cc-soft">can&rsquo;t be contacted: {x.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
      {active ? (
        <footer className="cc-foot">
          {n ? (
            <Button variant="primary" onClick={onStart}>
              Start the deal
            </Button>
          ) : null}
          <Button onClick={onChange}>Change something</Button>
          <span className="cc-note">Nothing has been sent yet.</span>
        </footer>
      ) : null}
    </article>
  );
}

function NeedsInfoCard({ card, active, onAnswer }: { card: Extract<ToolCard, { kind: "needs_info" }>; active: boolean; onAnswer: () => void }) {
  const id = useId();
  return (
    <article className="chat-card cc-needs" aria-labelledby={`${id}-t`}>
      <header className="cc-head">
        <h2 id={`${id}-t`} className="cc-title cc-title-s">
          Before Haggle asks for quotes
        </h2>
        {showDemo(card) ? <Badge /> : null}
      </header>
      {card.missing.length ? (
        <ul className="cc-todo" aria-label="Still needed">
          {card.missing.map((q) => (
            <li key={q}>
              <span className="cc-box" aria-hidden="true" />
              <span>{q}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {card.optional.length ? (
        <section className="cc-section" aria-labelledby={`${id}-o`}>
          <h3 id={`${id}-o`} className="cc-label">
            Optional, these change the price
          </h3>
          <ul className="cc-todo cc-todo-optional">
            {card.optional.map((q) => (
              <li key={q}>
                <span className="cc-box" aria-hidden="true" />
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <footer className="cc-foot">
        {active ? (
          <Button size="s" onClick={onAnswer}>
            Answer
          </Button>
        ) : null}
        <span className="cc-note">Nothing was sent.</span>
      </footer>
    </article>
  );
}

export function StartedCard({ jobId, card }: { jobId: string; card?: Extract<ToolCard, { kind: "started" }> }) {
  const id = useId();
  const n = card?.contacted.length ?? 0;
  return (
    <article className="chat-card cc-started" aria-labelledby={`${id}-t`}>
      <div className="cc-started-main">
        <p className="cc-status">
          <Status tone="ok">{n ? `Deal started, ${n} ${n === 1 ? "business" : "businesses"} contacted` : "Deal started"}</Status>
          {card && showDemo(card) ? <Badge /> : null}
        </p>
        <h2 id={`${id}-t`} className="cc-title">
          {card?.title ?? "Your deal"}
        </h2>
        {card && (card.when || card.where || card.budget_usd !== undefined) ? (
          <p className="cc-meta">
            {card.when ? (
              <span>
                <Icon name="clock" />
                {card.when}
              </span>
            ) : null}
            {card.where ? <span>{card.where}</span> : null}
            {card.budget_usd !== undefined ? (
              <span>
                Budget <Price amount={card.budget_usd} size="s" />
              </span>
            ) : null}
          </p>
        ) : null}
        {n ? <Contacts list={card!.contacted} /> : null}
        {card && card.not_contacted > 0 ? <p className="cc-soft cc-small">{card.not_contacted} couldn&rsquo;t be contacted; the board says why.</p> : null}
      </div>
      <Link className={buttonClass("primary", { className: "cc-open" })} href={`/deals/${encodeURIComponent(jobId)}`}>
        Open deal board
      </Link>
    </article>
  );
}

export const DealCard = memo(function DealCard({ card, active, onStart, onFocusComposer }: { card: ToolCard; active: boolean; onStart: () => void; onFocusComposer: (placeholder?: string) => void }) {
  switch (card.kind) {
    case "preview":
      return <PreviewCard card={card} active={active} onStart={onStart} onChange={() => onFocusComposer("What should change?")} />;
    case "needs_info":
      return <NeedsInfoCard card={card} active={active} onAnswer={() => onFocusComposer("Your answers")} />;
    case "started":
      return <StartedCard jobId={card.job_id} card={card} />;
  }
});
