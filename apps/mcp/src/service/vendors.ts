// Service routes for a workspace's own vendors, added self-serve from the web app with the consent each
// rests on (the operator's scripts/workspace-admin.ts add-vendor is the other way in). A deal contacts
// only these vendors (plus the server allowlist); suppressions (opt-out, bounce) always win.
//   GET  /internal/vendors          this workspace's vendors, full contact (the web shows it only to members)
//   POST /internal/vendors          { name, contact, channel?, consent_basis, note? } (x-haggle-actor required)
//   POST /internal/vendors/remove   { contact } (x-haggle-actor required)
// Consent rules: a public listing allows email only (no calls or texts to a business that only has a
// public listing); a call or text needs an existing relationship or the business's agreement.
// Limits: at most MAX_VENDORS per workspace and MAX_ADDS_PER_DAY additions per workspace per UTC day,
// the daily count in memory per server process (several instances each count on their own).
import { z } from "zod";
import { simulatedContact, type Channel, type HaggleEngine } from "@haggle/engine";
import { engineError, fail, serviceGuard, type ServiceApp, type ServiceContext } from "./http.ts";

export const MAX_VENDORS = 100;
export const MAX_ADDS_PER_DAY = 25;
export const CONSENT_BASES = ["existing_relationship", "business_agreed", "public_listing_email"] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];
type VendorChannel = "email" | "phone" | "imessage";

/** Additions per workspace per UTC day, in memory (one server process). */
export class DailyAdds {
  private counts = new Map<string, { day: string; n: number }>();
  constructor(private readonly max = MAX_ADDS_PER_DAY, private readonly now: () => Date = () => new Date()) {}
  private today() { return this.now().toISOString().slice(0, 10); }
  used(ws: string): number {
    const c = this.counts.get(ws);
    return c && c.day === this.today() ? c.n : 0;
  }
  allowed(ws: string): boolean { return this.used(ws) < this.max; }
  record(ws: string): void {
    if (this.counts.size > 50_000) this.counts.clear();
    this.counts.set(ws, { day: this.today(), n: this.used(ws) + 1 });
  }
}

/** The engine calls these routes make (HaggleEngine in production; tests may pass the same). */
type VendorEngine = Pick<HaggleEngine, "workspaceVendors" | "addWorkspaceVendor" | "removeWorkspaceVendor" | "contactSuppressions" | "getSettings">;
export interface VendorRouteOptions {
  guard?: (c: ServiceContext, opts: { workspace?: boolean }) => Promise<{ rt: { engine: VendorEngine; mode: "mock" | "live" }; workspaceId: string | null; actor: string | null } | Response>;
  daily?: DailyAdds;
  now?: () => Date;
}

/** An email lowercased, a phone without spaces and punctuation (the engine's own normalization). */
export const normalizeContact = (c: string) => (c.includes("@") ? c.trim().toLowerCase() : c.replace(/[\s().-]/g, ""));
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

const AddBody = z.object({
  name: z.string().transform(plain).pipe(z.string().min(1).max(120)),
  contact: z.string().min(3).max(254).transform(normalizeContact).refine((c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) || /^\+[1-9]\d{6,14}$/.test(c), "an email address or an E.164 phone number (+14155550123)"),
  channel: z.enum(["email", "phone", "imessage"]).optional(),
  consent_basis: z.enum(CONSENT_BASES),
  note: z.string().max(300).transform(plain).optional(),
});
const RemoveBody = z.object({ contact: z.string().min(3).max(254).transform(normalizeContact) });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

/** Why this basis can't support this channel, or null. A published listing never authorizes a call or a text. */
export function consentProblem(basis: ConsentBasis, channel: VendorChannel): string | null {
  if (basis === "public_listing_email" && channel !== "email") return "A business found only through a public listing may be contacted by email only; calls and texts need an existing relationship or the business's agreement.";
  return null;
}

/** The consent recorded on the row: `<basis>: <note> (attested by web:<actor> at <ISO time>)`. */
export function consentText(basis: ConsentBasis, note: string | undefined, actor: string, at: Date): string {
  return `${basis}${note ? `: ${note}` : ""} (attested by web:${actor} at ${at.toISOString()})`;
}

/** The basis a recorded consent names; an operator-recorded consent (workspace-admin) has none of ours. */
export const consentBasisOf = (consent: string): ConsentBasis | "operator_recorded" => CONSENT_BASES.find((b) => consent.startsWith(b)) ?? "operator_recorded";

