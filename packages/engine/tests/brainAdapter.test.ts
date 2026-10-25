// The engine/brain seam: the engine's replies teach the REAL brain (@haggle/brain, in memory, no
// network), keyed by directory ids (decision D1), and only from trusted senders.
import { describe, expect, it, vi } from "vitest";
import { createBrain, createWorkspaceBrains, loadDirectory, MemoryStore } from "@haggle/brain";
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

  it("discover keeps the brain's channel, so a business the operator set to be texted is texted", async () => {
    const texting = loadDirectory(undefined, JSON.stringify([{ id: "biz_golden_grill", phone: "+14085550123", prefer_channel: "imessage" }]));
    const brain = new BrainAdapter({ brain: createBrain({ store: new MemoryStore(), directory: texting }), directory: texting });
    const found = await brain.discover("catering", "San Francisco", 6);
    expect(found.find((b) => b.name === "Golden Grill")).toMatchObject({ best_channel: "imessage", phone: "+14085550123", email: "" });
    expect(found.find((b) => b.name === "Harbor Table")).toMatchObject({ best_channel: "email" });
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

/** Runs a mock cold deal in one workspace to ready, answering the businesses' questions. */
async function coldDeal(engine: HaggleEngine, ws: string, clock: { advance: (ms: number) => void }, quantity = 40) {
  const scoped = engine.forWorkspace(ws);
  const { budget_usd, ...request } = GOLDEN_REQUEST;
  const deal = await scoped.deal({ request: { ...request, quantity }, budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), source: "fleet" as const, simulated: true })) });
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    clock.advance(1_000);
    cursor = Number((await scoped.waitForUpdate(deal.job_id, cursor, 0)).cursor);
    const q = await scoped.getQuotes(deal.job_id);
    for (const pq of q.pending_questions) await scoped.answerSeller(deal.job_id, pq.question_id, `Yes, please include plates and cutlery for ${quantity}.`);
    if (q.ready) break;
  }
  return { scoped, jobId: deal.job_id };
}

