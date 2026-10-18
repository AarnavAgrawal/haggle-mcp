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
      sources: total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : [], missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    };
  },
};

function engine() {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const sent: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const repo = new InMemoryRepository();
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
    const deal = await e.deal({
      request: { what: "roof leak repair", quantity: 1, unit: "job", date: "2026-11-03", area: "Oakland, CA", venue: "412 Grand Ave", requirements: [{ id: "lic", kind: "other", text: "Licensed and insured", hard: true }] },
      budget_usd: 3000,
      businesses: [{ name: "Bayside Roofing", email: "bids@bayside-roofing.test" }, { name: "Peak Roof Co", phone: "+15105550188", channel: "imessage" }],
    });
    expect(sent[0]!.subject).toMatch(/Quote request: roof leak repair, 1 job, /);
    expect(sent[0]!.bodyText).toMatch(/- Quantity: 1 job/);
    expect(sent[0]!.bodyText).not.toMatch(/People:|vegetarian/);
    expect(texts[0]!.text).toMatch(/^Hi Peak Roof Co, Haggle AI assistant here\. Quote for roof leak repair on Tue, Nov 3 at 412 Grand Ave/);
    expect(texts[0]!.text.length).toBeLessThanOrEqual(159);

    const rfq = (await repo.getBusinesses(deal.job_id)).find((b) => b.name === "Bayside Roofing")!.rfq_message_id!;
    await e.ingest({ providerEventId: "e1", eventType: "message.received", providerEmailId: "in_1", threadId: "t1", messageId: "<in_1@x>", inReplyTo: [rfq], references: [rfq], from: "bids@bayside-roofing.test", to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "We can fix it for $2,400 total incl. materials, cleanup and tax. Yes, we're licensed and insured (CSLB #1234567). $240 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
    expect((await e.ingestIMessage({ messageId: "im_1", from: "+15105550188", text: "$1,900 total, cash, can come Tuesday", isGroup: false })).outcome).toBe("stored");
    await e.advanceJob(deal.job_id);

    let board = await e.getQuotes(deal.job_id);
    const by = (n: string) => board.quotes.find((q) => q.business === n && q.status === "current")!;
    expect(by("Bayside Roofing")).toMatchObject({ total_usd: 2400, verdict: "compliant", eligible: true });
    expect(by("Peak Roof Co")).toMatchObject({ total_usd: 1900, verdict: "incomplete", eligible: false }); // licensing not stated
    expect(texts.at(-1)!.text).toMatch(/^Thanks! Can you confirm: Licensed and insured\? HG-/); // asked once, by text
    expect(board.recommended_quote_id).toBe(by("Bayside Roofing").quote_id);

    // Peak answers that it isn't licensed: now a stated "no", the quote keeps its price and stays out.
    expect((await e.ingestIMessage({ messageId: "im_2", from: "+15105550188", text: "No license, sorry, but we're cheap", isGroup: false })).outcome).toBe("stored");
    await e.advanceJob(deal.job_id);
    board = await e.getQuotes(deal.job_id);
    expect(by("Peak Roof Co")).toMatchObject({ total_usd: 1900, eligible: false });
    expect(board.recommended_quote_id).toBe(by("Bayside Roofing").quote_id);
    expect(board.value!.explanation!.winner).toMatch(/^Bayside Roofing: best value/);
  });
});
