// Live 2026-10-18 (HG-2QAM): Harbor Table quoted $2,750 by email but stayed "contacted/waiting" on
// the board, and the deal sat in "collecting quotes" for the whole 30-minute window although every
// business had answered by ~08:34. Mission Eats (phone) was also called back twice: once for the
// vegetarian count the first call never confirmed, once to relay the user's status note ("Still
// waiting on other offers.") as the "answer" to its closing question "So, will you be using us?".
//
// Root causes reproduced here:
// - two advances parsed the same reply at once (a dev hot reload left the old engine's tick
//   running); the losing parse found the quote already stored and wrote status "replied" over
//   "quoted"; and the window counted any "replied" business as still to answer, until the deadline.
// - courtesy questions were treated as questions for the user.
// Real engine, in-memory store, fake ports; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig } from "../src/index.ts";
import type { QuoteExtraction } from "../src/parsing/extraction.ts";
import { validateQuote } from "../src/parsing/validate.ts";

const HUMAN = "+14155550199";
const MISSION = "+14155550104";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const COURTESY = /using us|what's the plan|let me know|any questions/i;

/** Reads totals, vegetarian counts, delivery and questions out of free text; judges questions like Claude does. */
function textExtractor(gate?: () => Promise<void>) {
  const seen: string[] = [];
  return {
    seen,
    async extract(i: { bodyText: string }): Promise<QuoteExtraction> {
      seen.push(i.bodyText);
      if (gate) await gate();
      const t = i.bodyText.split("\n").filter((l) => !/^\s*(local|haggle|\[haggle)/i.test(l)).map((l) => l.replace(/^\s*(remote|\[the business's reply\])\s*:\s*/i, "")).join("\n");
      const m = t.match(/\$\s?([\d,]+)\s*total/i);
      const total = m ? Number(m[1]!.replace(/,/g, "")) : null;
      const veg = t.match(/(\d+)\s*veg/i);
      const pp = t.match(/\$\s?(\d+)\s*per person/i);
      const questions = t.split(/(?<=[.?!])\s+|\n/).map((s) => s.trim()).filter((s) => s.endsWith("?")).map((text) => ({ text, needs_answer_to_quote: !COURTESY.test(text) }));
      return {
        available: true, price_per_head_usd: pp ? Number(pp[1]) : null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: /deliver/i.test(t) ? true : null, tax_usd: null, tax_included: true,
        total_usd: total, deposit_usd: total ? 100 : null, menu_items: [], dietary_coverage: veg ? [{ need: "vegetarian", covered: true, count_offered: Number(veg[1]) }] : [], valid_until: null,
        questions, payment_request: "none", instructions_to_agent: false,
        sources: [
          ...(total ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }, { field: "deposit" as const, source: "email body", excerpt: "$100 deposit" }] : []),
          ...(pp ? [{ field: "price_per_head" as const, source: "email body", excerpt: pp[0] }] : []),
        ],
        missing_fields: total ? [] : ["total"], confidence: 0.9,
      };
    },
  };
}

function env(opts: { config?: Partial<EngineConfig>; gate?: () => Promise<void>; repo?: InMemoryRepository } = {}) {
  let t = Date.now(); // the in-memory repo stamps rows with the wall clock
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const calls: { toNumber: string; reason: string }[] = [];
  const repo = opts.repo ?? new InMemoryRepository({ now: clock.now });
  const extractor = textExtractor(opts.gate);
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    phone: { async placeCall(r) { calls.push(r as never); return { callId: `call_${calls.length}` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 5 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 2, notifyPhone: HUMAN, callCooldownMs: 0, replyGraceMs: 10 * 60_000, ...opts.config,
    },
  });
  return { engine, repo, clock, emails, texts, calls, extractor };
}
type Env = ReturnType<typeof env>;
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
const HARBOR = { name: "Harbor Table", email: "harbor@inkboxmail.test" };
const SUNSET = { name: "Sunset Kitchen", email: "sunset@inkboxmail.test" };
const BAY = { name: "Bay Catering", email: "bay@inkboxmail.test" };
let n = 0;
async function ingestEmail(e: Env, jobId: string, name: string, bodyText: string) {
  const b = (await e.repo.getBusinesses(jobId)).find((x) => x.name === name)!;
  n++;
  return e.engine.ingest({ providerEventId: `ce${n}`, eventType: "message.received", providerEmailId: `cin_${n}`, threadId: `ct${n}`, messageId: `<cin_${n}@x>`, inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: b.email!, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
}
async function reply(e: Env, jobId: string, name: string, bodyText: string) {
  await ingestEmail(e, jobId, name, bodyText);
  await e.engine.advanceJob(jobId);
}
const statusOf = async (e: Env, jobId: string, name: string) => (await e.repo.getBusinesses(jobId)).find((b) => b.name === name)!.status;
const boardOf = async (e: Env, jobId: string, name: string) => (await e.engine.getQuotes(jobId)).businesses.find((b) => b.name === name)!.status;

describe("a business with a current quote is 'quoted', whatever order the writes landed in", () => {
  it("two parses of the same reply at once (an old engine's tick after a hot reload): one quote, no duplicate question, status stays quoted", async () => {
    // Both parses wait at the gate until both have read the reply, then finish together: the real interleaving.
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((r) => { open = r; });
    const e = env({ gate: async () => { if (++arrived === 2) open(); await both; } });
    const deal = await e.engine.deal({ request, budget_usd, businesses: [HARBOR, SUNSET] });
    await ingestEmail(e, deal.job_id, "Harbor Table", "Delighted to cater. $1,150 total, delivered, 12 veg meals. Would you like dessert too?");
    const job = (await e.repo.getJob(deal.job_id))!;
    // Bypass the per-process queue: this is what two processes (or two engine instances) do.
    const parse = () => (e.engine as unknown as { parsePending(j: typeof job): Promise<void> }).parsePending(job);
    await Promise.all([parse(), parse()]);
    expect(e.extractor.seen).toHaveLength(2);
    const quotes = await e.repo.listQuotes(deal.job_id);
    expect(quotes).toHaveLength(1);
    expect((await e.repo.listQuestions(deal.job_id)).filter((q) => q.business_id === quotes[0]!.business_id)).toHaveLength(1);
    expect(await statusOf(e, deal.job_id, "Harbor Table")).toBe("quoted");
    expect(await boardOf(e, deal.job_id, "Harbor Table")).toBe("quoted");
  });

  it("engine instances in one process share the advance queue: a reply is read once", async () => {
    const repo = new InMemoryRepository();
    const a = env({ repo });
    const b = env({ repo });
    const deal = await a.engine.deal({ request, budget_usd, businesses: [HARBOR, SUNSET] });
    await ingestEmail(a, deal.job_id, "Harbor Table", "$1,150 total, delivered, 12 veg meals.");
    await Promise.all([a.engine.advanceJob(deal.job_id), b.engine.advanceJob(deal.job_id), a.engine.advanceJob(deal.job_id)]);
    expect(a.extractor.seen.length + b.extractor.seen.length).toBe(1);
    expect(await statusOf(a, deal.job_id, "Harbor Table")).toBe("quoted");
  });

  it("a stale status row ('replied' after the quote) neither hides the quote on the board nor holds the window", async () => {
    const e = env();
    const deal = await e.engine.deal({ request, budget_usd, businesses: [HARBOR, SUNSET] });
    await reply(e, deal.job_id, "Harbor Table", "$1,150 total, delivered, 12 veg meals.");
    const harbor = (await e.repo.getBusinesses(deal.job_id)).find((x) => x.name === "Harbor Table")!;
    await e.repo.updateBusiness(deal.job_id, harbor.business_id, { status: "replied" }); // the live symptom
    expect(await boardOf(e, deal.job_id, "Harbor Table")).toBe("quoted");
    expect((await e.engine.getQuotes(deal.job_id)).next).toMatch(/waiting for Sunset Kitchen;/);
    await reply(e, deal.job_id, "Sunset Kitchen", "$1,100 total, delivered, 12 veg meals.");
    const job = (await e.repo.getJob(deal.job_id))!;
    expect(job.state === "negotiating" || job.ready).toBe(true);
  });
});

describe("collection closes as soon as every contacted business has answered", () => {
  it("all quoted well inside a 30-minute window: negotiation starts at once (counteroffers out)", async () => {
    const e = env();
    const deal = await e.engine.deal({ request, budget_usd, businesses: [HARBOR, SUNSET, BAY] });
    await reply(e, deal.job_id, "Harbor Table", "$1,150 total, delivered, 12 veg meals.");
    await reply(e, deal.job_id, "Sunset Kitchen", "$1,180 total, delivered, 12 veg meals.");
    expect((await e.repo.getJob(deal.job_id))!.state).toBe("collecting");
    expect((await e.engine.getQuotes(deal.job_id)).next).toMatch(/Still collecting: waiting for Bay Catering; quotes close as soon as every business has answered/);
    e.clock.advance(2 * 60_000);
    await reply(e, deal.job_id, "Bay Catering", "$1,020 total, delivered, 12 veg meals.");
    const job = (await e.repo.getJob(deal.job_id))!;
    expect(job.state).toBe("negotiating");
    expect(job.round).toBe(2);
    expect((await e.repo.listEvents(deal.job_id)).some((x) => x.type === "counteroffers_sent")).toBe(true);
  });

  it("a business that just got a follow-up holds the window only briefly (followUpHoldMs, 3 min by default), not to the deadline", async () => {
    const e = env();
    const deal = await e.engine.deal({ request, budget_usd, businesses: [HARBOR, SUNSET] });
    await reply(e, deal.job_id, "Harbor Table", "$1,150 total, delivered."); // no vegetarian count: one follow-up
    await reply(e, deal.job_id, "Sunset Kitchen", "$1,100 total, delivered, 12 veg meals.");
    expect(e.emails.at(-1)).toMatchObject({ to: HARBOR.email });
    expect(e.emails.at(-1)!.bodyText).toMatch(/At least 12 vegetarian meals/);
    expect((await e.repo.getJob(deal.job_id))!.state).toBe("collecting");
    e.clock.advance(2 * 60_000);
    await e.engine.advanceJob(deal.job_id);
    expect((await e.repo.getJob(deal.job_id))!.state).toBe("collecting"); // still within the hold
    e.clock.advance(60_000 + 1_000);
    await e.engine.advanceJob(deal.job_id);
    const job = (await e.repo.getJob(deal.job_id))!;
    expect(job.state !== "collecting" || job.ready).toBe(true); // ~3 min in, not the 30-min deadline
  });

  it("the follow-up answered: closes at once", async () => {
    const e = env();
    const deal = await e.engine.deal({ request, budget_usd, businesses: [HARBOR, SUNSET] });
    await reply(e, deal.job_id, "Harbor Table", "$1,150 total, delivered.");
    await reply(e, deal.job_id, "Sunset Kitchen", "$1,100 total, delivered, 12 veg meals.");
    expect((await e.repo.getJob(deal.job_id))!.state).toBe("collecting");
    await reply(e, deal.job_id, "Harbor Table", "Yes, 12 veg meals.");
    const job = (await e.repo.getJob(deal.job_id))!;
    expect(job.state === "negotiating" || job.ready).toBe(true);
  });

  it("replay of HG-2QAM: email quotes, a question the user answers by text, a phone quote whose follow-up call ends with a courtesy question -> negotiation by ~6 minutes, no extra call", async () => {
    const e = env();
    const deal = await e.engine.deal({ request, budget_usd, businesses: [HARBOR, SUNSET, { name: "Mission Eats", phone: MISSION }] });
    await e.engine.advanceJob(deal.job_id);
    expect(e.calls).toHaveLength(1); // the quote call
    await reply(e, deal.job_id, "Harbor Table", "Our quote for 40 guests comes to $1,150 total, delivered, 12 veg meals.");
    await reply(e, deal.job_id, "Sunset Kitchen", "Before we put the quote together: would you like a dessert tray with cookies and brownies?");
    expect(await boardOf(e, deal.job_id, "Harbor Table")).toBe("quoted");
    e.clock.advance(60_000);
    await e.engine.advanceJob(deal.job_id);
    expect(e.texts.filter((x) => x.to === HUMAN).at(-1)!.text).toMatch(/Sunset Kitchen asks/);
    expect((await e.engine.ingestText({ messageId: "h1", from: HUMAN, text: "add cookies and brownies", inbound: true })).outcome).toBe("answered");
    expect(e.emails.at(-1)).toMatchObject({ to: SUNSET.email });
    // Mission Eats' first call: a price, but the vegetarian count never came up -> one follow-up call.
    e.clock.advance(60_000);
    await e.engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "local: Hi, I'm an AI assistant calling on behalf of a customer.\nremote: It would be $1,090 total all-in, delivered." });
    await e.engine.advanceJob(deal.job_id);
    expect(e.calls).toHaveLength(2);
    expect(e.calls[1]!.reason).toMatch(/At least 12 vegetarian meals/);
    await reply(e, deal.job_id, "Sunset Kitchen", "With the dessert tray: $1,180 total, delivered, 12 veg meals.");
    expect((await e.repo.getJob(deal.job_id))!.state).toBe("collecting"); // Mission Eats is on its follow-up
    // The follow-up call: confirmed, then a closing pleasantry that is not a question for the user.
    e.clock.advance(2 * 60_000);
    await e.engine.ingestCall({ callId: "call_2", outcome: "completed", transcript: "local: Can you confirm 12 of the meals can be vegetarian?\nremote: Yes, 12 veg meals.\nremote: So, will you be using us or what's the plan?\nlocal: I'll pass that on." });
    await e.engine.advanceJob(deal.job_id);
    const job = (await e.repo.getJob(deal.job_id))!;
    expect(job.state).toBe("negotiating"); // every business answered: no waiting out the 30-minute window
    const mission = (await e.repo.getBusinesses(deal.job_id)).find((x) => x.name === "Mission Eats")!;
    expect((await e.repo.listQuestions(deal.job_id)).filter((q) => q.business_id === mission.business_id)).toHaveLength(0);
    expect(e.texts.filter((x) => x.to === HUMAN).some((x) => /using us/.test(x.text))).toBe(false);
    expect(e.calls).toHaveLength(2); // the quote call and its one follow-up; no call to relay a status note
    expect((await e.repo.listMessages(deal.job_id)).filter((m) => m.direction === "out" && m.kind === "answer" && m.business_id === mission.business_id)).toHaveLength(0);
    const courtesy = (await e.repo.listEvents(deal.job_id)).find((x) => x.data.kind === "courtesy_question")!;
    expect(String(courtesy.data.summary)).toMatch(/Mission Eats asked "So, will you be using us or what's the plan\?" \(no answer needed/);
    const current = (await e.repo.listQuotes(deal.job_id)).find((q) => q.business_id === mission.business_id && q.status === "current")!;
    expect(current.record.courtesy_questions).toEqual(["So, will you be using us or what's the plan?"]);
  });
});

describe("one follow-up per business", () => {
  it("no stated total AND a missing requirement: one message asks for both", async () => {
    const e = env();
    const deal = await e.engine.deal({ request, budget_usd, businesses: [HARBOR, SUNSET] });
    const before = e.emails.length;
    await reply(e, deal.job_id, "Harbor Table", "We charge $28 per person."); // no total (delivery unstated), no vegetarian count
    const toHarbor = e.emails.slice(before).filter((m) => m.to === HARBOR.email);
    expect(toHarbor).toHaveLength(1);
    expect(toHarbor[0]!.bodyText).toMatch(/exact all-in total/);
    expect(toHarbor[0]!.bodyText).toMatch(/At least 12 vegetarian meals/);
    const harbor = (await e.repo.getBusinesses(deal.job_id)).find((x) => x.name === "Harbor Table")!;
    expect(harbor.followups_sent).toBe(1);
  });

  // Decision 47: per person x headcount with delivery and tax stated is a total Haggle trusts; only the missing requirement is asked.
  it("a total worked out from stated parts is trusted: the one follow-up asks only for the missing requirement", async () => {
    const e = env();
    const deal = await e.engine.deal({ request, budget_usd, businesses: [HARBOR, SUNSET] });
    const before = e.emails.length;
    await reply(e, deal.job_id, "Harbor Table", "We charge $28 per person, delivered."); // $1,120 for 40, tax included; no vegetarian count
    const toHarbor = e.emails.slice(before).filter((m) => m.to === HARBOR.email);
    expect(toHarbor).toHaveLength(1);
    expect(toHarbor[0]!.bodyText).toMatch(/At least 12 vegetarian meals/);
    expect(toHarbor[0]!.bodyText).not.toMatch(/all-in total|worked it out|read your quote/);
    const q = (await e.engine.getQuotes(deal.job_id)).quotes.find((x) => x.business === "Harbor Table")!;
    expect(q).toMatchObject({ total_usd: 1120, approvable: true });
  });

  it("the quote call asks to confirm each must-have in its read-back (so it needn't call back), under 2,000 chars", () => {
    const reqs = ["Food for 100 people", "At least 20 vegetarian meals", "Delivered to Y Combinator HQ in San Francisco, CA", "Delivery on Thursday, October 29, 2026"];
    const job = { short_code: "2QAM", request: { what: "catering for an event", quantity: 100, unit: "meals", date: "2026-10-29", area: "Y Combinator HQ, San Francisco, CA", requirements: [] } } as never;
    const b = HaggleEngine.callBrief("Mission Eats", job, reqs);
    expect(b).toMatch(/If they haven't said how each must-have is met, ask once before the read-back/);
    expect(b).toMatch(/and each must-have they confirmed/);
    expect(b.length).toBeLessThanOrEqual(2000);
    expect(b).toMatch(/Reference HG-2QAM\.$/); // not clipped: the safety rules are the last line
  });
});

describe("questions: what needs the user's answer vs courtesy", () => {
  it("validateQuote keeps only the questions the buyer must answer; courtesy ones are recorded, never relayed", () => {
    const x = textExtractor();
    return x.extract({ bodyText: "$1,150 total, delivered, 12 veg meals." }).then((base) => {
      const r = validateQuote({ ...base, questions: [{ text: "So, will you be using us?", needs_answer_to_quote: false }, { text: "Drop-off or full service?", needs_answer_to_quote: true }, "Plates too?"] }, 40, []);
      expect(r.questions).toEqual(["Drop-off or full service?", "Plates too?"]);
      expect(r.courtesy_questions).toEqual(["So, will you be using us?"]);
      const onlyCourtesy = validateQuote({ ...base, total_usd: null, sources: [], questions: [{ text: "Let me know?", needs_answer_to_quote: false }] }, 40, []);
      expect(onlyCourtesy.questions).toEqual([]);
      expect(onlyCourtesy.flags).not.toContain("question_pending");
    });
  });
});

describe("a text from the user that answers nothing open", () => {
  it("is never dropped silently: the user is told how to change the request, and the agent sees it on the deal", async () => {
    const e = env();
    const deal = await e.engine.deal({ request, budget_usd, businesses: [HARBOR, SUNSET] });
    await reply(e, deal.job_id, "Harbor Table", "$1,150 total, delivered, 12 veg meals.");
    const before = e.emails.length;
    expect((await e.engine.ingestText({ messageId: "u1", from: HUMAN, text: "add cookies and brownies", inbound: true })).outcome).toBe("no_open_question");
    expect(e.emails.length).toBe(before); // nothing to any business
    expect(e.texts.filter((x) => x.to === HUMAN).at(-1)!.text).toMatch(/^Haggle: got "add cookies and brownies", but no business question is open, so nothing was sent\. To change the request, tell your agent in Claude\./);
    const w = await e.engine.waitForUpdate(deal.job_id, 0, 0);
    expect(w.updates.some((u) => u.type === "reply" && /^You texted: "add cookies and brownies"/.test(u.summary))).toBe(true);
    // Redelivery of the same webhook: handled once.
    expect((await e.engine.ingestText({ messageId: "u1", from: HUMAN, text: "add cookies and brownies", inbound: true })).outcome).toBe("duplicate");
  });
});
