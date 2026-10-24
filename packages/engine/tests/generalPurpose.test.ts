// General purpose: the same engine and workflow buy a contractor job, not just catering. Real engine,
// fake Inkbox ports, a text extractor that reads only what the reply says. No network.
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, StubBrain } from "../src/index.ts";

// Reads figures and explicit yes/no answers from the text, like the Claude extractor (no guessing).
const extractor = {
  async extract(i: { bodyText: string; request: { requirements: string[] } }) {
    const t = i.bodyText;
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$([\d,]+)\s*(?:total|all[- ]in)/i);
    const deposit = money(/\$([\d,]+)\s*deposit/i);
    const answers = i.request.requirements.flatMap((req): { requirement: string; answer: "yes" | "no"; excerpt: string }[] => {
      const yes = new RegExp(`(yes|we are|we're)[^.]*${req.split(" ")[0]}`, "i").exec(t);
      const no = new RegExp(`no[^.]*(${req.split(" ")[0]}|license)`, "i").exec(t);
      return yes ? [{ requirement: req, answer: "yes", excerpt: yes[0] }] : no ? [{ requirement: req, answer: "no", excerpt: no[0] }] : [];
    });
    return {
      available: true, price_per_head_usd: null, headcount: 1, subtotal_usd: null, delivery_fee_usd: null, delivery_included: null, tax_usd: null, tax_included: /tax/i.test(t) ? true : null,
      total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [], requirement_answers: answers, valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
      // Claude cites every figure it sets; an uncited one is dropped (validate.ts).
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])], missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    };
  },
};

function engine(shared?: { repo: InMemoryRepository; t: number }) {
  let t = shared?.t ?? Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const sent: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const repo = shared?.repo ?? new InMemoryRepository({ now: clock.now });
  const e = new HaggleEngine({
    repo, now: clock.now, extractor: extractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { sent.push(m); return { providerId: `em_${sent.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${sent.length}@haggle.test>` }; } },
    imessage: { async send(r) { texts.push(r); return { messageId: `im_${texts.length}` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 2 },
  });
  return { engine: e, repo, clock, sent, texts };
}
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });

