// The discover results card (views/business-list) and the business profile's listing evidence:
// pure helpers in views/_shared/business.ts plus the hook-free pieces rendered to static markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  contactBadge, evidenceGroups, hostOf, isContactable, isUnknownField, quotesPrompt, ratingValue, reviewsText, safeUrl, shortDate, sourceText, starPercent, websiteFrom,
  type EvidenceItem,
} from "../views/_shared/business.ts";
import { ContactBadge, Stars } from "../views/_shared/business-ui.tsx";

// Shaped like discover's found[] for the recorded Places fixture (tests/fixtures/places.json).
const found = [
  { name: "Ace Plumbing & Drain", business_ref: "place:ChIJAcePlumbingOakland01", contact_state: "contact_found", rating: 4.7, review_count: 318 },
  { name: "Bolt's Plumbing", business_ref: "place:ChIJBoltPlumbingOakland02", contact_state: "discovered" },
];

const evidence: EvidenceItem[] = [
  { kind: "third_party_listing", statement: "Listed as plumber at 410 Grand Ave, Oakland, CA 94610, open for business", source: "Google Maps (Places API)", observed_at: "2026-10-18T10:00:00Z", freshness: "fresh", confidence: 0.8 },
  { kind: "third_party_listing", statement: "Publishes a phone number and a website (https://aceplumbing.example/)", source: "Google Maps (Places API)", observed_at: "2026-10-18T10:00:00Z", freshness: "fresh", confidence: 0.8, caveat: "a published contact is not permission to contact" },
  { kind: "third_party_reputation", statement: "4.7★ from 318 Google reviews", source: "Google Maps (Places API)", observed_at: "2026-10-18T10:00:00Z", freshness: "fresh", confidence: 0.9 },
  { kind: "vendor_claim", statement: "From $95 per visit", source: "https://aceplumbing.example/pricing", observed_at: "2026-10-18T10:00:00Z", freshness: "fresh", confidence: 0.4, caveat: "an advertised starting price, not a quote" },
  { kind: "verified", statement: "Quoted Haggle $1,080 by email", source: "Haggle deal job_1", observed_at: "2026-10-01", freshness: "recent", confidence: 0.9 },
  { kind: "inferred_estimate", statement: "Typically ~$27 per unit", source: "Haggle's arithmetic over its own quotes", observed_at: "2026-10-01", confidence: 0.45 },
  { kind: "something_new", statement: "A future kind", source: "x", observed_at: "2026-10-01" },
];

describe("contact state badge", () => {
  it("says plainly whether Haggle may contact the business", () => {
    expect(contactBadge("discovered").label).toBe("Not contactable");
    expect(contactBadge("contact_found").label).toBe("Contact found · not authorized");
    expect(contactBadge("authorized").label).toBe("Haggle may contact");
    expect(contactBadge("verified_responsive").label).toBe("Has replied before");
  });
  it("never reads an unknown state as contactable", () => {
    expect(contactBadge("pending_review")).toMatchObject({ label: "Pending review", tone: "muted" });
    expect(contactBadge(undefined).label).toBe("Contact unknown");
    expect(isContactable("contact_found")).toBe(false);
    expect(isContactable("discovered")).toBe(false);
    expect(isContactable("authorized")).toBe(true);
    expect(isContactable("verified_responsive")).toBe(true);
  });
  it("renders the label with the summary as its tooltip", () => {
    const html = renderToStaticMarkup(createElement(ContactBadge, { state: "contact_found", summary: "Published phone found; not on this server's allowlist." }));
    expect(html).toContain("Contact found · not authorized");
    expect(html).toContain('title="Published phone found; not on this server&#x27;s allowlist."');
    expect(html).toContain("hg-contact-warn");
  });
});

