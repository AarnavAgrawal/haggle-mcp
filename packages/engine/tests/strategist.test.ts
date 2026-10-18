// The LLM chooses among truthful moves; deterministic checks decide what may be said. No network.
import { describe, expect, it } from "vitest";
import { applyStrategy, disabledPayer, HaggleEngine, InMemoryRepository, planCounteroffers, StubBrain, unsafeAsk, type CounterQuote, type StrategistPort } from "../src/index.ts";

const DEADLINE = new Date("2026-10-18T03:30:00Z");
const q = (o: Partial<CounterQuote> & Pick<CounterQuote, "quoteId" | "businessId" | "businessName" | "totalCents">): CounterQuote => ({ available: true, compliant: true, senderTrusted: true, round: 1, status: "current", confidence: 0.9, flags: [], ...o });
const PLAN = planCounteroffers([
  q({ quoteId: "q1", businessId: "b-harbor", businessName: "Harbor Table", totalCents: 688_357 }),
  q({ quoteId: "q2", businessId: "b-mission", businessName: "Mission Eats", totalCents: 700_000 }),
  q({ quoteId: "q3", businessId: "b-bay", businessName: "Bay Catering", totalCents: 760_000 }),
], DEADLINE, 3, null, 500_000);
const NAMES = ["Harbor Table", "Mission Eats", "Bay Catering"];

describe("unsafeAsk", () => {
  it("allows one plain question about terms; refuses numbers, links, names and claims about other offers", () => {
    expect(unsafeAsk("Could you include setup and cleanup in that price?", NAMES)).toBeNull();
    expect(unsafeAsk("Could you do it for 4500?", NAMES)).toBe("contains a number or amount");
    expect(unsafeAsk("Can you beat another quote we got?", NAMES)).toBe("claims another offer");
    expect(unsafeAsk("Harbor Table said yes, can you?", NAMES)).toBe("names a business");
    expect(unsafeAsk("See https://x.example for details.", NAMES)).toBe("contains a link or address");
    expect(unsafeAsk("Can you include setup? And cleanup?", NAMES)).toBe("more than one sentence");
  });
});

describe("applyStrategy", () => {
  it("honours skips, keeps planned wording, drops unsafe asks, ignores invented vendors, defaults undecided moves to the rules", () => {
    const r = applyStrategy(PLAN, { moves: [
      { business_id: "b-bay", send: false, reason: "far above every other quote and no flexibility shown", extra_ask: null },
      { business_id: "b-mission", send: true, reason: "close to the cheapest; likely to move", extra_ask: "Could you include setup and cleanup?" },
      { business_id: "b-harbor", send: true, reason: "cheapest but above target", extra_ask: "Could you do 4500?" },
      { business_id: "b-ghost", send: true, reason: "invented", extra_ask: null },
    ] }, NAMES);
    expect(r.skipped).toEqual([{ business_id: "b-bay", reason: "far above every other quote and no flexibility shown" }]);
    expect(r.moves.map((m) => m.businessId).sort()).toEqual(["b-harbor", "b-mission"]); // never b-ghost
    const mission = r.moves.find((m) => m.businessId === "b-mission")!;
    expect(mission.text).toContain("Could you include setup and cleanup?");
    expect(mission.text).toContain("$6,883.57"); // the planned, truthful figure is unchanged
    expect(mission.strategy).toEqual({ by: "llm", reason: "close to the cheapest; likely to move", extra_ask: "Could you include setup and cleanup?" });
    const harbor = r.moves.find((m) => m.businessId === "b-harbor")!;
    expect(harbor.text).not.toContain("4500");
    expect(r.rejectedAsks).toEqual(["Harbor Table: contains a number or amount"]);
    expect(applyStrategy(PLAN, null, NAMES).moves.every((m) => m.strategy.by === "rules")).toBe(true);
  });
});