describe("a non-catering purchase: roof leak repair (contractor)", () => {
  it("RFQs speak the request's own units, a non-dietary requirement is confirmed only by the business's words, and the licensed roofer wins", async () => {
    const { engine: e, repo, sent, texts } = engine();
    // The roofers state no deposit, so the full total is due at approval: the workspace cap must allow it,
    // or no quote could be approved and none is recommended (workstream D: compliance gate).
    await e.updateSettings({ spending_cap_cents: 300_000 });
    const deal = await e.deal({
      request: { what: "roof leak repair", quantity: 1, unit: "job", date: "2026-11-03", area: "Oakland, CA", venue: "412 Grand Ave", requirements: [{ id: "lic", kind: "other", text: "Licensed and insured", hard: true }] },
      budget_usd: 3000,
      businesses: [{ name: "Bayside Roofing", email: "bids@bayside-roofing.test" }, { name: "Peak Roof Co", phone: "+15105550188", channel: "imessage" }],
    });
    expect(sent[0]!.subject).toMatch(/Quote request: roof leak repair, 1 job, /);
    expect(sent[0]!.bodyText).toMatch(/- Quantity: 1 job/);
    expect(sent[0]!.bodyText).not.toMatch(/People:|vegetarian/);
    // Persona (decision 17): the customer's AI assistant, never "Haggle"; the venue and date stay (main).
    expect(texts[0]!.text).toMatch(/^Hi Peak Roof Co, I'm an AI assistant for a customer\. Quote for roof leak repair/);
    expect(texts[0]!.text).not.toMatch(/Haggle/);
    expect(texts[0]!.text).toMatch(/Nov 3/);
    expect(texts[0]!.text).toMatch(/412 Grand Ave/);
    expect(texts[0]!.text.length).toBeLessThanOrEqual(159);

    const rfq = (await repo.getBusinesses(deal.job_id)).find((b) => b.name === "Bayside Roofing")!.rfq_message_id!;
    await e.ingest({ providerEventId: "e1", eventType: "message.received", providerEmailId: "in_1", threadId: "t1", messageId: "<in_1@x>", inReplyTo: [rfq], references: [rfq], from: "bids@bayside-roofing.test", to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "We can fix it for $2,400 total incl. materials, cleanup and tax. Yes, we're licensed and insured (CSLB #1234567). $240 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
    expect((await e.ingestIMessage({ messageId: "im_1", from: "+15105550188", text: "$1,900 total, cash, can come Tuesday", isGroup: false })).outcome).toBe("stored");
    await e.advanceJob(deal.job_id);

    let board = await e.getQuotes(deal.job_id);
    const by = (n: string) => board.quotes.find((q) => q.business === n && q.status === "current")!;
    expect(by("Bayside Roofing")).toMatchObject({ total_usd: 2400, verdict: "compliant", eligible: true });
    // Soft requirements (decision 1): still an option, ranked below the compliant quote, with the caveat.
    expect(by("Peak Roof Co")).toMatchObject({ total_usd: 1900, verdict: "incomplete", eligible: true, meets_requirements: false }); // licensing not stated
    expect(texts.at(-1)!.text).toMatch(/^Thanks! Can you confirm: Licensed and insured\? HG-/); // asked once, by text
    expect(board.recommended_quote_id).toBe(by("Bayside Roofing").quote_id);

    // Peak answers that it isn't licensed: now a stated "no"; the quote keeps its price and ranks below.
    expect((await e.ingestIMessage({ messageId: "im_2", from: "+15105550188", text: "No license, sorry, but we're cheap", isGroup: false })).outcome).toBe("stored");
    await e.advanceJob(deal.job_id);
    board = await e.getQuotes(deal.job_id);
    expect(by("Peak Roof Co")).toMatchObject({ total_usd: 1900, eligible: true, meets_requirements: false });
    expect(board.recommended_quote_id).toBe(by("Bayside Roofing").quote_id);
    expect(board.value!.explanation!.winner).toMatch(/^Bayside Roofing: best value/);
  });
});

describe("asynchronous resumption", () => {
  it("a deal started by one server process is finished by a fresh one (restart) from stored state alone", async () => {
    const first = engine();
    const deal = await first.engine.deal({
      request: { what: "office deep clean", quantity: 1, unit: "job", date: "2026-11-05", area: "San Francisco, CA", requirements: [] },
      budget_usd: 900, businesses: [{ name: "Sparkle Co", email: "hi@sparkle.test" }, { name: "Bright Crew", phone: "+14155550177", channel: "imessage" }],
    });
    const rfq = (await first.repo.getBusinesses(deal.job_id)).find((b) => b.name === "Sparkle Co")!.rfq_message_id!;

    // The process restarts: a new engine over the same store, no in-memory state carried over.
    const second = engine({ repo: first.repo, t: Date.now() + 60_000 });
    await second.engine.ingest({ providerEventId: "e9", eventType: "message.received", providerEmailId: "in_9", threadId: "t9", messageId: "<in_9@x>", inReplyTo: [rfq], references: [rfq], from: "hi@sparkle.test", to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "$780 total incl. supplies and tax. $100 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
    expect((await second.engine.ingestIMessage({ messageId: "im_9", from: "+14155550177", text: "$720 total, $0 deposit, tax included", isGroup: false })).outcome).toBe("stored");
    await second.engine.advanceJob(deal.job_id);
    const board = await second.engine.getQuotes(deal.job_id);
    expect(board.quotes.map((q) => [q.business, q.total_usd]).sort()).toEqual([["Bright Crew", 720], ["Sparkle Co", 780]]);
    // The restarted process carries on: both quoted, and it opens the negotiation round itself.
    expect({ state: board.state, statuses: board.businesses.map((b) => b.engine_status) }).toEqual({ state: "negotiating", statuses: ["quoted", "quoted"] });
    expect(board.recommended_quote_id).toBeTruthy();
    expect(first.sent).toHaveLength(1); // the original RFQ only
    expect(second.sent.map((m) => m.bodyText).join("\n")).toMatch(/another quote of \$720\.00 total/); // a new counter, citing the real quote
    expect(second.sent.some((m) => /Could you quote the following/.test(m.bodyText))).toBe(false); // no RFQ re-sent after the restart
    expect(second.texts).toHaveLength(0);
  });
});
