// The "Add vendor" form rules (lib/vendors/form.ts), the discover results mapping and the chat's
// "Add vendors first" hint. Pure functions; no network.
import { describe, expect, it } from "vitest";
import { toDiscoverResult, safeHttpUrl, contactWords } from "../lib/vendors/discover.ts";
import { basisAllows, normalizeContact, validateVendorForm } from "../lib/vendors/form.ts";
import { vendorSetupHint } from "../lib/vendors/setup.ts";

const good = { name: "Casa Lunch", contact: "orders@casalunch.com", consent_basis: "public_listing_email", attested: true };

describe("normalizeContact", () => {
  it("lowercases emails and turns phone numbers into E.164 (10 digits read as US/Canada)", () => {
    expect(normalizeContact(" Orders@CasaLunch.com ")).toEqual({ kind: "email", value: "orders@casalunch.com" });
    expect(normalizeContact("(415) 555-0123")).toEqual({ kind: "phone", value: "+14155550123" });
    expect(normalizeContact("1 415 555 0123")).toEqual({ kind: "phone", value: "+14155550123" });
    expect(normalizeContact("+44 20 7946 0958")).toEqual({ kind: "phone", value: "+442079460958" });
    expect(normalizeContact("555-0123")).toBeNull();
    expect(normalizeContact("call me maybe")).toBeNull();
    expect(normalizeContact("orders@")).toBeNull();
  });
});

