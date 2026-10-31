/**
 * Business list (discover): one card with every business found in public listings (address, today's
 * hours, website, rating and Maps link where the listing has them, why it ranked, and whether Haggle may contact it), then the
 * server's configured demo vendors. Found is not authorized: the contact badge says which is which.
 *
 * Listing data is third-party: shown as text, links open only on the human's click.
 */
import { ModelContext, useCallTool, useSendFollowUp, useToolContext } from "mcp-use/react";
import { useState, type ReactNode } from "react";
import { ContactBadge, EvidenceList, ExternalLinks, Stars } from "../_shared/business-ui.tsx";
import { quotesPrompt, type EvidenceItem } from "../_shared/business.ts";
import { ErrorNote, ModeBadge, Shell, Skeleton, toolErrorText } from "../_shared/ui.tsx";
import "./view.css";

type Found = {
  name: string;
  business_ref: string;
  address?: string;
  rating?: number;
  review_count?: number;
  website?: string;
  maps_url?: string;
  phone_published?: boolean;
  in_area?: boolean;
  rank_reasons?: string[];
  contact_state: string;
  contact_summary?: string;
  attribution?: string;
  /** "Open today 9am–5pm" (the business's timezone), when its hours are known. */
  hours_today?: string;
};

type Vendor = { name: string; best_channel: string; channel_label?: string; ready: boolean; played_by?: string; blocker?: string; fix?: string };

type DiscoverOut = {
  mode?: "mock" | "live";
  next?: string;
  ready?: number;
  total?: number;
  found?: Found[];
  businesses?: Vendor[];
  public_discovery?: { status: string; message: string };
  category?: string;
};

export default function BusinessListView() {
  const ctx = useToolContext<"discover">();
  if (ctx.status !== "ready") {
    return (
      <Shell>
        {ctx.status === "error" ? <ErrorNote title="Couldn't find businesses." detail={ctx.error.message} /> : <Skeleton rows={5} />}
      </Shell>
    );
  }
  const input = (ctx.toolInput ?? {}) as { category?: string; area?: string };
  return (
    <Shell>
      <BusinessList data={ctx.toolOutput as DiscoverOut} category={input.category} area={input.area} />
    </Shell>
  );
}