export function registerVendorRoutes(app: ServiceApp, opts: VendorRouteOptions = {}) {
  const guard = opts.guard ?? (serviceGuard as unknown as NonNullable<VendorRouteOptions["guard"]>);
  const daily = opts.daily ?? new DailyAdds();
  const now = opts.now ?? (() => new Date());

  app.get("/internal/vendors", async (c) => {
    const g = await guard(c, { workspace: true });
    if (g instanceof Response) return g;
    const ws = g.workspaceId!;
    const rows = await g.rt.engine.workspaceVendors(ws);
    const sup = new Map((rows.length ? await g.rt.engine.contactSuppressions(rows.map((r) => r.contact)) : []).map((s) => [s.contact, s.reason]));
    const vendors = rows.map((r) => {
      const s = sup.get(r.contact.toLowerCase());
      return {
        name: r.name, contact: r.contact, channel: r.channel ?? (r.contact.includes("@") ? "email" : "phone"),
        consent: { basis: consentBasisOf(r.consent), text: r.consent }, added_by: r.added_by, added_at: r.created_at,
        contactable: !s, ...(s ? { suppressed: s } : {}),
      };
    });
    return c.json({
      ok: true, mode: g.rt.mode, vendors,
      limits: { max_vendors: MAX_VENDORS, adds_per_day: MAX_ADDS_PER_DAY, added_today: daily.used(ws) },
      next: vendors.length ? "Start a deal from the chat; Haggle contacts these vendors by name." : "Add the businesses you work with (POST /internal/vendors) before starting a deal.",
    });
  });

  app.post("/internal/vendors", async (c) => {
    const g = await guard(c, { workspace: true });
    if (g instanceof Response) return g;
    if (!g.actor) return fail(c, 400, "ACTOR_REQUIRED", "Adding a vendor records who attested its consent.", "Send x-haggle-actor with the signed-in user.");
    const ws = g.workspaceId!;
    const parsed = AddBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "INVALID_INPUT", issues(parsed.error), "Pass name, contact (email or E.164 phone), optional channel (email, phone or imessage), consent_basis (existing_relationship, business_agreed or public_listing_email) and an optional note.");
    const b = parsed.data;
    const isEmail = b.contact.includes("@");
    const channel: VendorChannel = b.channel ?? (isEmail ? "email" : "phone");
    if ((channel === "email") !== isEmail) return fail(c, 400, "BAD_CHANNEL", `Channel ${channel} doesn't fit ${isEmail ? "an email address" : "a phone number"}.`, "Use email for an address; phone (a call) or imessage (a text) for a number.");
    const weak = consentProblem(b.consent_basis, channel);
    if (weak) return fail(c, 422, "CONSENT_TOO_WEAK", weak, "Add the business's email instead, or choose 'existing relationship' or 'the business agreed' if that is true.");
    if (g.rt.mode === "live") {
      const sim = simulatedContact(b.contact);
      if (sim) return fail(c, 422, "SIMULATED_CONTACT", `${b.contact} is ${sim}, not a real business.`, "Add the business's real email or phone number.");
    }
    const settings = await g.rt.engine.getSettings(ws);
    if (b.contact === settings.approver_phone || b.contact === settings.approver_email?.toLowerCase()) {
      return fail(c, 422, "RESERVED_FOR_APPROVALS", "That is the approver's own contact; it is reserved for approvals.", "Add the business's own email or phone number.");
    }
    const [suppressed] = await g.rt.engine.contactSuppressions([b.contact]);
    if (suppressed) {
      return fail(c, 422, "CONTACT_SUPPRESSED", suppressed.reason === "opt_out" ? `${b.contact} asked not to be contacted by Haggle.` : `Mail to ${b.contact} bounced.`,
        suppressed.reason === "opt_out" ? "Haggle never contacts a business that opted out. Choose another business, or another contact the business gave you." : "Check the address with the business and add the correct one.");
    }
    const existing = await g.rt.engine.workspaceVendors(ws);
    const replacing = existing.some((v) => v.contact === b.contact);
    if (!replacing && existing.length >= MAX_VENDORS) return fail(c, 409, "VENDOR_LIMIT", `This workspace already has ${existing.length} vendors (the limit is ${MAX_VENDORS}).`, "Remove vendors you no longer use, then add this one.");
    if (!daily.allowed(ws)) return fail(c, 429, "DAILY_LIMIT", `This workspace added ${MAX_ADDS_PER_DAY} vendors today (the daily limit).`, "Try again tomorrow (UTC).");
    try {
      const row = await g.rt.engine.addWorkspaceVendor({
        workspace_id: ws, contact: b.contact, name: b.name, channel: channel as Channel,
        consent: consentText(b.consent_basis, b.note || undefined, g.actor, now()), added_by: `web:${g.actor}`.slice(0, 120),
      });
      daily.record(ws);
      return c.json({
        ok: true, replaced: replacing,
        vendor: { name: row.name, contact: row.contact, channel: row.channel ?? channel, consent: { basis: b.consent_basis, text: row.consent }, added_by: row.added_by, added_at: row.created_at, contactable: true },
        next: `Haggle may now contact ${row.name} by ${channel === "email" ? "email" : channel === "phone" ? "a Voice AI call" : "text"} on this workspace's deals.`,
      }, replacing ? 200 : 201);
    } catch (err) {
      return engineError(c, err);
    }
  });

  app.post("/internal/vendors/remove", async (c) => {
    const g = await guard(c, { workspace: true });
    if (g instanceof Response) return g;
    if (!g.actor) return fail(c, 400, "ACTOR_REQUIRED", "Removing a vendor records who removed it.", "Send x-haggle-actor with the signed-in user.");
    const parsed = RemoveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "INVALID_INPUT", issues(parsed.error), "Pass the vendor's contact.");
    const removed = await g.rt.engine.removeWorkspaceVendor(g.workspaceId!, parsed.data.contact);
    if (!removed) return fail(c, 404, "NOT_FOUND", "That contact isn't one of this workspace's vendors.", "Reload the vendor list.");
    return c.json({ ok: true, removed: parsed.data.contact, next: "Haggle won't contact this vendor on new deals, nor make first contact on a running deal; a conversation it already started continues." });
  });
}