describe("brain tenancy: each workspace's engine calls reach only that workspace's brain", { timeout: 180_000 }, () => {
  it("a cold deal in ws_alpha teaches only alpha; ask, check_price, business_profile and the board's contact learning in ws_beta show nothing from it, and beta's deal never reads alpha's brain", async () => {
    const brains = createWorkspaceBrains({ store: new MemoryStore() });
    // Every call each workspace's brain receives, by workspace.
    const touched: string[] = [];
    const coreFor = (ws: string) => {
      const core = brains.forWorkspace(ws);
      return new Proxy(core, { get: (t, k, r) => { const v = Reflect.get(t, k, r); return typeof v === "function" ? (...a: unknown[]) => { touched.push(`${ws}:${String(k)}`); return (v as (...x: unknown[]) => unknown).apply(t, a); } : v; } });
    };
    const brain = new BrainAdapter({ brain: coreFor("ws_default"), coreFor, directory, fleet: fleetBusinesses() });
    let t = Date.now();
    const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
    const { engine } = createMockEngine({ now: clock.now, brain });
    for (const id of ["ws_alpha", "ws_beta"]) await (engine as HaggleEngine).createWorkspace({ id, name: id, tokenHash: `token_${id}`, connectorSecretHash: `connector_${id}` });

    const alpha = await coldDeal(engine as HaggleEngine, "ws_alpha", clock);
    expect(touched.filter((x) => x.endsWith(":learnFromReply")).every((x) => x.startsWith("ws_alpha:"))).toBe(true);
    expect(touched.some((x) => x === "ws_alpha:learnFromReply")).toBe(true);
    const beta = (engine as HaggleEngine).forWorkspace("ws_beta");
    const req = { what: "lunch catering", quantity: 40, date: "2026-10-22", area: "San Francisco, CA", requirements: [] };

    // ask
    const askA = await alpha.scoped.ask(req);
    expect(askA.estimates.map((e) => e.business)).toEqual(expect.arrayContaining(["Bay Catering", "Harbor Table"]));
    expect((await beta.ask(req)).estimates).toEqual([]);
    // check_price (free-form and with a business id)
    const priceA = await alpha.scoped.checkPrice({ request: req, total_usd: 1400 });
    const harborId = askA.estimates.find((e) => e.business === "Harbor Table")!.business_id;
    expect(priceA.sample_size).toBeGreaterThan(0);
    expect((await beta.checkPrice({ request: req, total_usd: 1400 })).sample_size).toBe(0);
    expect((await beta.checkPrice({ business_id: harborId, request: req, total_usd: 1400 })).sample_size).toBe(0);
    // business_profile
    expect((await alpha.scoped.businessProfile("Harbor Table")).profile?.quote_count).toBeGreaterThan(0);
    expect((await beta.businessProfile("Harbor Table")).profile).toBeNull();
    expect((await beta.businessProfile(harborId)).profile).toBeNull();
    // discover: alpha's learned businesses rank first for alpha only; beta ranks like a brain that learned nothing.
    const ids = (bs: { business_id: string }[]) => bs.map((x) => x.business_id);
    const fresh = ids(await new BrainAdapter({ brain: createBrain({ store: new MemoryStore() }), directory }).discover("catering", "San Francisco", 6));
    expect(ids(await beta.discover("catering", "San Francisco", 6))).toEqual(fresh); // (ranking itself: packages/brain/tests/brain.test.ts)
    expect(touched).toContain("ws_beta:discover");

    // Beta's own deal (learn, the board's price checks, the track record) never touches alpha's brain.
    touched.length = 0;
    const b = await coldDeal(engine as HaggleEngine, "ws_beta", clock, 120);
    const boardB = (await b.scoped.getQuotes(b.jobId)) as unknown as { contact_learning?: Record<string, { channels: Record<string, { contacted_jobs: number }> }> };
    // The board's cross-job contact learning (same vendors, same business ids) counts beta's one deal only, never alpha's.
    const learning = Object.values(boardB.contact_learning ?? {}).flatMap((l) => Object.values(l.channels));
    expect(learning.length).toBeGreaterThan(0);
    expect(learning.every((r) => r.contacted_jobs === 1), JSON.stringify(boardB.contact_learning)).toBe(true);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((x) => !x.startsWith("ws_beta:"))).toEqual([]);
    expect(touched).toContain("ws_beta:checkPrice");
    // Beta's estimate now reflects only beta's deal (120 people), never alpha's 40.
    const harborBeta = await brains.forWorkspace("ws_beta").getProfile(directory.find((d) => d.name === "Harbor Table")!.id);
    const harborAlpha = await brains.forWorkspace("ws_alpha").getProfile(directory.find((d) => d.name === "Harbor Table")!.id);
    expect(harborBeta?.history.every((h) => h.quantity === 120)).toBe(true);
    expect(harborAlpha?.history.every((h) => h.quantity === 40)).toBe(true);
  });

  it("an adapter without per-workspace brains is one brain for every workspace (forWorkspace returns itself)", () => {
    const { brain } = adapter();
    expect(brain.forWorkspace("ws_alpha")).toBe(brain);
  });

  it("forWorkspace is cached per workspace; ws_default is the adapter itself; children keep the record-based aliases", async () => {
    const brains = createWorkspaceBrains({ store: new MemoryStore() });
    const brain = new BrainAdapter({ brain: brains.forWorkspace("ws_default"), coreFor: (ws) => brains.forWorkspace(ws), directory: [], fleet: [] });
    const a = brain.forWorkspace("ws_alpha");
    expect(brain.forWorkspace("ws_alpha")).toBe(a);
    expect(brain.forWorkspace("ws_default")).toBe(brain);
    expect(a.forWorkspace("ws_beta")).toBe(brain.forWorkspace("ws_beta"));
    const asked: string[] = [];
    brain.useAliases(async (b) => { asked.push(b.business_id); return [b.business_id]; });
    await a.profileIdFor("biz_somewhere", { name: "Somewhere", email: "x@example.com" });
    expect(asked).toEqual(["biz_somewhere"]);
  });
});
