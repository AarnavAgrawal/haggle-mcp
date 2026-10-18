/**
 * Business profile (business_profile): everything Haggle knows about one business, each fact with its
 * source. Whether Haggle may contact it (contact badge), where it is, its website and Google Maps
 * links, the evidence grouped by kind (verified by Haggle / Google listing & reviews / the business's
 * own claims / Haggle's estimates) and what is still unknown. For a business that has quoted, the
 * learned "API" too: how it prices, what it needs up front, how it negotiates, and the history.
 *
 * Listing and website text is third-party data: shown as text, links open only on the human's click.
 */
import { ModelContext, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useState } from "react";
import type { BusinessProfile } from "@haggle/core";
import { ContactBadge, EvidenceList, ExternalLinks } from "../_shared/business-ui.tsx";
import { contactBadge, isContactable, isUnknownField, websiteFrom, type EvidenceItem } from "../_shared/business.ts";
import { ChannelBadge, ErrorNote, Meter, ModeBadge, Shell, Skeleton, usd } from "../_shared/ui.tsx";
import "./view.css";

/** business_profile's extras beyond the shared schema (apps/mcp/index.ts): evidence, contact, listing. */
type ProfileOut = BusinessProfile & {
  business_ref?: string;
  configured_vendor?: boolean;
  ready?: boolean;
  website?: string;
  public_listing?: { source?: string; attribution?: string; maps_url?: string; website?: string };
  contact_status?: { state: string; summary: string };
  evidence?: EvidenceItem[];
  unknowns?: string[];
};

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
      <Profile p={ctx.toolOutput as ProfileOut} />
    </Shell>
  );
}

function Profile({ p }: { p: ProfileOut }) {
  const followUp = useSendFollowUp();
  const [allHistory, setAllHistory] = useState(false);
  const history = allHistory ? p.history : p.history.slice(0, 5);
  const learned = p.n_quotes > 0 || p.history.length > 0;
  const state = p.contact_status?.state;
  const contactable = state ? isContactable(state) : learned;
  const website = websiteFrom(p);
  const mapsUrl = p.public_listing?.maps_url;
  const facts: [string, string | undefined][] = [
    ["Price", p.price_model],
    ["Minimum", p.minimum],
    ["Deposit", p.deposit_rule],
    ["Negotiation", p.discount_behavior],
    ["Replies", p.reply_speed],
  ];
  // Before any quote the learned fields are mostly "Unknown …": show only what is actually known
  // (e.g. a price the website advertises) and say the rest in one line.
  const shown = learned ? facts.filter(([, v]) => v) : facts.filter(([, v]) => !isUnknownField(v));
  const category = p.category && p.category !== "unknown" ? capitalize(p.category.replace(/_/g, " ")) : "Business";
  const prompt = contactable
    ? `Get me a real quote from ${p.name} (Haggle business ${p.business_ref ?? p.business_id}).`
    : `Check whether Haggle may contact ${p.name}: run deal with businesses=['${p.name.replace(/'/g, "’")}'] and dry_run=true, and tell me before anything is sent.`;

  return (
    <div className="bp">
      <ModelContext
        content={`Haggle profile of ${p.name}: ${state ? `${contactBadge(state).label.toLowerCase()}; ` : ""}${learned ? `${p.price_model}; ${p.discount_behavior}; ` : "no quotes yet; "}${p.evidence?.length ?? 0} evidence items.`}
      />
      <header className="bp-head">
        <div className="bp-title">
          <h1>
            {p.name} <ModeBadge mode={p.mode} />
          </h1>
          <p className="hg-muted">
            {category}
            {p.configured_vendor ? " · configured demo vendor" : ""}
            {learned ? ` · learned from ${p.n_quotes} quote${p.n_quotes === 1 ? "" : "s"}` : " · no quotes yet"}
          </p>
          {p.area && <p className="bp-addr">{p.area}</p>}
        </div>
        {learned && (
          <div className="bp-reach">
            <span className="bp-reach-label">Best reached by</span>
            <ChannelBadge channel={p.best_channel} />
          </div>
        )}
      </header>

      {(state || website || mapsUrl) && (
        <div className="bp-contact">
          {state && (
            <div className="bp-contact-line">
              <ContactBadge state={state} summary={p.contact_status?.summary} />
              {p.contact_status?.summary && <span className="bp-contact-summary">{p.contact_status.summary}</span>}
            </div>
          )}
          <ExternalLinks website={website} mapsUrl={mapsUrl} />
        </div>
      )}

      {learned && (
        <div className="bp-conf">
          <Meter value={p.confidence} max={1} tone="win" label={`Confidence ${Math.round(p.confidence * 100)}%`} />
          <span>{Math.round(p.confidence * 100)}% confident</span>
        </div>
      )}

      {shown.length > 0 && (
        <dl className="bp-facts">
          {shown.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}

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

      {(p.evidence?.length ?? 0) > 0 && (
        <section className="bp-evidence" aria-label="Evidence">
          {learned && <h2>Evidence</h2>}
          <EvidenceList evidence={p.evidence} />
        </section>
      )}

      {!learned && <p className="bp-pending">Prices, minimums, negotiation and reply speed: unknown until the business quotes Haggle.</p>}

      {(p.unknowns?.length ?? 0) > 0 && (
        <section className="bp-unknowns" aria-label="Still unknown">
          <h2>Still unknown</h2>
          <ul>
            {p.unknowns!.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </section>
      )}

      <footer className="bp-foot">
        <button
          className={`hg-btn${contactable ? " hg-btn-primary" : ""}`}
          title={`Sends this message to your assistant: “${prompt}”`}
          onClick={() => void followUp({ prompt }).catch(() => {})}
        >
          {contactable ? `Ask ${p.name} for a quote` : "Can Haggle contact it?"}
        </button>
        {p.public_listing?.attribution && <span className="bp-attr">Listing: {p.public_listing.attribution}</span>}
      </footer>
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function formatDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
