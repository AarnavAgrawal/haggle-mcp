// Live business memory is what Haggle actually observed: synthetic seed samples (job_seed…) are never
// shown as a business's history, estimated from or price-checked against, and a configured vendor's
// real memory is found by the same identity deal uses, including quotes learned under the older
// contact-only id. Claude.ai regression: business_profile("Mission Eats") showed only the Oct 11 $675
// seed sample (48%) while its four real call quotes sat under another id. No network.
import { createBrain, MemoryStore } from "@haggle/brain";
import { businessIdForContact } from "@haggle/engine";
import { describe, expect, it } from "vitest";
import { makeBrain, observedOnly, observedStore } from "../src/brain.ts";

const PHONE = "+14085550199";
const reply = (job_id: string, total_usd: number, quantity: number, business_name = "Mission Eats") => ({
  parsed: { kind: "quote" as const, total_usd, quantity, items: ["Taco bar"], confidence: 0.9 },
  meta: { job_id, business_name, channel: "phone" as const, contacted_at: "2026-10-17T10:00:00Z", received_at: "2026-10-17T10:05:00Z", round: 1, request: { what: "catering", quantity, area: "San Francisco" } },
});

async function seededStore() {
  const base = new MemoryStore();
  const seeded = createBrain({ store: base, seed: true });
  await seeded.ready;
  return base;
}

describe("live memory = observed quotes only", () => {
  it("a seed-only profile is invisible; a mixed one keeps only real rows and recomputes from them", async () => {
    const base = await seededStore();
    const seedOnly = await base.get("biz_mission_eats");
    expect(seedOnly?.history.every((h) => h.job_id.startsWith("job_seed"))).toBe(true);
    expect(observedOnly(seedOnly)).toBeNull();
    const writer = createBrain({ store: base });
    const r = reply("job_real_1", 7000, 200);
    await writer.learnFromReply("biz_mission_eats", r.parsed, r.meta); // a real quote landing on a seed id
    const mixed = observedOnly(await base.get("biz_mission_eats"))!;
    expect(mixed.history.map((h) => h.job_id)).toEqual(["job_real_1"]);
    expect(mixed).toMatchObject({ n_quotes: 1, confidence: 0.48, per_unit_usd: { typical: 35 } }); // $7,000 / 200, not the $27 sample
  });

  it("the live brain neither replays seeds into an empty store nor estimates, prices or profiles from stored ones", async () => {
    const brain = makeBrain([], { HAGGLE_BRAIN_STORE: "memory" }, { observed: true });
    await brain.core.ready;
    expect(await brain.core.getProfile("Mission Eats")).toBeNull();
    expect(await brain.core.estimate({ what: "lunch catering", quantity: 25, area: "San Francisco" })).toEqual([]);

    const base = await seededStore();
    const live = createBrain({ store: observedStore(base) });
    expect(await live.getProfile("Mission Eats")).toBeNull();
    expect(await live.estimate({ what: "lunch catering", quantity: 25, area: "San Francisco" })).toEqual([]);
    expect((await live.checkPrice({ total_usd: 675, quantity: 25, area: "San Francisco" })).sample_size).toBe(0);
  });
});

