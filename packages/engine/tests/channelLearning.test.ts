// Learned contact preferences: stated preferences and observed reply performance, with sample-size limits.
import { describe, expect, it } from "vitest";
import { chooseChannel, disabledPayer, HaggleEngine, InMemoryRepository, learnContact, StubBrain, type ContactLearning } from "../src/index.ts";

describe("chooseChannel", () => {
  const rec = (contacted: number, replied: number) => ({ contacted_jobs: contacted, replied_jobs: replied, quotes: replied, response_rate: replied / contacted, confidence: contacted / (contacted + 3) });
  it("a single observation never overrides the default; a clear record over two or more contacts does", () => {
    expect(chooseChannel(["email", "imessage"], "email", { channels: { email: rec(1, 0), imessage: rec(1, 1) } })).toEqual({ channel: "email", reason: null });
    expect(chooseChannel(["email", "imessage"], "email", { channels: { email: rec(2, 0), imessage: rec(2, 2) } })).toEqual({ channel: "imessage", reason: "text answered 2 of 2 times vs email 0 of 2" });
    expect(chooseChannel(["email", "imessage"], "email", { channels: { email: rec(4, 3), imessage: rec(2, 2) } }).channel).toBe("email"); // not clearly better
  });
  it("a preference the business stated wins, but only among available channels; a listed channel isn't a preferred one", () => {
    const stated: ContactLearning = { channels: {}, stated_preference: { channel: "imessage", excerpt: "please text me instead", at: "2026-10-18" } };
    expect(chooseChannel(["email", "imessage"], "email", stated)).toEqual({ channel: "imessage", reason: 'the business asked for text: "please text me instead"' });
    expect(chooseChannel(["email", "phone"], "email", stated)).toEqual({ channel: "email", reason: null });
    expect(chooseChannel(["email", "phone"], "email", { channels: {} })).toEqual({ channel: "email", reason: null });
  });
});

describe("contact learning end to end", () => {
  const extractor = { async extract(i: { bodyText: string }) {
    const total = Number(/\$([\d,]+) total/.exec(i.bodyText)?.[1]?.replace(/,/g, "") ?? NaN);
    const pref = /please text me instead/i.exec(i.bodyText)?.[0];
    return { available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: Number.isFinite(total) ? total : null, deposit_usd: null,
      menu_items: [], dietary_coverage: [], valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
      sources: Number.isFinite(total) ? [{ field: "total" as const, source: "text", excerpt: `$${total} total` }] : [], missing_fields: [], confidence: 0.9,
      ...(pref ? { preferred_contact: { channel: "text" as const, excerpt: pref } } : {}) };
  } };
  function setup() {
    let t = Date.parse("2026-10-18T00:00:00Z");
    const sent: { to: string }[] = [], texts: { to: string }[] = [];
    const repo = new InMemoryRepository({ now: () => new Date(t) });
    const e = new HaggleEngine({
      repo, now: () => new Date(t), extractor: extractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
      email: { async send(m) { sent.push(m); return { providerId: `em_${sent.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${sent.length}@x>` }; } },
      imessage: { async send(r) { texts.push(r); return { messageId: `im_${texts.length}` }; } },
      config: { mode: "live", inboxDomain: "x.test", sharedInbox: "haggle@x.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1 },
    });
    return { e, repo, sent, texts, advance: (ms: number) => { t += ms; } };
  }
  const REQ = { what: "office cleaning", quantity: 1, unit: "job", date: "2026-11-05", area: "Oakland, CA", requirements: [] };
  const BIZ = { name: "Bright Crew", email: "hello@brightcrew.test", phone: "+14155550177" };

  it("ignored email twice but answered texts: the next deal texts; the reason is observable", async () => {
    const { e, repo, sent, texts, advance } = setup();
    for (let i = 0; i < 2; i++) {
      const t = await e.deal({ request: REQ, budget_usd: 900, businesses: [{ ...BIZ, channel: "imessage" }], client_request_id: `t${i}` });
      advance(60_000);
      await e.ingestIMessage({ messageId: `im_r${i}`, from: BIZ.phone, text: "$700 total", isGroup: false });
      await e.advanceJob(t.job_id); // the webhook does this live
      await e.deal({ request: REQ, budget_usd: 900, businesses: [{ name: BIZ.name, email: BIZ.email }], client_request_id: `e${i}` }); // email, never answered
      advance(60 * 60_000);
    }
    expect(sent).toHaveLength(2);
    const d = await e.deal({ request: REQ, budget_usd: 900, businesses: [{ name: BIZ.name, email: BIZ.email, phone: BIZ.phone }] });
    expect(d.contacted[0]).toMatchObject({ channel: "imessage" });
    expect(texts).toHaveLength(3);
    const learning = await e.contactLearning(d.contacted[0]!.business_id);
    expect(learning.channels).toMatchObject({ email: { contacted_jobs: 2, replied_jobs: 0 }, imessage: { contacted_jobs: 3, replied_jobs: 2, quotes: 2 } });
    void repo;
  });

  it("a business that says 'please text me instead' is texted next time (it already replied by text once)", async () => {
    const { e, texts } = setup();
    const first = await e.deal({ request: REQ, budget_usd: 900, businesses: [{ ...BIZ, channel: "imessage" }], client_request_id: "a" });
    await e.ingestIMessage({ messageId: "im_p", from: BIZ.phone, text: "$700 total. Next time please text me instead of email.", isGroup: false });
    await e.advanceJob(first.job_id);
    const d = await e.deal({ request: REQ, budget_usd: 900, businesses: [{ name: BIZ.name, email: BIZ.email, phone: BIZ.phone }], client_request_id: "b" });
    expect(d.contacted[0]).toMatchObject({ channel: "imessage" });
    expect(texts).toHaveLength(2);
  });

  it("one board render reads each earlier job once to scope contact learning, however many of its businesses were on it", async () => {
    const { e, repo } = setup();
    const OTHER = { name: "Shine Team", email: "hi@shineteam.test" };
    const earlier: string[] = [];
    for (let i = 0; i < 2; i++) earlier.push((await e.deal({ request: REQ, budget_usd: 900, businesses: [{ name: BIZ.name, email: BIZ.email }, OTHER], client_request_id: `p${i}` })).job_id);
    const d = await e.deal({ request: REQ, budget_usd: 900, businesses: [{ name: BIZ.name, email: BIZ.email }, OTHER], client_request_id: "now" });
    const reads = new Map<string, number>();
    const getJob = repo.getJob.bind(repo);
    repo.getJob = async (id: string) => { reads.set(id, (reads.get(id) ?? 0) + 1); return getJob(id); };
    const board = (await e.forWorkspace("ws_default").getQuotes(d.job_id)) as unknown as { contact_learning?: Record<string, { channels: Record<string, { contacted_jobs: number }> }> };
    // Both businesses learned from all three of this workspace's jobs...
    expect(Object.values(board.contact_learning ?? {}).map((l) => l.channels.email?.contacted_jobs)).toEqual([3, 3]);
    // ...and each earlier job was read once for the whole board, not once per business.
    for (const id of earlier) expect(reads.get(id), id).toBe(1);
  });
});
