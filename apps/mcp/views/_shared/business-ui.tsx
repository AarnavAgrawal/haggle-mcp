/** Business pieces shared by the results card (business-list) and the business profile. */
import { useOpenExternal } from "mcp-use/react";
import { contactBadge, evidenceGroups, ratingValue, reviewsText, safeUrl, shortDate, sourceText, starPercent, type EvidenceItem } from "./business.ts";

/** "Not contactable" / "Contact found · not authorized" / "Haggle may contact" / "Has replied before". */
export function ContactBadge({ state, summary }: { state: string | undefined; summary?: string }) {
  const b = contactBadge(state);
  return (
    <span className={`hg-contact hg-contact-${b.tone}`} title={summary || b.hint}>
      <span className="hg-contact-dot" aria-hidden="true" />
      {b.label}
    </span>
  );
}

/** Five stars filled to the rating (half-star steps), the number and the review count. */
export function Stars({ rating, count }: { rating: number | undefined; count: number | undefined }) {
  const value = ratingValue(rating);
  if (!value) return null;
  return (
    <span className="hg-stars" aria-label={`${value} out of 5 stars from ${reviewsText(count)}`}>
      <span className="hg-stars-bar" aria-hidden="true">
        <span className="hg-stars-empty">★★★★★</span>
        <span className="hg-stars-fill" style={{ width: `${starPercent(rating)}%` }}>
          ★★★★★
        </span>
      </span>
      <strong>{value}</strong>
      <span className="hg-muted">({reviewsText(count)})</span>
    </span>
  );
}

/** "Website" and "Google Maps" buttons; each opens only on click and only for http(s) URLs. */
export function ExternalLinks({ website, mapsUrl }: { website?: string; mapsUrl?: string }) {
  const openExternal = useOpenExternal();
  const site = safeUrl(website);
  const maps = safeUrl(mapsUrl);
  if (!site && !maps) return null;
  const open = (url: string) => void openExternal({ url }).catch(() => {});
  return (
    <span className="hg-links">
      {site && (
        <button type="button" className="hg-link" onClick={() => open(site)} title={site}>
          Website ↗
        </button>
      )}
      {maps && (
        <button type="button" className="hg-link" onClick={() => open(maps)} title="Open in Google Maps">
          Google Maps ↗
        </button>
      )}
    </span>
  );
}

/** Evidence grouped by kind: each fact with its source, date and caveat. */
export function EvidenceList({ evidence, limit }: { evidence: EvidenceItem[] | undefined; limit?: number }) {
  const groups = evidenceGroups(evidence);
  if (!groups.length) return null;
  return (
    <div className="hg-evidence">
      {groups.map((g) => (
        <section key={g.key} className={`hg-ev-group hg-ev-${g.key}`} aria-label={g.title}>
          <h3>{g.title}</h3>
          <ul>
            {g.items.slice(0, limit ?? g.items.length).map((e, i) => (
              <li key={`${g.key}-${i}`}>
                <span className="hg-ev-statement">{e.statement}</span>
                <span className="hg-ev-meta">
                  {sourceText(e.source)}
                  {e.observed_at ? ` · ${shortDate(e.observed_at)}` : ""}
                  {e.freshness === "stale" ? " · stale" : ""}
                </span>
                {e.caveat && <span className="hg-ev-caveat">{e.caveat}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
