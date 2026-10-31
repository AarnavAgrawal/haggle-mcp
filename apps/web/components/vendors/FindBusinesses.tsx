"use client";
// "Find businesses": public listings through the MCP discover tool, as one search bar (kind of business
// + area) and a results list. Finding a business never lets Haggle contact it: "Add" opens the add form
// prefilled (email by default; a call or text needs stronger consent) and carries the listing ref, so
// the server keeps the business's opening hours with the vendor. Listing text is plain text; only
// http(s) websites and Maps links are links. A rating or Maps link shows only when the listing has one.
import { useRef, useState, type Ref, type RefObject } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { Status } from "@/components/ui/Status";
import { searchOutcome } from "@/lib/vendors/present";
import type { DiscoverResult, FoundBusiness } from "@/lib/vendors/types";
import { vendorApi, type VendorApiError } from "./api";

interface Props {
  inputRef?: Ref<HTMLInputElement>;
  isVendor: (name: string) => boolean;
  canAdd: boolean;
  onAdd: (b: FoundBusiness) => void;
  /** Open the add form empty (when search can't help). */
  onAddBlank: () => void;
}

export function FindBusinesses({ inputRef, isVendor, canAdd, onAdd, onAddBlank }: Props) {
  const areaRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState("");
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(DiscoverResult & { asked: { category: string; area: string } }) | null>(null);
  const [failure, setFailure] = useState<VendorApiError | null>(null);
  const [invalid, setInvalid] = useState(false);

  function search(e: React.FormEvent) {
    e.preventDefault();
    const asked = { category: category.trim(), area: area.trim() };
    if (asked.category.length < 2) {
      setInvalid(true);
      setFailure(null);
      return;
    }
    setInvalid(false);
    void run(asked);
  }

  async function run(asked: { category: string; area: string }) {
    setBusy(true);
    setFailure(null);
    const r = await vendorApi<Omit<DiscoverResult, "ok">>("/api/vendors/discover", asked);
    setBusy(false);
    if (!r.ok) {
      setFailure(r.error);
      setResult(null);
    } else setResult({ ...r, asked });
  }

  const found = result?.status === "ok" ? result.found : [];
  return (
    <section className="vend-find" aria-labelledby="find-h">
      <h2 id="find-h" className="sr-only">
        Find businesses
      </h2>
      <form className="vend-bar" role="search" aria-label="Find businesses" onSubmit={search} noValidate>
        <div className={`vend-bar-field vend-bar-what${invalid ? " is-invalid" : ""}`}>
          <Icon name="search" size={20} className="vend-bar-icon" />
          <label htmlFor="fb-cat">Find businesses</label>
          <input
            ref={inputRef}
            id="fb-cat"
            value={category}
            maxLength={100}
            placeholder="Caterer, plumber, print shop"
            autoComplete="off"
            enterKeyHint="search"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "fb-cat-err" : undefined}
            onChange={(e) => {
              setCategory(e.target.value);
              if (invalid && e.target.value.trim().length >= 2) setInvalid(false);
            }}
          />
        </div>
        <div className="vend-bar-field vend-bar-where">
          <label htmlFor="fb-area">Near</label>
          <input ref={areaRef} id="fb-area" value={area} maxLength={200} placeholder="Your workspace's area" autoComplete="address-level2" enterKeyHint="search" onChange={(e) => setArea(e.target.value)} />
        </div>
        <Button type="submit" variant="primary" className="vend-bar-go" pending={busy}>
          Search
        </Button>
      </form>
      {invalid ? (
        <p className="vend-bar-err" id="fb-cat-err" role="alert">
          Say what kind of business to look for, like caterer or plumber.
        </p>
      ) : null}

      <div aria-live="polite" aria-busy={busy || undefined}>
        {failure ? (
          <p className="note note-risk vend-find-note" role="alert">
            {failure.message} <span className="fix">{failure.fix}</span>
          </p>
        ) : null}

        {busy ? (
          <ul className="ui-sheet ui-sheet-pad-none vend-results" aria-label="Searching">
            {[0, 1, 2].map((i) => (
              <li key={i} className="vr-row">
                <div className="vr-main">
                  <Skeleton w={i === 1 ? 180 : 220} h={16} />
                  <Skeleton w={i === 2 ? 200 : 280} h={12} />
                </div>
                <Skeleton w={64} h={32} />
              </li>
            ))}
          </ul>
        ) : result ? (
          found.length ? (
            <div className="vend-results-wrap">
              <div className="vr-head">
                <p className="vr-summary">
                  <span className="num">{found.length}</span> {found.length === 1 ? "business" : "businesses"} for <strong>{result.asked.category}</strong>
                  {result.asked.area ? (
                    <>
                      {" "}near <strong>{result.asked.area}</strong>
                    </>
                  ) : null}
                </p>
                <Button variant="quiet" size="s" onClick={() => setResult(null)}>
                  Clear
                </Button>
              </div>
              <ul className="ui-sheet ui-sheet-pad-none vend-results" aria-label="Businesses found">
                {found.map((f) => (
                  <ResultRow key={f.business_ref} f={f} vendor={isVendor(f.name)} canAdd={canAdd} onAdd={onAdd} />
                ))}
              </ul>
              <p className="vr-foot">
                Listings from {result.attribution ?? "public listings"}. Haggle contacts none of these until you add them.
              </p>
            </div>
          ) : (
            <NoResults result={result} onAddBlank={onAddBlank} canAdd={canAdd} areaRef={areaRef} onRetry={() => run(result.asked)} onClear={() => setResult(null)} />
          )
        ) : null}
      </div>
    </section>
  );
}

