// Overnight sprint B: deal(businesses=["Casa Lunch"]) resolves a NAME against the connection's own
// workspace_vendors (operator-authorized, with consent): case/space-insensitive, unique match
// required, ambiguous names listed, unknown names start nothing. A name never resolves to another
// workspace's vendor, and the agent still can't authorize a contact itself. Real engine, in-memory
// store, no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain } from "@haggle/engine";
import type { Profile } from "@haggle/core";
import { discoveredFor, resolveSelection, type Selection } from "../src/businesses.ts";
import { historyOnly } from "../src/brain.ts";
import { buildRoster, findWorkspaceVendors, workspaceVendorList, workspaceVendorReadiness, type ChannelStatus } from "../src/vendors.ts";
import type { Runtime } from "../src/runtime.ts";
import { verifyApprover } from "../../../packages/engine/tests/helpers/verifiedApprover.ts";

const CH: ChannelStatus = { email: true, imessage: false, sms: true, phone: false, a2a: false, connectCommand: "connect @haggle", connected: null, callsViaSharedLine: false };
const { budget_usd, ...request } = GOLDEN_REQUEST;

async function setup() {
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, extractor: { async extract() { throw new Error("unused"); } } as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { return { providerId: `em_${m.idempotencyKey}`, status: "sent", idempotentReplay: false, messageId: `<${m.idempotencyKey.replace(/\W/g, "")}@haggle.test>` }; } },
    sms: { async send() { return { messageId: `sms_${Math.random()}` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1, recipientAllowlist: [] },
  });
  for (const [id, phone] of [["ws_alpha", "+14155550171"], ["ws_beta", "+14155550172"]] as const) {
    await repo.insertWorkspace({ id, name: id, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
    await engine.updateSettings({ approver_phone: phone }, id, "operator");
    await verifyApprover(repo, id, phone);
  }
  const add = (workspace_id: string, contact: string, name: string, channel?: "email" | "phone" | "imessage") => engine.addWorkspaceVendor({ workspace_id, contact, name, consent: "Owner agreed by phone 2026-10-21", added_by: "operator (test)", ...(channel ? { channel } : {}) });
  await add("ws_alpha", "orders@casalunch.example", "Casa Lunch");
  await add("ws_alpha", "+14155550161", "Casa Lunch", "imessage");
  await add("ws_alpha", "hello@casadeli.example", "Casa Deli");
  await add("ws_beta", "beta-orders@casalunch.example", "Casa Lunch");
  const rt = { roster: async () => buildRoster({}, CH), channels: async () => CH, engine } as unknown as Runtime;
  const scope = async (ws: string) => ({ vendors: await engine.forWorkspace(ws).workspaceVendors(), learning: engine.forWorkspace(ws) });
  return { repo, engine, rt, scope };
}

describe("workspace vendors by name", () => {
  it("groups contacts per name; matching is case/space/punctuation-insensitive; whole-word partials must be unique", () => {
    const list = workspaceVendorList([{ name: "Casa Lunch", contact: "a@b.test" }, { name: "casa  lunch", contact: "+14155550161", channel: "imessage" }, { name: "Casa Deli", contact: "c@d.test" }]);
    expect(list).toEqual([
      { name: "Casa Lunch", business_ref: "casa_lunch", email: "a@b.test", phone: "+14155550161", channel: "imessage" },
      { name: "Casa Deli", business_ref: "casa_deli", email: "c@d.test", channel: "email" },
    ]);
    expect(findWorkspaceVendors("CASA-lunch", list).map((v) => v.name)).toEqual(["Casa Lunch"]);
    expect(findWorkspaceVendors("casa_deli", list).map((v) => v.name)).toEqual(["Casa Deli"]);
    expect(findWorkspaceVendors("Casa", list)).toHaveLength(2);
    expect(findWorkspaceVendors("Pizza Palace", list)).toEqual([]);
    expect(workspaceVendorReadiness(list[0]!, CH)).toEqual({ ready: true }); // texted by SMS
    expect(workspaceVendorReadiness({ ...list[0]!, channel: "phone" }, CH)).toMatchObject({ ready: false, blocker: expect.stringMatching(/calls are off/) });
  });

  it("a name resolves to this workspace's own vendor and contact; the same name in another workspace is that workspace's contact", async () => {
    const { rt, scope, engine, repo } = await setup();
    const a = await resolveSelection(["casa lunch"], rt, await scope("ws_alpha"));
    expect(a).toMatchObject({ ok: true, selected: [{ kind: "workspace_vendor", name: "Casa Lunch", send: { channel: "imessage", phone: "+14155550161", email: "orders@casalunch.example" } }] });
    const b = await resolveSelection(["Casa Lunch"], rt, await scope("ws_beta"));
    expect(b).toMatchObject({ ok: true, selected: [{ kind: "workspace_vendor", send: { channel: "email", email: "beta-orders@casalunch.example" } }] });
    // End to end through the engine: each workspace's deal contacts its own vendor only.
    const send = (sel: Selection) => {
      if (!sel.ok) throw new Error(sel.message);
      const x = sel.selected[0]!;
      return { name: x.name, channel: x.send!.channel, ...(x.send!.email ? { email: x.send!.email } : {}), ...(x.send!.phone ? { phone: x.send!.phone } : {}) };
    };
    const da = await engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [send(a)] });
    const db = await engine.forWorkspace("ws_beta").deal({ request, budget_usd, businesses: [send(b)] });
    expect((await repo.getBusinesses(da.job_id)).map((x) => x.email)).toEqual(["orders@casalunch.example"]);
    expect((await repo.getBusinesses(db.job_id)).map((x) => x.email)).toEqual(["beta-orders@casalunch.example"]);
  });

  it("ambiguous names list the candidates; unknown names (incl. another workspace's vendor) start nothing and say who this workspace can use", async () => {
    const { rt, scope } = await setup();
    expect(await resolveSelection(["Casa"], rt, await scope("ws_alpha"))).toMatchObject({ ok: false, code: "ambiguous_business", message: expect.stringMatching(/Casa Lunch or Casa Deli/) });
    const unknown = await resolveSelection(["Casa Deli"], rt, await scope("ws_beta"));
    expect(unknown).toMatchObject({ ok: false, code: "unknown_business" });
    expect((unknown as { fix: string }).fix).toMatch(/Casa Lunch \(casa_lunch, authorized for this workspace\)/);
    expect((unknown as { fix: string }).fix).not.toMatch(/Casa Deli|casadeli/);
  });

  it("the agent can't reach another workspace's vendor by giving its contact, nor authorize one", async () => {
    const { engine } = await setup();
    await expect(engine.forWorkspace("ws_beta").deal({ request, budget_usd, businesses: [{ name: "Casa Deli", email: "hello@casadeli.example" }] })).rejects.toMatchObject({ code: "recipient_not_allowed" });
    expect("addWorkspaceVendor" in engine.forWorkspace("ws_beta")).toBe(false);
    await expect(engine.addWorkspaceVendor({ workspace_id: "ws_beta", contact: "+14155550161", name: "X", consent: "agreed by phone", added_by: "op", channel: "email" })).rejects.toMatchObject({ code: "bad_channel" });
  });
});

