// Business identity vs contact endpoints (live regression 2026-10-18: one phone played "Mission Eats",
// "Sunset Kitchen" and earlier test vendors, and all of it merged into one learned profile).
import { describe, expect, it } from "vitest";
import { createBrain, loadDirectory, MemoryStore } from "@haggle/brain";
import { BrainAdapter, businessIdForContact, normalizeBusinessName } from "../src/index.ts";
import type { ParsedReply, ReplyMeta } from "../src/contract.ts";

const PHONE = "+14155550122";
const quote = (business: string, total: number, job: string): ParsedReply => ({
  injection_detected: false,
  items: [{ kind: "quote", quote: { kind: "quote", job_id: job, business_id: "x", business, total_usd: total, items: [], meets_requirements: true, requirement_results: [], missing: [], flags: [], round: 1, confidence: 0.9, source: "call transcript", evidence: {}, message_id: `m_${job}` } }],
} as never);
const meta = (id: string, name: string, job: string): ReplyMeta => ({
  job_id: job, business_id: id, business_name: name, business_email: `tel:${PHONE}`, message_id: `m_${job}`, thread_id: "", received_at: "2026-10-18T02:20:00Z", rfq_sent_at: "2026-10-18T02:18:00Z",
  channel: "transcript", reply_channel: "phone", sender_trusted: true, sender_trust_reason: "outbound-call-to-pinned-number", simulated: false,
  request: { what: "catering", quantity: 200, date: "2026-10-24", area: "San Francisco, CA", requirements: [] },
} as never);

describe("business identity", () => {
  it("one phone fronting two personas gives two businesses; the same business keeps one id across jobs and spellings", () => {
    const mission = businessIdForContact({ phone: PHONE }, "Mission Eats");
    const sunset = businessIdForContact({ phone: PHONE }, "Sunset Kitchen");
    expect(mission).not.toBe(sunset);
    expect(businessIdForContact({ phone: PHONE }, "Mission Eats (demo)")).toBe(mission);
    expect(businessIdForContact({ phone: PHONE }, "MISSION EATS, LLC")).toBe(mission);
    expect(businessIdForContact({ email: "Seller@InkboxMail.com" }, "Harbor Table")).not.toBe(businessIdForContact({ email: "seller@inkboxmail.com" }, "Haggle Test Seller")); // shared mailbox
    expect(normalizeBusinessName("The Golden Grill & Co.")).toBe("golden grill and");
  });

  it("memory is attributed per business: two personas on one phone never share quotes or a track record", async () => {
    const core = createBrain({ store: new MemoryStore() });
    const brain = new BrainAdapter({ brain: core, directory: loadDirectory(undefined) });
    const mission = businessIdForContact({ phone: PHONE }, "Mission Eats (demo)");
    const sunset = businessIdForContact({ phone: PHONE }, "Sunset Kitchen (demo)");
    await brain.learnFromReply(mission, quote("Mission Eats (demo)", 7000, "job_a"), meta(mission, "Mission Eats (demo)", "job_a"));
    await brain.learnFromReply(sunset, quote("Sunset Kitchen (demo)", 4750, "job_a"), meta(sunset, "Sunset Kitchen (demo)", "job_a"));
    await brain.learnFromReply(mission, quote("Mission Eats (demo)", 6800, "job_b"), meta(mission, "Mission Eats (demo)", "job_b"));
    const pm = await core.getProfile(mission);
    const ps = await core.getProfile(sunset);
    expect(pm).toMatchObject({ name: "Mission Eats (demo)", n_quotes: 2 });
    expect(ps).toMatchObject({ name: "Sunset Kitchen (demo)", n_quotes: 1 });
    expect(await brain.trackRecord(mission, "job_c")).toMatchObject({ past_quotes: 2 });
    expect(await brain.trackRecord(sunset, "job_c")).toMatchObject({ past_quotes: 1 });
  });

  it("a directory business is matched by phone only when the name agrees", () => {
    const directory = loadDirectory(undefined);
    const me = directory.find((d) => d.name === "Mission Eats")!;
    const brain = new BrainAdapter({ brain: createBrain({ store: new MemoryStore() }), directory });
    expect(brain.brainIdFor("biz_x", { phone: me.phone!, name: "Mission Eats" })).toBe(me.id);
    expect(brain.brainIdFor("biz_y", { phone: me.phone!, name: "Totally Different Deli" })).toBe("biz_y");
  });
});
