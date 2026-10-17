/**
 * Business profile (business_profile): the business's learned "API" — how it prices, what it
 * needs up front, how it negotiates and how to reach it — plus the history it was learned from.
 */
import { ModelContext, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useState } from "react";
import type { BusinessProfile } from "@haggle/core";
import { ChannelBadge, ErrorNote, Meter, ModeBadge, Shell, Skeleton, usd } from "../_shared/ui.tsx";
import "./view.css";

export default function BusinessProfileView() {
  const ctx = useToolContext<"business_profile">();
  if (ctx.status !== "ready") {
    return (
      <Shell>
        {ctx.status === "error" ? <ErrorNote title="Couldn't load this business." detail={ctx.error.message} /> : <Skeleton rows={5} />}
      </Shell>
    );
  }
  return (
    <Shell>
      <Profile p={ctx.toolOutput as BusinessProfile} />
    </Shell>
  );
}

function Profile({ p }: { p: BusinessProfile }) {
  const followUp = useSendFollowUp();
  const [allHistory, setAllHistory] = useState(false);
  const history = allHistory ? p.history : p.history.slice(0, 5);
  const facts: [string, string | undefined][] = [
    ["Price", p.price_model],
    ["Minimum", p.minimum],
    ["Deposit", p.deposit_rule],
    ["Negotiation", p.discount_behavior],
    ["Replies", p.reply_speed],
  ];

  return (
    <div className="bp">
      <ModelContext content={`Haggle profile of ${p.name}: ${p.price_model}; ${p.discount_behavior}; best reached by ${p.best_channel}.`} />
      <header className="bp-head">
        <div>
          <h1>
            {p.name} <ModeBadge mode={p.mode} />
          </h1>
          <p className="hg-muted">
            {capitalize(p.category)}
            {p.area ? ` in ${p.area}` : ""}, learned from {p.n_quotes} quote{p.n_quotes === 1 ? "" : "s"}
          </p>
        </div>
        <div className="bp-reach">
          <span className="bp-reach-label">Best reached by</span>
          <ChannelBadge channel={p.best_channel} />
        </div>
      </header>

      <div className="bp-conf">
        <Meter value={p.confidence} max={1} tone="win" label={`Confidence ${Math.round(p.confidence * 100)}%`} />
        <span>{Math.round(p.confidence * 100)}% confident</span>
      </div>

      <dl className="bp-facts">
        {facts
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>

      {p.menu.length > 0 && (
        <section className="bp-menu" aria-label="Menu">
          <h2>Menu seen in quotes</h2>
          <ul>
            {p.menu.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </section>
      )}

      {p.history.length > 0 && (
        <section className="bp-history" aria-label="History">
          <h2>History</h2>
          <ol>
            {history.map((h, i) => (
              <li key={`${h.date}-${i}`}>
                <time>{formatDate(h.date)}</time>
                <ChannelBadge channel={h.channel} />
                <span className="bp-h-note">{h.note}</span>
                <span className="bp-h-total">{h.total_usd !== undefined ? usd(h.total_usd) : ""}</span>
              </li>
            ))}
          </ol>
          {p.history.length > 5 && (
            <button className="bp-more" onClick={() => setAllHistory((v) => !v)} aria-expanded={allHistory}>
              {allHistory ? "Show fewer" : `Show all ${p.history.length}`}
            </button>
          )}
        </section>
      )}

      <footer className="bp-foot">
        <button
          className="hg-btn hg-btn-primary"
          onClick={() => void followUp({ prompt: `Get me a real quote from ${p.name} (Haggle business ${p.business_id}).` }).catch(() => {})}
        >
          Ask {p.name} for a quote
        </button>
      </footer>
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function formatDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