describe("discover results belong to the workspace that searched", () => {
  it("another workspace can't select (or see) a business found by this one's discover", async () => {
    const { rt, scope } = await setup();
    const hit = { name: "Ace Plumbing", business_ref: "place:ACE1", place_id: "ACE1", types: ["plumber"], relevance: 1, in_area: true, score: 0.9, rank_reasons: [], source: "Google Places", attribution: "Google Maps", fetched_at: new Date().toISOString(), merged_listings: 1, category: "plumbing", area: "Oakland, CA" };
    discoveredFor("ws_alpha").remember([hit as never]);
    expect(await resolveSelection(["Ace Plumbing"], rt, { ...(await scope("ws_alpha")), discovered: discoveredFor("ws_alpha") })).toMatchObject({ ok: true, selected: [{ kind: "discovered", name: "Ace Plumbing" }] });
    expect(await resolveSelection(["Ace Plumbing"], rt, { ...(await scope("ws_beta")), discovered: discoveredFor("ws_beta") })).toMatchObject({ ok: false, code: "unknown_business" });
    expect(discoveredFor("ws_beta").get("place:ACE1")).toBeNull();
  });
});

describe("business_profile shows only this workspace's history from a shared profile", () => {
  it("drops other workspaces' rows and everything derived without provenance; seed samples can stay labelled", () => {
    const row = (job_id: string, total: number) => ({ date: "2026-10-20", job_id, kind: "quote", channel: "email", total_usd: total, per_unit_usd: total / 40, quantity: 40, round: 1 });
    const p = { business_id: "biz_1", name: "Casa Lunch", best_channel: "email", channels_seen: ["email"], menu: ["secret menu from Alpha's reply"], flags_seen: [], history: [row("job_alpha", 1000), row("job_beta", 2000), row("job_seed_1", 800)], n_quotes: 3, confidence: 0.8, per_unit_usd: { low: 20, typical: 25, high: 50 } } as unknown as Profile;
    const beta = historyOnly(p, (j) => j === "job_beta" || j.startsWith("job_seed"))!;
    expect(beta.history.map((h) => h.job_id)).toEqual(["job_beta", "job_seed_1"]);
    expect(beta.menu).toEqual([]);
    expect(beta.n_quotes).toBe(2);
    expect(JSON.stringify(beta)).not.toMatch(/job_alpha|secret menu/);
    expect(historyOnly(p, () => false)).toBeNull();
    expect(historyOnly(p, () => true)).toBe(p);
  });
});