function NoResults({ result, canAdd, areaRef, onAddBlank, onRetry, onClear }: { result: DiscoverResult & { asked: { category: string; area: string } }; canAdd: boolean; areaRef: RefObject<HTMLInputElement | null>; onAddBlank: () => void; onRetry: () => void; onClear: () => void }) {
  const o = searchOutcome(result.status, result.message, result.asked);
  return (
    <div className="ui-sheet vr-none">
      <p>
        <strong>{o.title}</strong> {o.body}
      </p>
      <div className="vr-none-act">
        {o.next === "add" && canAdd ? (
          <Button size="s" onClick={onAddBlank}>
            Add one you already use
          </Button>
        ) : o.next === "area" ? (
          <Button size="s" onClick={() => areaRef.current?.focus()}>
            Add an area
          </Button>
        ) : o.next === "retry" ? (
          <Button size="s" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        <Button variant="quiet" size="s" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

function ResultRow({ f, vendor, canAdd, onAdd }: { f: FoundBusiness; vendor: boolean; canAdd: boolean; onAdd: (b: FoundBusiness) => void }) {
  const email = f.emails?.[0];
  return (
    <li className="vr-row">
      <div className="vr-main">
        <p className="vr-name">
          <strong>{f.name}</strong>
          {f.rating !== undefined ? (
            <span className="vr-rating">
              <span className="num">{f.rating.toFixed(1)}</span> stars
              <span className="vr-dim">
                {" "}
                (<span className="num">{f.review_count ?? 0}</span>)
              </span>
            </span>
          ) : null}
        </p>
        {f.address ? <p className="vr-addr">{f.address}</p> : null}
        <ul className="vr-facts">
          <li>
            <Icon name="mail" />
            {email ? <span className="vr-email">{email}</span> : <span className="vr-dim">No published email</span>}
          </li>
          {f.hours_today ? (
            <li>
              <Icon name="clock" />
              {f.hours_today}
            </li>
          ) : null}
          {f.phone_published ? (
            <li>
              <Icon name="phone" />
              Phone listed
            </li>
          ) : null}
          {f.website ? (
            <li>
              <a href={f.website} target="_blank" rel="noopener noreferrer nofollow">
                Website
                <Icon name="external" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
          ) : null}
          {f.maps_url ? (
            <li>
              <a href={f.maps_url} target="_blank" rel="noopener noreferrer nofollow">
                Map
                <Icon name="external" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
          ) : null}
        </ul>
      </div>
      <div className="vr-act">
        {vendor ? (
          <Status tone="ok">Your vendor</Status>
        ) : canAdd ? (
          <Button size="s" onClick={() => onAdd(f)} aria-label={`Add ${f.name} as a vendor`}>
            <Icon name="plus" />
            Add
          </Button>
        ) : null}
      </div>
    </li>
  );
}