describe("one identity from profile to deal", () => {
  it("a configured vendor finds its memory under the older contact-only id; a different business on the same phone does not", async () => {
    const base = new MemoryStore();
    const legacyId = businessIdForContact({ phone: PHONE });
    const old = createBrain({ store: base });
    for (const [job, total] of [["job_a", 6200], ["job_b", 6700]] as const) { const r = reply(job, total, 200); await old.learnFromReply(legacyId, r.parsed, r.meta); }

    const engineId = businessIdForContact({ phone: PHONE }, "Mission Eats");
    const { BrainAdapter } = await import("@haggle/engine");
    const adapter = new BrainAdapter({ brain: createBrain({ store: observedStore(base) }), directory: [], fleet: [{ business_id: engineId, name: "Mission Eats", phone: PHONE, simulated: true }] });
    expect(await adapter.profileIdFor(engineId)).toBe(legacyId);
    expect((await adapter.coreProfile(engineId))?.n_quotes).toBe(2);
    // New quotes keep the history in one place.
    const r = reply("job_c", 7000, 200);
    await adapter.learnFromReply(engineId, { items: [{ kind: "quote", quote: { total_usd: 7000, items: ["Taco bar"], flags: [], confidence: 0.9, round: 1 } }], injection_detected: false } as never, { ...r.meta, business_id: engineId, business_email: `tel:${PHONE}`, sender_trusted: true, simulated: true, message_id: "m1", thread_id: "", request: { what: "catering", quantity: 200, date: "2026-10-24", area: "San Francisco", requirements: [] }, channel: "transcript", reply_channel: "phone" } as never);
    expect((await base.get(legacyId))?.n_quotes).toBe(3);
    expect(await base.get(engineId)).toBeNull();

    // Another persona on the same phone never inherits Mission Eats' memory.
    const other = businessIdForContact({ phone: PHONE }, "Sunset Kitchen");
    const a2 = new BrainAdapter({ brain: createBrain({ store: observedStore(base) }), directory: [], fleet: [{ business_id: other, name: "Sunset Kitchen", phone: PHONE, simulated: true }] });
    expect(await a2.profileIdFor(other)).toBe(other);
    expect(await a2.coreProfile(other)).toBeNull();
  });
});

describe("residual memory defects (2026-10-18)", () => {
  it("a mixed seed + real profile keeps no seed-derived menu, minimums, deposit habits or flags", async () => {
    const base = await seededStore();
    const writer = createBrain({ store: base });
    const r = reply("job_real_2", 7000, 200);
    await writer.learnFromReply("biz_quickquote_deli", r.parsed, { ...r.meta, business_name: "QuickQuote Deli" });
    const raw = await base.get("biz_quickquote_deli");
    expect(raw!.flags_seen).toContain("external_payment_link"); // from the seed sample
    const mixed = observedOnly(raw)!;
    expect(mixed).toMatchObject({ menu: [], flags_seen: [], channels_seen: ["phone"], best_channel: "phone", n_quotes: 1 });
    expect(mixed.deposit_pct).toBeUndefined();
  });

  it("Harbor Table: its real quote, stored under an older id whose brain profile carries the mailbox's old name, is found through Haggle's own job records", async () => {
    const MAIL = "haggle-test-seller@inkboxmail.com";
    const legacyId = businessIdForContact({ email: MAIL });
    const base = new MemoryStore();
    const r = reply("job_dec51a", 6883.57, 200, "Haggle Test Seller"); // what the old fleet config called the mailbox
    await createBrain({ store: base }).learnFromReply(legacyId, r.parsed, { ...r.meta, channel: "email" });
    const engineId = businessIdForContact({ email: MAIL }, "Harbor Table");
    const { BrainAdapter } = await import("@haggle/engine");
    const adapter = new BrainAdapter({ brain: createBrain({ store: observedStore(base) }), directory: [], fleet: [{ business_id: engineId, name: "Harbor Table", email: MAIL, simulated: true }] });
    expect(await adapter.profileIdFor(engineId)).toBe(engineId); // the name differs: no guess
    // The engine's records show that job addressed "Harbor Table" at this mailbox under the older id.
    adapter.useAliases(async (b) => (b.name === "Harbor Table" ? [b.business_id, legacyId] : [b.business_id]));
    expect(await adapter.profileIdFor(engineId)).toBe(legacyId);
    expect((await adapter.coreProfile(engineId))?.n_quotes).toBe(1);
    // A different business on the same mailbox gets nothing from it.
    const other = businessIdForContact({ email: MAIL }, "Golden Grill");
    expect(await adapter.profileIdFor(other, { name: "Golden Grill", email: MAIL })).toBe(other);
  });
});