function BusinessList({ data, category, area }: { data: DiscoverOut; category?: string; area?: string }) {
  const found = data.found ?? [];
  const vendors = data.businesses ?? [];
  const pub = data.public_discovery;
  const attribution = found.find((f) => f.attribution)?.attribution;
  const title = category ? `${capitalize(category)}${area ? ` near ${area}` : ""}` : "Businesses";

  return (
    <div className="bl">
      <ModelContext
        content={`Haggle discover card: ${found.length} found${found.length ? ` (${found.map((f) => `${f.name} [${f.business_ref}] ${f.contact_state}`).join("; ")})` : ""}; ${data.ready ?? 0} of ${data.total ?? vendors.length} demo vendors ready.`}
      />
      <header className="bl-head">
        <div>
          <h1>
            {title} <ModeBadge mode={data.mode} />
          </h1>
          <p className="hg-muted">
            {found.length
              ? `${found.length} found in public listings · ${found.filter((f) => f.contact_state === "authorized" || f.contact_state === "verified_responsive").length} Haggle may contact`
              : "No public listings in this result"}
          </p>
        </div>
      </header>

      {pub && (pub.status !== "ok" || found.length === 0) && (
        <p className={`bl-note${pub.status === "not_requested" || pub.status === "ok" ? "" : " bl-note-warn"}`} role="status">
          {pub.message}
        </p>
      )}

      {found.length > 0 && (
        <ol className="bl-rows" aria-label="Businesses found">
          {found.map((f, i) => (
            <FoundRow key={f.business_ref} f={f} rank={i + 1} />
          ))}
        </ol>
      )}

      {found.length > 0 && <p className="bl-attr">Listings: {attribution ?? "public listings"}</p>}

      {vendors.length > 0 && (
        <section className="bl-vendors" aria-label="Your demo vendors">
          <h2>
            Your demo vendors <span className="hg-muted">· {data.ready ?? vendors.filter((v) => v.ready).length} of {data.total ?? vendors.length} ready</span>
          </h2>
          <ul>
            {vendors.map((v) => (
              <li key={v.name} className={v.ready ? "" : "bl-v-blocked"}>
                <span className="bl-v-name">{v.name}</span>
                <span className="bl-v-ch">{v.channel_label ?? v.best_channel}</span>
                <span className={`bl-v-state ${v.ready ? "bl-v-ready" : "bl-v-notready"}`}>{v.ready ? "Ready" : "Not ready"}</span>
                {!v.ready && v.blocker && (
                  <span className="bl-v-blocker">
                    {v.blocker}
                    {v.fix ? ` Fix: ${v.fix}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(found.length > 0 || vendors.some((v) => v.ready)) && (
        <footer className="bl-foot">
          <ChatButton primary prompt={quotesPrompt(found, vendors, category)}>
            Get quotes from these
          </ChatButton>
        </footer>
      )}
    </div>
  );
}

type ProfileOut = { evidence?: EvidenceItem[]; unknowns?: string[]; contact_status?: { state: string; summary: string } };

function FoundRow({ f, rank }: { f: Found; rank: number }) {
  const profile = useCallTool("business_profile");
  const [open, setOpen] = useState(false);
  const p = profile.data?.structuredContent as ProfileOut | undefined;

  const toggle = () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (!profile.data && !profile.isPending) void profile.callTool({ business: f.business_ref }).catch(() => {});
  };

  return (
    <li className="bl-row">
      <div className="bl-row-top">
        <span className="bl-rank" aria-hidden="true">
          {rank}
        </span>
        <div className="bl-main">
          <div className="bl-name-line">
            <h3 className="bl-name">{f.name}</h3>
            <ContactBadge state={f.contact_state} summary={f.contact_summary} />
          </div>
          {f.rating !== undefined && <Stars rating={f.rating} count={f.review_count} />}
          {f.address && <p className="bl-addr">{f.address}</p>}
          {f.hours_today && <p className="bl-hours">{f.hours_today}</p>}
          {(f.rank_reasons?.length ?? 0) > 0 && (
            <ul className="bl-chips" aria-label="Why it ranked here">
              {f.rank_reasons!.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {f.contact_summary && (
            <p className="bl-contact" title={f.contact_summary}>
              {f.contact_summary}
            </p>
          )}
          <div className="bl-actions">
            <ExternalLinks website={f.website} mapsUrl={f.maps_url} />
            <button type="button" className="hg-btn bl-profile-btn" onClick={toggle} aria-expanded={open}>
              {open ? "Hide profile" : "Profile"}
            </button>
          </div>
        </div>
      </div>
      {open && (
        <div className="bl-profile">
          {profile.isPending && <Skeleton rows={2} />}
          {profile.error && <p className="bl-note bl-note-warn">{toolErrorText(profile.error) ?? "Couldn't load the profile."}</p>}
          {p && (
            <>
              <EvidenceList evidence={p.evidence} limit={3} />
              {(p.unknowns?.length ?? 0) > 0 && (
                <p className="bl-unknowns">
                  <strong>Still unknown:</strong> {p.unknowns!.join("; ")}.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Sends a message to the assistant, on the human's click only (the card never posts by itself). */
function ChatButton({ prompt, children, primary }: { prompt: string; children: ReactNode; primary?: boolean }) {
  const followUp = useSendFollowUp();
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className={`hg-btn${primary ? " hg-btn-primary" : ""}`}
      title={`Sends this message to your assistant: “${prompt}”`}
      onClick={() => void followUp({ prompt }).then(() => setFailed(false)).catch(() => setFailed(true))}
    >
      {children}
      {failed && <span className="bl-err"> (couldn't send; type it in the chat)</span>}
    </button>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
