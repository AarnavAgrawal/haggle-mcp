// The engine/brain seam: the engine's replies teach the REAL brain (@haggle/brain, in memory, no
// network), keyed by directory ids (decision D1), and only from trusted senders.
import { describe, expect, it, vi } from "vitest";
import { createBrain, loadDirectory, MemoryStore } from "@haggle/brain";
import { BrainAdapter, createMockEngine, fleetBusinesses, GOLDEN_REQUEST, type HaggleEngine } from "../src/index.ts";
import type { ParsedReply, ReplyMeta } from "../src/contract.ts";

const directory = loadDirectory(undefined);

function adapter() {
  const core = createBrain({ store: new MemoryStore() });
  return { core, brain: new BrainAdapter({ brain: core, directory, fleet: fleetBusinesses() }) };
}

const harbor = directory.find((d) => d.name === "Harbor Table")!;

const meta = (over: Partial<ReplyMeta> = {}): ReplyMeta => ({
  job_id: "job_1", business_id: "biz_engine_harbor", business_email: harbor.email!, message_id: "msg_1", thread_id: "thr_1",
  received_at: "2026-10-17T19:10:00Z", rfq_sent_at: "2026-10-17T19:00:00Z", channel: "pdf", sender_trusted: true,
  sender_trust_reason: "trusted", simulated: true,
  request: { what: "lunch catering", quantity: 40, date: "2026-10-22", area: "San Francisco, CA", requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }] },
  ...over,
});

const quoteAndQuestion: ParsedReply = {
  injection_detected: false,
  items: [
    {
      kind: "quote",
      quote: {
        kind: "quote", job_id: "job_1", business_id: "biz_engine_harbor", business: "Harbor Table", total_usd: 1150, per_unit_usd: 28.75, deposit_usd: 287.5,
        items: ["Mediterranean buffet for 40 (14 vegetarian)"], meets_requirements: true, requirement_results: [], missing: [], flags: ["hidden_deposit"],
        round: 1, confidence: 0.9, source: "pdf p.2", evidence: {}, message_id: "msg_1",
      },
    },
    { kind: "question", question_id: "sq_1", text: "Do you need plates?", blocks_quote: false },
  ],
};

describe("BrainAdapter (engine → real brain)", () => {
  it("keys the brain by the directory id (matched by email) and sends one flat reply per item", async () => {
    const { core, brain } = adapter();
    const spy = vi.spyOn(core, "learnFromReply");
    await brain.learnFromReply("biz_engine_harbor", quoteAndQuestion, meta());
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => [c[0], c[1].kind])).toEqual([[harbor.id, "quote"], [harbor.id, "question"]]);
    expect(spy.mock.calls[0]![2]).toMatchObject({ channel: "email", format: "pdf", sender_trusted: true, message_id: "msg_1", business_name: "Harbor Table" });
    const p = await core.getProfile(harbor.id);
    expect(p).toMatchObject({ business_id: harbor.id, n_quotes: 1, asks_questions: true });
  });

  it("never teaches the brain from an untrusted sender", async () => {
    const { core, brain } = adapter();
    const spy = vi.spyOn(core, "learnFromReply");
    await brain.learnFromReply("biz_engine_harbor", quoteAndQuestion, meta({ sender_trusted: false, sender_trust_reason: "unverified" }));
    expect(spy).not.toHaveBeenCalled();
    expect(await core.getProfile(harbor.id)).toBeNull();
  });

  it("a business the directory doesn't know keeps the engine id", async () => {
    const { core, brain } = adapter();
    await brain.learnFromReply("biz_unknown", quoteAndQuestion, meta({ business_email: "new@example.com", simulated: false }));
    expect(await core.getProfile("biz_unknown")).toMatchObject({ n_quotes: 1 });
  });

  it("a business outside the directory is remembered by the name used on the job, not its id (live regression)", async () => {
    const { core, brain } = adapter();
    await brain.learnFromReply("biz_6c811a809659ce8e", quoteAndQuestion, meta({ business_email: "tel:+14155550122", business_name: "Mission Eats (demo)", simulated: false }));
    expect(await core.getProfile("biz_6c811a809659ce8e")).toMatchObject({ name: "Mission Eats (demo)" });
  });

  it("maps estimates and price checks back to engine shapes", async () => {
    const core = createBrain({ store: new MemoryStore(), seed: true });
    const brain = new BrainAdapter({ brain: core, directory });
    const est = await brain.estimate(meta().request);
    expect(est.length).toBeGreaterThan(0);
    for (const e of est) expect(e).toMatchObject({ kind: "estimate", estimate_usd: expect.any(Number), quote_count: expect.any(Number), basis: expect.any(String) });
    const v = await brain.checkPrice({ request: { what: "lunch catering", quantity: 40, area: "San Francisco, CA" }, total_usd: 1400 });
    expect(["good", "typical", "high", "unknown"]).toContain(v.verdict);
    expect(typeof v.basis).toBe("string");
  });
});

describe("cold deal teaches the real brain (mock mode, simulated fleet)", { timeout: 120_000 }, () => {
  it("every quoting email business has a learned profile under its directory id afterwards", async () => {
    const { core, brain } = adapter();
    let t = Date.now();
    const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
    const { engine } = createMockEngine({ now: clock.now, brain });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await (engine as HaggleEngine).deal({ request, budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), source: "fleet" as const, simulated: true })) });
    let cursor = 0;
    for (let i = 0; i < 200; i++) {
      clock.advance(1_000);
      cursor = Number((await engine.waitForUpdate(deal.job_id, cursor, 0)).cursor);
      const q = await engine.getQuotes(deal.job_id);
      for (const pq of q.pending_questions) await engine.answerSeller(deal.job_id, pq.question_id, "Yes, please include plates and cutlery for 40.");
      if (q.ready) break;
    }
    for (const name of ["Bay Catering", "Harbor Table", "Golden Grill"]) {
      const id = directory.find((d) => d.name === name)!.id;
      const p = await core.getProfile(id);
      expect(p, name).not.toBeNull();
      expect(p!.n_quotes, name).toBeGreaterThan(0);
    }
    // The warm path now answers from what the cold deal taught it.
    const est = await core.estimate({ what: "lunch catering", quantity: 25, area: "San Francisco" });
    expect(est.map((e) => e.business)).toEqual(expect.arrayContaining(["Bay Catering", "Harbor Table"]));
  });
});
