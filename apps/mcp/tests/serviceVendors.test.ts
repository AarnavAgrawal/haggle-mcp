// Self-serve vendors (service/vendors.ts), in process: a real engine on the in-memory store, a fake
// service guard. Consent rules, suppression, the approver's reserved contacts, simulated contacts in
// live mode, both limits, and workspace isolation. The HTTP path is serviceVendors.e2e.test.ts.
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, StubBrain } from "@haggle/engine";
import type { ServiceApp, ServiceContext, ServiceHandler } from "../src/service/http.ts";
import { consentBasisOf, consentProblem, consentText, DailyAdds, MAX_VENDORS, registerVendorRoutes } from "../src/service/vendors.ts";

/** `slots`: the store's shared rate slots ("shared", migration 124), none (an older store), or failing (the table missing). */
async function setup(mode: "mock" | "live" = "live", now = () => new Date("2026-10-22T18:00:00Z"), slots: "shared" | "none" | "failing" = "shared") {
  const repo = new InMemoryRepository({ now });
  if (slots === "none") Object.assign(repo, { takeRateSlot: undefined, rateSlotUsed: undefined });
  if (slots === "failing") Object.assign(repo, { takeRateSlot: async () => { throw new Error('relation "rate_limit_slots" does not exist'); }, rateSlotUsed: async () => { throw new Error('relation "rate_limit_slots" does not exist'); } });
  const engine = new HaggleEngine({
    repo, extractor: { async extract() { throw new Error("unused"); } } as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send() { throw new Error("unused"); } },
    config: { mode, inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1, recipientAllowlist: [] },
  });
  for (const id of ["ws_alpha", "ws_beta"]) await repo.insertWorkspace({ id, name: id, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
  await engine.updateSettings({ approver_phone: "+14155550999" }, "ws_alpha", "operator");
  /** One server process's routes (its own in-memory fallback count) over the shared engine and store. */
  function server(daily: DailyAdds) {
    const routes = new Map<string, ServiceHandler>();
    const app: ServiceApp = { get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) };
    registerVendorRoutes(app, {
      daily, now,
      guard: async (c) => {
        const ws = c.req.header("x-haggle-workspace") ?? null;
        if (!ws || !(await repo.getWorkspace(ws))) return Response.json({ ok: false, error: { code: "UNAUTHORIZED" } }, { status: 401 });
        return { rt: { engine, mode }, workspaceId: ws, actor: c.req.header("x-haggle-actor") ?? null };
      },
    });
    async function call(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = { "x-haggle-workspace": "ws_alpha", "x-haggle-actor": "user-1" }) {
      const c: ServiceContext = {
        req: { header: (n) => headers[n.toLowerCase()], json: async () => body, param: () => undefined, query: () => undefined },
        json: (b, status = 200) => Response.json(b, { status }),
      };
      const res = await routes.get(`${method} ${path}`)!(c);
      return { status: res.status, body: (await res.json()) as any };
    }
    const add = (b: Record<string, unknown>, headers?: Record<string, string>) => call("POST", "/internal/vendors", b, headers);
    return { call, add };
  }
  const daily = new DailyAdds(25, now);
  const { call, add } = server(daily);
  return { repo, engine, call, add, daily, server };
}

describe("consent helpers", () => {
  it("a public listing allows email only; the recorded text names the basis, note, actor and time", () => {
    expect(consentProblem("public_listing_email", "email")).toBeNull();
    expect(consentProblem("public_listing_email", "phone")).toMatch(/email only/);
    expect(consentProblem("public_listing_email", "imessage")).toMatch(/email only/);
    expect(consentProblem("business_agreed", "phone")).toBeNull();
    const t = consentText("business_agreed", "Owner said yes by phone", "user-1", new Date("2026-10-22T18:00:00Z"));
    expect(t).toBe("business_agreed: Owner said yes by phone (attested by web:user-1 at 2026-10-22T18:00:00.000Z)");
    expect(consentBasisOf(t)).toBe("business_agreed");
    expect(consentBasisOf("Owner agreed by phone 2026-10-20")).toBe("operator_recorded");
  });
});