describe("engine with a strategist", () => {
  const extractor = { async extract(i: { bodyText: string }) {
    const total = Number(/\$([\d,]+) total/.exec(i.bodyText)?.[1]?.replace(/,/g, "") ?? NaN);
    return { available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: Number.isFinite(total) ? total : null, deposit_usd: 500,
      menu_items: [], dietary_coverage: [], valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
      sources: [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }, { field: "deposit" as const, source: "email body", excerpt: "$500 deposit" }], missing_fields: [], confidence: 0.9 };
  } };
  function run(strategist?: StrategistPort) {
    const sent: { to: string; bodyText: string }[] = [];
    const e = new HaggleEngine({
      repo: new InMemoryRepository(), extractor: extractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"), ...(strategist ? { strategist } : {}),
      email: { async send(m) { sent.push(m); return { providerId: `em_${sent.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${sent.length}@x>` }; } },
      config: { mode: "live", inboxDomain: "x.test", sharedInbox: "haggle@x.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 3 },
    });
    return { e, sent };
  }
  async function quotes(e: HaggleEngine, sent: { to: string }[]) {
    const deal = await e.deal({ request: { what: "office move", quantity: 1, unit: "job", date: "2026-11-02", area: "Oakland, CA", requirements: [] }, budget_usd: 5000,
      businesses: [{ name: "Ace Movers", email: "a@ace.test" }, { name: "Bolt Movers", email: "b@bolt.test" }, { name: "Crane Co", email: "c@crane.test" }] });
    const repo = (e as unknown as { d: { repo: InMemoryRepository } }).d.repo;
    const totals: Record<string, number> = { "a@ace.test": 6200, "b@bolt.test": 6400, "c@crane.test": 9900 };
    for (const b of await repo.getBusinesses(deal.job_id)) {
      await e.ingest({ providerEventId: b.email!, eventType: "message.received", providerEmailId: `in_${b.email}`, threadId: `t_${b.email}`, messageId: `<in_${b.email}>`, inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: b.email!, to: ["haggle@x.test"], subject: "Re", bodyText: `$${totals[b.email!]} total, $500 deposit`, attachments: [], attachmentsDownloadUrl: null },
        (exp) => ({ trusted: true as const, address: exp, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }));
    }
    await e.advanceJob(deal.job_id);
    void sent;
    return { deal, repo };
  }

  it("the strategist skips a hopeless counter and adds a safe ask; skips and reasons are on the board", async () => {
    const seen: unknown[] = [];
    const { e, sent } = run({ async decide(plan, ctx) {
      seen.push({ plan: plan.map((p) => p.businessName), target: ctx.targetUsd });
      return { moves: [
        { business_id: plan.find((p) => p.businessName === "Crane Co")!.businessId, send: false, reason: "far above every other quote", extra_ask: null },
        { business_id: plan.find((p) => p.businessName === "Bolt Movers")!.businessId, send: true, reason: "within a few percent of the cheapest", extra_ask: "Could you include packing materials?" },
      ] };
    } });
    const { deal, repo } = await quotes(e, sent);
    expect(seen).toEqual([{ plan: ["Bolt Movers", "Crane Co", "Ace Movers"], target: 5000 }]);
    const counters = sent.filter((m) => /another quote|budget target/.test(m.bodyText));
    expect(counters.map((m) => m.to).sort()).toEqual(["a@ace.test", "b@bolt.test"]); // Crane skipped; Ace still gets the rules' target ask
    expect(counters.find((m) => m.to === "b@bolt.test")!.bodyText).toMatch(/\$6,200\.00 total[\s\S]*Could you include packing materials\?/);
    const events = await repo.listEvents(deal.job_id);
    expect(events.some((ev) => ev.type === "reply" && ev.data.summary === "No counter to Crane Co this round: far above every other quote")).toBe(true);
    expect(events.find((ev) => ev.type === "counteroffers_sent")!.data).toMatchObject({ planned: 3, skipped: 1, strategy: "llm" });
  });

  it("a failing strategist never blocks negotiation: the truthful rules plan goes out", async () => {
    const { e, sent } = run({ async decide() { throw new Error("timeout"); } });
    const { deal, repo } = await quotes(e, sent);
    expect(sent.filter((m) => /another quote|budget target/.test(m.bodyText))).toHaveLength(3);
    expect((await repo.listEvents(deal.job_id)).find((ev) => ev.type === "counteroffers_sent")!.data).toMatchObject({ strategy: "rules" });
  });
});