describe("validateVendorForm", () => {
  it("accepts a public-listing email and defaults the channel from the contact", () => {
    expect(validateVendorForm(good)).toEqual({ ok: true, value: { name: "Casa Lunch", contact: "orders@casalunch.com", channel: "email", consent_basis: "public_listing_email" } });
    const phone = validateVendorForm({ name: " Pipes\u0007 Co ", contact: "415-555-0199", consent_basis: "business_agreed", note: "  Owner said yes  ", attested: true });
    expect(phone).toEqual({ ok: true, value: { name: "Pipes Co", contact: "+14155550199", channel: "phone", consent_basis: "business_agreed", note: "Owner said yes" } });
    expect(validateVendorForm({ ...good, contact: "+14155550199", channel: "imessage", consent_basis: "existing_relationship" })).toMatchObject({ ok: true, value: { channel: "imessage" } });
  });

  it("passes on a listing ref from Find businesses (for its opening hours); anything else is dropped", () => {
    expect(validateVendorForm({ ...good, business_ref: "aws:AQAAAEFjZVBsdW1i" })).toMatchObject({ ok: true, value: { business_ref: "aws:AQAAAEFjZVBsdW1i" } });
    expect(validateVendorForm({ ...good, business_ref: "place:ChIJace0001" })).toMatchObject({ ok: true, value: { business_ref: "place:ChIJace0001" } });
    for (const bad of ["javascript:alert(1)", "aws:<script>", 42]) expect(validateVendorForm({ ...good, business_ref: bad })).toEqual({ ok: true, value: expect.not.objectContaining({ business_ref: expect.anything() }) });
  });

  it("never allows a call or text on a public listing", () => {
    expect(basisAllows("public_listing_email", "phone")).toBe(false);
    expect(basisAllows("business_agreed", "imessage")).toBe(true);
    const r = validateVendorForm({ ...good, contact: "+14155550199" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.consent_basis).toMatch(/never called or texted/);
    const t = validateVendorForm({ ...good, contact: "+14155550199", channel: "imessage" });
    expect(t.ok).toBe(false);
  });

  it("requires the attestation, a name, a contact and a basis; a channel must fit the contact", () => {
    const r = validateVendorForm({ name: "", contact: "", attested: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["attested", "consent_basis", "contact", "name"]);
    const unattested = validateVendorForm({ ...good, attested: "true" });
    expect(unattested.ok).toBe(false);
    const mismatch = validateVendorForm({ ...good, channel: "phone" });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.errors.channel).toMatch(/reached by email/);
    expect(validateVendorForm({ ...good, channel: "fax" }).ok).toBe(false);
    expect(validateVendorForm({ ...good, consent_basis: "they_said_ok" }).ok).toBe(false);
    expect(validateVendorForm({ ...good, name: "x".repeat(121) }).ok).toBe(false);
    expect(validateVendorForm({ ...good, note: "x".repeat(301) }).ok).toBe(false);
  });
});

describe("discover results", () => {
  it("keeps only http(s) links and plain-text fields", () => {
    expect(safeHttpUrl("https://casalunch.com/menu")).toBe("https://casalunch.com/menu");
    expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpUrl("data:text/html,hi")).toBeUndefined();
    expect(safeHttpUrl("/relative")).toBeUndefined();
    const r = toDiscoverResult({
      mode: "live",
      public_discovery: { status: "ok", message: "2 found" },
      found: [
        { name: "Casa\nLunch", business_ref: "gp_1", rating: 4.6, review_count: 120, website: "javascript:alert(1)", maps_url: "https://maps.google.com/?cid=1", phone_published: true, contact_state: "contact_found", contact_summary: "phone published, not authorized" },
        { name: "", business_ref: "gp_2" },
      ],
    });
    expect(r).toEqual({
      ok: true, mode: "live", status: "ok", message: "2 found",
      found: [{ name: "Casa Lunch", business_ref: "gp_1", rating: 4.6, review_count: 120, maps_url: "https://maps.google.com/?cid=1", phone_published: true, contact_state: "contact_found", contact_summary: "phone published, not authorized" }],
    });
    expect(contactWords(r.found[0]!, false).tone).toBe("plain");
    expect(contactWords(r.found[0]!, true).label).toBe("Haggle may contact it");
  });

  it("keeps up to three well-formed website emails, lowercased", () => {
    const r = toDiscoverResult({ mode: "live", public_discovery: { status: "ok", message: "1 found" }, found: [{ name: "Casa Lunch", business_ref: "place:1", published_emails: ["Orders@CasaLunch.com", "not an email", 7, "a@b.co", "c@d.co", "e@f.co"] }] });
    expect(r.found[0]!.emails).toEqual(["orders@casalunch.com", "a@b.co", "c@d.co"]);
    const none = toDiscoverResult({ mode: "live", found: [{ name: "Quiet", business_ref: "place:2", published_emails: [] }] });
    expect(none.found[0]).not.toHaveProperty("emails");
  });

  it("Amazon Location results: hours today and the provider's attribution; no rating or Maps link invented", () => {
    const r = toDiscoverResult({ mode: "live", public_discovery: { status: "ok", message: "1 found" }, found: [{ name: "Ace Plumbing", business_ref: "aws:AQAAAEFjZQ", hours_today: "Open today 8am–5pm", attribution: "Amazon Location Service (data © HERE)", published_emails: ["dispatch@ace.example"], contact_state: "contact_found" }] });
    expect(r.attribution).toBe("Amazon Location Service (data © HERE)");
    expect(r.found[0]).toMatchObject({ hours_today: "Open today 8am–5pm", emails: ["dispatch@ace.example"] });
    expect(r.found[0]).not.toHaveProperty("rating");
    expect(r.found[0]).not.toHaveProperty("maps_url");
  });

  it("says when discovery is off", () => {
    expect(toDiscoverResult({ mode: "mock", public_discovery: { status: "not_configured", message: "Real-business discovery is off" } })).toMatchObject({ status: "not_configured", found: [] });
  });
});

describe("vendorSetupHint", () => {
  it("points to /vendors when a deal started nothing for lack of vendors", () => {
    const text = "NOT STARTED: none of the 0 demo vendors can be contacted from this server yet. Nothing was sent.\nThis workspace has no vendors of its own yet: ...";
    expect(vendorSetupHint({ ok: false, job: null, setup: { ready: 0, total: 0, blockers: [] } }, text)).toMatchObject({ href: "/vendors", label: "Add vendors first", reason: expect.stringMatching(/no vendors yet/) });
    expect(vendorSetupHint({ ok: false, job: null, setup: { ready: 0, total: 3, blockers: [] } })).toMatchObject({ reason: expect.stringMatching(/can be contacted right now/) });
    expect(vendorSetupHint({ ok: true, job: null, dry_run: true, would_contact: [] })).not.toBeNull();
  });
  it("is null for a started deal or a dry run that reaches someone", () => {
    expect(vendorSetupHint({ ok: true, job: { id: "job_1" }, setup: { ready: 0, total: 0 } })).toBeNull();
    expect(vendorSetupHint({ ok: true, job: null, dry_run: true, would_contact: [{ name: "A" }] })).toBeNull();
    expect(vendorSetupHint(null)).toBeNull();
  });
});