describe("ratings", () => {
  it("formats the rating, reviews and star fill", () => {
    expect(ratingValue(4.66)).toBe("4.7");
    expect(ratingValue(5)).toBe("5.0");
    expect(ratingValue(undefined)).toBeUndefined();
    expect(reviewsText(1)).toBe("1 review");
    expect(reviewsText(1204)).toBe("1,204 reviews");
    expect(reviewsText(undefined)).toBe("0 reviews");
    expect(starPercent(4.7)).toBe(90); // 4.5 stars in half-star steps
    expect(starPercent(9)).toBe(100);
    expect(starPercent(-1)).toBe(0);
  });
  it("renders stars only when there is a rating", () => {
    const html = renderToStaticMarkup(createElement(Stars, { rating: 4.7, count: 318 }));
    expect(html).toContain("4.7");
    expect(html).toContain("318 reviews");
    expect(html).toContain("width:90%");
    expect(renderToStaticMarkup(createElement(Stars, { rating: undefined, count: undefined }))).toBe("");
  });
});

describe("links (untrusted listing data)", () => {
  it("offers only http(s) URLs", () => {
    expect(safeUrl("https://aceplumbing.example/")).toBe("https://aceplumbing.example/");
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("data:text/html,hi")).toBeUndefined();
    expect(safeUrl("not a url")).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
    expect(hostOf("https://www.aceplumbing.example/menu")).toBe("aceplumbing.example");
    expect(sourceText("https://aceplumbing.example/pricing")).toBe("aceplumbing.example");
    expect(sourceText("Google Maps (Places API)")).toBe("Google Maps (Places API)");
  });
  it("finds the website for the profile link: explicit field, then the page read, then the listing", () => {
    expect(websiteFrom({ website: "https://direct.example/", evidence })).toBe("https://direct.example/");
    expect(websiteFrom({ public_listing: { website: "https://listing.example/" } })).toBe("https://listing.example/");
    expect(websiteFrom({ evidence })).toBe("https://aceplumbing.example/pricing");
    expect(websiteFrom({ evidence: evidence.filter((e) => e.kind !== "vendor_claim") })).toBe("https://aceplumbing.example/");
    expect(websiteFrom({ website: "javascript:alert(1)" })).toBeUndefined();
    expect(websiteFrom({})).toBeUndefined();
  });
});

describe("evidence grouped by kind", () => {
  it("orders verified, listing & reviews, website claims, estimates, then anything else", () => {
    const g = evidenceGroups(evidence);
    expect(g.map((x) => x.title)).toEqual(["Verified by Haggle", "Public listing & reviews", "The business's own website (claims)", "Haggle's estimates", "Other"]);
    expect(g[1]!.items).toHaveLength(3); // listing + reputation together
    expect(evidenceGroups([])).toEqual([]);
    expect(evidenceGroups(undefined)).toEqual([]);
  });
  it("leaves out empty groups (a just-discovered business has only listing evidence)", () => {
    expect(evidenceGroups(evidence.slice(0, 3)).map((x) => x.key)).toEqual(["listing"]);
  });
  it("dates read as words", () => {
    expect(shortDate("2026-10-01")).toBe("Oct 1, 2026");
    expect(shortDate("not a date")).toBe("not a date");
  });
});

describe("unknown learned fields are softened before the first quote", () => {
  it("recognises the server's placeholders", () => {
    expect(isUnknownField("Unknown until the business quotes")).toBe(true);
    expect(isUnknownField("Unknown: Haggle hasn't contacted it")).toBe(true);
    expect(isUnknownField(undefined)).toBe(true);
    expect(isUnknownField("From $95 per visit (the business's website: a claim, not a quote)")).toBe(false);
  });
});

describe("Get quotes from these", () => {
  it("names the found businesses and asks for a dry run before anything is sent", () => {
    const p = quotesPrompt(found, [{ name: "Mission Eats", ready: true }], "plumber");
    expect(p).toContain("Ace Plumbing & Drain, Bolt's Plumbing");
    expect(p).toContain("businesses=['Ace Plumbing & Drain', 'Bolt’s Plumbing']");
    expect(p).toContain("dry_run=true");
    expect(p).not.toContain("Mission Eats");
  });
  it("falls back to the ready demo vendors when nothing was found", () => {
    const p = quotesPrompt([], [{ name: "Mission Eats", ready: true }, { name: "Bay Catering", ready: false }]);
    expect(p).toContain("Mission Eats");
    expect(p).not.toContain("Bay Catering");
    expect(quotesPrompt([], [{ name: "Bay Catering", ready: false }])).toContain("no ready vendors");
  });
});
