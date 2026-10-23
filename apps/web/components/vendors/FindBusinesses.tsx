"use client";
// "Find businesses": public listings through the MCP discover tool. Finding a business never lets Haggle
// contact it; "Add as vendor" prefills the form (email by default; a call or text needs stronger consent).
// Listing text is plain text; only http(s) websites and Maps links are links.
import { useState } from "react";
import { contactWords } from "@/lib/vendors/discover";
import type { DiscoverResult, FoundBusiness } from "@/lib/vendors/types";
import { vendorApi, type VendorApiError } from "./api";

const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function FindBusinesses({ vendorNames, onAdd }: { vendorNames: string[]; onAdd: (b: FoundBusiness) => void }) {
  const [category, setCategory] = useState("");
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [failure, setFailure] = useState<VendorApiError | null>(null);
  const known = new Set(vendorNames.map(canon));

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (category.trim().length < 2) {
      setFailure({ code: "bad_body", message: "Say what kind of business to look for.", fix: "For example: caterer, plumber, print shop." });
      return;
    }
    setBusy(true);
    setFailure(null);
    const r = await vendorApi<Omit<DiscoverResult, "ok">>("/api/vendors/discover", { category: category.trim(), area: area.trim() });
    setBusy(false);
    if (!r.ok) {
      setFailure(r.error);
      setResult(null);
    } else setResult(r);
  }

  return (
    <section className="card stack" aria-labelledby="find-h">
      <h2 id="find-h" className="dash-h2">
        Find businesses
      </h2>
      <p className="hint" style={{ margin: 0 }}>
        Search public listings. Haggle contacts none of these until you add one as a vendor.
      </p>
      <form className="vend-grid vend-search" onSubmit={search}>
        <div>
          <label htmlFor="fb-cat">Kind of business</label>
          <input id="fb-cat" value={category} maxLength={100} placeholder="caterer, plumber, print shop" onChange={(e) => setCategory(e.target.value)} />
        </div>
        <div>
          <label htmlFor="fb-area">
            Area <span className="hint">optional: defaults to your workspace&apos;s area</span>
          </label>
          <input id="fb-area" value={area} maxLength={200} placeholder="San Francisco" onChange={(e) => setArea(e.target.value)} />
        </div>
        <div className="vend-search-btn">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
      </form>
      {failure ? (
        <p className="note note-risk" role="alert" style={{ margin: 0 }}>
          {failure.message} <span className="fix">{failure.fix}</span>
        </p>
      ) : null}
      {result ? (
        <div className="stack" aria-live="polite">
          {result.status !== "ok" || !result.found.length ? (
            <p className="note" style={{ margin: 0 }}>
              {result.message || "No businesses found."}
            </p>
          ) : (
            <>
              <ul className="vend-list" aria-label="Businesses found">
                {result.found.map((f) => {
                  const isVendor = known.has(canon(f.name));
                  const cw = contactWords(f, isVendor);
                  return (
                    <li key={f.business_ref} className="vend-item">
                      <div className="vend-main">
                        <div className="dash-row dash-wrap">
                          <strong>{f.name}</strong>
                          {f.rating !== undefined ? (
                            <span className="hint">
                              {f.rating.toFixed(1)}★ ({f.review_count ?? 0} reviews)
                            </span>
                          ) : null}
                          <span className={`chip chip-${cw.tone}`}>{cw.label}</span>
                        </div>
                        {f.address ? <div className="hint">{f.address}</div> : null}
                        <div className="hint dash-row dash-wrap">
                          {f.website ? (
                            <a href={f.website} target="_blank" rel="noopener noreferrer nofollow">
                              Website
                            </a>
                          ) : null}
                          {f.maps_url ? (
                            <a href={f.maps_url} target="_blank" rel="noopener noreferrer nofollow">
                              Google Maps
                            </a>
                          ) : null}
                          <span>{f.phone_published ? "Phone listed publicly" : "No phone listed"}</span>
                        </div>
                      </div>
                      <div className="vend-actions">
                        {isVendor ? (
                          <span className="hint">Already a vendor</span>
                        ) : (
                          <button className="btn" type="button" onClick={() => onAdd(f)}>
                            Add as vendor
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="hint" style={{ margin: 0 }}>
                Listings: Google Maps. To add one, copy the business&apos;s email from its website; a phone call or text needs the business&apos;s agreement or an existing relationship.
              </p>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