describe("/internal/vendors (in process)", () => {
  it("adds with the recorded consent, lists, and removes; the deal roster sees it", async () => {
    const { call, add, engine } = await setup();
    const r = await add({ name: "  Casa Lunch ", contact: " Orders@CasaLunch.com ", consent_basis: "public_listing_email", note: "Email on their website" });
    expect(r.status).toBe(201);
    expect(r.body.vendor).toMatchObject({ name: "Casa Lunch", contact: "orders@casalunch.com", channel: "email", added_by: "web:user-1" });
    expect(r.body.vendor.consent.text).toMatch(/^public_listing_email: Email on their website \(attested by web:user-1 at 2026-10-22T18:00:00.000Z\)$/);
    const phone = await add({ name: "Casa Lunch", contact: "+1 (415) 555-2161", channel: "imessage", consent_basis: "existing_relationship" });
    expect(phone.status).toBe(201);
    expect(phone.body.vendor).toMatchObject({ contact: "+14155552161", channel: "imessage" });
    expect(await engine.mayContact({ email: "orders@casalunch.com" }, "ws_alpha")).toBe(true);

    const list = await call("GET", "/internal/vendors");
    expect(list.body.vendors.map((v: { contact: string }) => v.contact)).toEqual(["orders@casalunch.com", "+14155552161"]);
    expect(list.body.vendors[1].consent.basis).toBe("existing_relationship");
    expect(list.body.limits).toEqual({ max_vendors: 100, adds_per_day: 25, added_today: 2 });

    expect((await call("POST", "/internal/vendors/remove", { contact: "ORDERS@casalunch.com" })).status).toBe(200);
    expect((await call("POST", "/internal/vendors/remove", { contact: "orders@casalunch.com" })).status).toBe(404);
    expect(await engine.mayContact({ email: "orders@casalunch.com" }, "ws_alpha")).toBe(false);
  });

  it("refuses a call or text on a public listing, a channel that doesn't fit, bad input and a missing actor", async () => {
    const { add } = await setup();
    const weak = await add({ name: "Pipes", contact: "+14155552000", consent_basis: "public_listing_email" });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe("CONSENT_TOO_WEAK");
    expect((await add({ name: "Pipes", contact: "+14155552000", channel: "imessage", consent_basis: "public_listing_email" })).body.error.code).toBe("CONSENT_TOO_WEAK");
    expect((await add({ name: "Pipes", contact: "a@pipes.com", channel: "phone", consent_basis: "business_agreed" })).body.error.code).toBe("BAD_CHANNEL");
    expect((await add({ name: "Pipes", contact: "4155552000", consent_basis: "business_agreed" })).body.error.code).toBe("INVALID_INPUT");
    expect((await add({ name: "Pipes", contact: "a@pipes.com", consent_basis: "they_said_ok" })).body.error.code).toBe("INVALID_INPUT");
    const noActor = await add({ name: "Pipes", contact: "a@pipes.com", consent_basis: "business_agreed" }, { "x-haggle-workspace": "ws_alpha" });
    expect(noActor.body.error.code).toBe("ACTOR_REQUIRED");
  });

  it("refuses a suppressed (opted-out or bounced) contact with a fix", async () => {
    const { add, repo } = await setup();
    await repo.addSuppression({ contact: "stop@nomore.com", reason: "opt_out", job_id: null, evidence: "STOP" });
    await repo.addSuppression({ contact: "+14155552222", reason: "opt_out", job_id: null, evidence: "STOP" });
    const r = await add({ name: "No More", contact: "Stop@NoMore.com", consent_basis: "business_agreed" });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: "CONTACT_SUPPRESSED", message: expect.stringMatching(/asked not to be contacted/), fix: expect.stringMatching(/never contacts a business that opted out/) });
    expect((await add({ name: "No More", contact: "+1 415 555 2222", consent_basis: "existing_relationship" })).body.error.code).toBe("CONTACT_SUPPRESSED");
  });

  it("refuses the approver's own contact, and simulated contacts on a live server (allowed in demo mode)", async () => {
    const live = await setup("live");
    expect((await live.add({ name: "Me", contact: "+14155550999", consent_basis: "existing_relationship" })).body.error.code).toBe("RESERVED_FOR_APPROVALS");
    expect((await live.add({ name: "Sim", contact: "x@mission-eats.sim.haggle.dev", consent_basis: "business_agreed" })).body.error.code).toBe("SIMULATED_CONTACT");
    expect((await live.add({ name: "Ex", contact: "x@example.com", consent_basis: "business_agreed" })).body.error.code).toBe("SIMULATED_CONTACT");
    const demo = await setup("mock");
    expect((await demo.add({ name: "Ex", contact: "x@example.com", consent_basis: "business_agreed" })).status).toBe(201);
  });

  it("another workspace can't see or remove them", async () => {
    const { add, call } = await setup();
    await add({ name: "Casa Lunch", contact: "orders@casalunch.com", consent_basis: "business_agreed" });
    const beta = { "x-haggle-workspace": "ws_beta", "x-haggle-actor": "user-2" };
    expect((await call("GET", "/internal/vendors", undefined, beta)).body.vendors).toEqual([]);
    expect((await call("POST", "/internal/vendors/remove", { contact: "orders@casalunch.com" }, beta)).status).toBe(404);
    expect((await call("GET", "/internal/vendors")).body.vendors).toHaveLength(1);
    expect((await call("GET", "/internal/vendors", undefined, { "x-haggle-workspace": "ws_nope" })).status).toBe(401);
  });

  it("limits: 25 additions per workspace per UTC day, 100 vendors per workspace (re-authorizing one doesn't count against the cap)", async () => {
    let t = new Date("2026-10-22T18:00:00Z");
    const { add, engine } = await setup("live", () => t);
    for (let i = 0; i < 25; i++) expect((await add({ name: `V${i}`, contact: `v${i}@vendors.com`, consent_basis: "business_agreed" })).status).toBe(201);
    const over = await add({ name: "V25", contact: "v25@vendors.com", consent_basis: "business_agreed" });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("DAILY_LIMIT");
    expect((await add({ name: "Beta", contact: "b@vendors.com", consent_basis: "business_agreed" }, { "x-haggle-workspace": "ws_beta", "x-haggle-actor": "u" })).status).toBe(201);
    t = new Date("2026-10-23T00:00:01Z");
    expect((await add({ name: "V25", contact: "v25@vendors.com", consent_basis: "business_agreed" })).status).toBe(201);

    for (let i = 26; i < MAX_VENDORS; i++) await engine.addWorkspaceVendor({ workspace_id: "ws_alpha", contact: `v${i}@vendors.com`, name: `V${i}`, consent: "operator recorded", added_by: "operator" });
    const full = await add({ name: "One more", contact: "more@vendors.com", consent_basis: "business_agreed" });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("VENDOR_LIMIT");
    const again = await add({ name: "V0", contact: "v0@vendors.com", consent_basis: "existing_relationship", note: "Ordered from them for years" });
    expect(again.status).toBe(200);
    expect(again.body.replaced).toBe(true);
  });

  it("re-authorizing an existing vendor never takes one of the day's additions", async () => {
    const { add, call } = await setup();
    for (let i = 0; i < 24; i++) expect((await add({ name: `V${i}`, contact: `v${i}@vendors.com`, consent_basis: "business_agreed" })).status).toBe(201);
    for (let i = 0; i < 3; i++) expect((await add({ name: "V0", contact: "v0@vendors.com", consent_basis: "existing_relationship" })).status).toBe(200);
    expect((await call("GET", "/internal/vendors")).body.limits.added_today).toBe(24);
    expect((await add({ name: "V24", contact: "v24@vendors.com", consent_basis: "business_agreed" })).status).toBe(201);
    expect((await add({ name: "V25", contact: "v25@vendors.com", consent_basis: "business_agreed" })).body.error.code).toBe("DAILY_LIMIT");
    // At the limit, re-authorizing still works.
    expect((await add({ name: "V1", contact: "v1@vendors.com", consent_basis: "existing_relationship" })).status).toBe(200);
  });

  it("the daily count is shared by every server process on the store, and concurrent adds never overshoot it", async () => {
    const { add, call, server } = await setup();
    const other = server(new DailyAdds(25, () => new Date("2026-10-22T18:00:00Z")));
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? add : other.add)({ name: `V${i}`, contact: `v${i}@vendors.com`, consent_basis: "business_agreed" })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(25);
    expect(results.filter((r) => r.status === 429).every((r) => r.body.error.code === "DAILY_LIMIT" && r.body.error.message === "This workspace added 25 vendors today (the daily limit).")).toBe(true);
    expect((await call("GET", "/internal/vendors")).body.limits.added_today).toBe(25);
    expect((await other.call("GET", "/internal/vendors")).body.limits.added_today).toBe(25);
    expect((await call("GET", "/internal/vendors")).body.vendors).toHaveLength(25);
  });

  for (const slots of ["none", "failing"] as const) {
    it(`a store ${slots === "none" ? "without shared rate slots" : "whose rate slots fail"}: each process counts in memory, with the same limit`, async () => {
      let t = new Date("2026-10-22T18:00:00Z");
      const { add, call, daily } = await setup("live", () => t, slots);
      for (let i = 0; i < 25; i++) expect((await add({ name: `V${i}`, contact: `v${i}@vendors.com`, consent_basis: "business_agreed" })).status).toBe(201);
      expect((await add({ name: "V0", contact: "v0@vendors.com", consent_basis: "existing_relationship" })).status).toBe(200);
      expect((await add({ name: "V25", contact: "v25@vendors.com", consent_basis: "business_agreed" })).body.error.code).toBe("DAILY_LIMIT");
      expect(daily.used("ws_alpha")).toBe(25);
      expect((await call("GET", "/internal/vendors")).body.limits.added_today).toBe(25);
      t = new Date("2026-10-23T00:00:01Z");
      expect((await add({ name: "V25", contact: "v25@vendors.com", consent_basis: "business_agreed" })).status).toBe(201);
    });
  }
});
