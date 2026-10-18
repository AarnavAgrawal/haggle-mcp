// Issue 6 (live 2026-10-17/18): Haggle claimed requirements weren't stated although they were, and
// asked businesses to restate facts of the request (the date). Claude now judges each requirement
// with evidence (requirement_checks); code only does arithmetic and safety; request facts count as
// accepted when the business quotes without contradicting them; judgements carry across replies and
// channels. Real replies are in fixtures/live-misses/requirement-checks.json. Fake extractor, no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, mergeCarryOver, StubBrain, type EngineConfig } from "../src/index.ts";
import type { QuoteExtraction } from "../src/parsing/extraction.ts";
import { buildContent, historyText, SYSTEM, type ExtractionRequest } from "../src/parsing/parseReply.ts";
import { canonicalNeed, validateQuote, validateRequirementChecks } from "../src/parsing/validate.ts";
import { evaluateRequirements, meetsHardRequirements, type EngineRequirement } from "../src/parsing/requirements.ts";
import { heuristicExtract } from "../src/parsing/heuristic.ts";
import { toEngineRequirement } from "../src/workflow/mapping.ts";
import { QuoteExtraction as QuoteExtractionSchema } from "../src/parsing/extraction.ts";
import type { Request } from "../src/contract.ts";

type Case = {
  name: string; request: string; channel: "email" | "phone" | "imessage"; body: string; extraction: QuoteExtraction;
  expected: Record<string, boolean | null>; expected_followup: string[];
  later?: { body: string; extraction: QuoteExtraction; expected: Record<string, boolean | null> };
};
const FX = JSON.parse(readFileSync(new URL("../../../fixtures/live-misses/requirement-checks.json", import.meta.url), "utf8")) as {
  requests: Record<string, Request & { source_job: string }>; cases: Case[];
};
const requestOf = (c: Case): Request => {
  const { source_job: _s, ...r } = FX.requests[c.request]!;
  return r;
};
const reqsOf = (c: Case): EngineRequirement[] => requestOf(c).requirements.map(toEngineRequirement);
const needsOf = (reqs: EngineRequirement[]) => reqs.filter((r) => r.kind === "dietary" && r.need).map((r) => r.need!);

function judge(c: Case, x: QuoteExtraction, prev: ReturnType<typeof validateQuote> | null = null) {
  const reqs = reqsOf(c);
  const record = mergeCarryOver(validateQuote(x, requestOf(c).quantity, [], { needs: needsOf(reqs), requirementIds: reqs.map((r) => r.id) }), prev);
  const results = evaluateRequirements(record, reqs, requestOf(c).quantity);
  return { record, results, met: Object.fromEntries(results.map((r) => [r.requirement_id, r.met])), compliant: meetsHardRequirements(results, reqs) };
}

describe("per-requirement judgement on the real misses (fixtures/live-misses)", () => {
  it.each(FX.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const first = judge(c, c.extraction);
    expect(first.met).toEqual(c.expected);
    // Every yes from Claude carries the business's words.
    for (const r of first.results) if (r.basis === "claude" && r.met !== null) expect(r.evidence ?? r.reason).toBeTruthy();
    if (c.later) {
      // A later reply on another channel/turn that doesn't mention a requirement keeps what was settled.
      const later = judge(c, c.later.extraction, first.record);
      expect(later.met).toEqual(c.later.expected);
      expect(later.compliant).toBe(Object.values(c.later.expected).every((v) => v === true));
    }
  });

  it("the old dietary key mismatch ('20 vegetarian') is mapped onto the requested need", () => {
    expect(canonicalNeed("20 vegetarian", ["vegetarian"])).toBe("vegetarian");
    expect(canonicalNeed("veg meals", ["vegetarian"])).toBe("vegetarian");
    expect(canonicalNeed("vegan", ["vegetarian", "vegan"])).toBe("vegan");
    expect(canonicalNeed("halal", ["vegetarian"])).toBe("halal");
  });

  it("without Claude's judgement (keyword fallback): the date is accepted from the quote, a stated veg count decides, an unstated one stays unknown", () => {
    const c = FX.cases.find((x) => x.name === "golden-grill-20-veg-or-more-text")!;
    const req = requestOf(c);
    const reqs = reqsOf(c);
    // The same text with a total the keyword rules can read ("$13/prseon" alone is no price to them).
    const x = heuristicExtract({ request: { what: req.what, location: req.area, dietary: [{ need: "vegetarian", count: 20 }], requirements: [], channel: "imessage" }, bodyText: c.body.replace("can do $13/prseon", "can do $1,454 total") });
    expect(x.requirement_checks).toBeUndefined();
    expect(x.confidence).toBeLessThan(0.6);
    const results = evaluateRequirements(validateQuote(x, req.quantity, [], { needs: ["vegetarian"] }), reqs, req.quantity);
    expect(Object.fromEntries(results.map((r) => [r.requirement_id, r.met]))).toEqual({ veg20: true, delivery: true, date: true });
    expect(results.find((r) => r.requirement_id === "veg20")!.basis).toBe("arithmetic");
    expect(results.find((r) => r.requirement_id === "date")!.basis).toBe("request_fact");
  });

  it("a request fact isn't accepted from a reply without a price, nor from a decline", () => {
    const c = FX.cases.find((x) => x.name === "harbor-table-date-in-prose")!;
    const unpriced = { ...c.extraction, total_usd: null, price_per_head_usd: null, sources: [], requirement_checks: undefined };
    expect(judge(c, unpriced).met.date).toBeNull();
    const declined = { ...c.extraction, available: false, requirement_checks: undefined };
    expect(judge(c, declined).met.date).toBeNull();
  });

  it("an unexplained or unknown-id judgement is not trusted", () => {
    const checks = validateRequirementChecks([
      { requirement_id: "veg20", met: true, evidence: "", note: "" },
      { requirement_id: "made_up", met: true, evidence: "x", note: "y" },
      { requirement_id: "date", met: false, evidence: "Sunday instead", note: "" },
    ], ["veg20", "date"]);
    expect(checks).toEqual({ veg20: { met: null, evidence: "", note: "" }, date: { met: false, evidence: "Sunday instead", note: "" } });
  });

  it("a contradiction in a later reply wins over a carried yes", () => {
    const c = FX.cases.find((x) => x.name === "harbor-table-date-in-prose")!;
    const first = judge(c, c.extraction);
    const revised = { ...c.extraction, requirement_checks: [{ requirement_id: "date", met: false, evidence: "we can only do Sunday now", note: "moved to Sunday" }] };
    expect(judge(c, revised, first.record).met).toMatchObject({ date: false, veg20: true });
  });
});

describe("the parser request: requirements by id, the earlier conversation, the schema", () => {
  const c = FX.cases[0]!;
  const r = requestOf(c);
  const req: ExtractionRequest = {
    what: r.what, date: r.date!, headcount: r.quantity!, location: r.area, dietary: [{ need: "vegetarian", count: 20 }], requirements: r.requirements.map((x) => x.text),
    requirementList: r.requirements.map((x) => ({ id: x.id, kind: x.kind, text: x.text, ...(x.min_count !== undefined ? { min_count: x.min_count } : {}) })),
    history: [{ from: "business", channel: "imessage", text: "i can do 20 veg meals or more" }, { from: "haggle", channel: "imessage", text: "Could you text back your exact all-in total?" }],
  };

  it("lists each requirement with its id and wraps the earlier conversation as untrusted context", () => {
    const text = (buildContent(req, "1454")[0] as { text: string }).text;
    expect(text).toContain("- veg20 (dietary, at least 20): At least 20 vegetarian meals (included in the 100)");
    expect(text).toContain("- date (date): Saturday, October 24, 2026");
    expect(text).toContain('at least 20 vegetarian (need: "vegetarian")');
    expect(text).toMatch(/<<<EARLIER_CONVERSATION\n\[The business, imessage\]:\ni can do 20 veg meals or more\n\n\[Haggle \(our AI assistant; not the business's words\), imessage\]:/);
    expect(text.indexOf("EARLIER_CONVERSATION>>>")).toBeLessThan(text.indexOf("<<<BUSINESS_EMAIL"));
  });

  it("the earlier conversation is clipped, newest kept", () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ from: "business" as const, channel: "email", text: `${i} `.repeat(400) }));
    const h = historyText(long);
    expect(h.length).toBeLessThanOrEqual(6000 + 200);
    expect(h).toContain("11 11");
    expect(h).not.toContain("0 0 0");
  });

  it("the prompt asks for a judgement per requirement and accepts request facts; the schema is plain (nullable met)", () => {
    expect(SYSTEM).toMatch(/requirement_checks has one entry per requirement/);
    expect(SYSTEM).toMatch(/restates a fact of the request itself/);
    expect(SYSTEM).toMatch(/"vegetarian", not "12 vegetarian"/);
    expect(SYSTEM).toMatch(/untrusted data/);
    const shape = QuoteExtractionSchema.shape.requirement_checks.element.shape;
    expect(Object.keys(shape)).toEqual(["requirement_id", "met", "evidence", "note"]);
    expect(shape.met.safeParse(null).success).toBe(true);
  });
});

// The engine end to end: no follow-up asks for what the business already said, the date included.
function engineWith(cases: Case[], config: Partial<EngineConfig> = {}) {
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const calls: { toNumber: string; reason?: string }[] = [];
  const seen: { request: ExtractionRequest; bodyText: string }[] = [];
  const repo = new InMemoryRepository();
  const key = (body: string) => body.split("\n").find((l) => l.trim().length > 30)!.trim().slice(0, 60);
  const extractor = {
    async extract(i: { request: ExtractionRequest; bodyText: string }) {
      seen.push(i);
      for (const c of cases) {
        if (c.later && i.bodyText.includes(key(c.later.body))) return structuredClone(c.later.extraction);
        if (i.bodyText.includes(key(c.body))) return structuredClone(c.extraction);
      }
      throw new Error(`no fixture for: ${i.bodyText.slice(0, 80)}`);
    },
  };
  const engine = new HaggleEngine({
    repo, extractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    phone: { async placeCall(r) { calls.push(r); return { callId: `call_${calls.length}` }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, callCooldownMs: 0, ...config,
    },
  });
  return { engine, repo, emails, calls, seen };
}
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
const askedFor = async (repo: InMemoryRepository, jobId: string) => (await repo.listEvents(jobId)).filter((e) => e.type === "reply" && /^Asked .* for: /.test(String(e.data.summary))).map((e) => String(e.data.summary));

describe("engine: follow-ups ask only for what is really missing", () => {
  const emailCases = FX.cases.filter((c) => c.channel === "email");
  it.each(emailCases.map((c) => [c.name, c] as const))("%s (email)", async (_n, c) => {
    const { engine, repo, emails, seen } = engineWith([c]);
    const deal = await engine.deal({ request: requestOf(c), budget_usd: 5000, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
    const b = (await repo.getBusinesses(deal.job_id))[0]!;
    await engine.ingest({ providerEventId: "e1", eventType: "message.received", providerEmailId: "in_1", threadId: "t1", messageId: "<in_1@x>", inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: "harbor@inkboxmail.test", to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: c.body, attachments: [], attachmentsDownloadUrl: null }, trusted);
    await engine.advanceJob(deal.job_id);
    // Claude was given every requirement by id.
    expect(seen[0]!.request.requirementList?.map((r) => r.id)).toEqual(requestOf(c).requirements.map((r) => r.id));
    const q = (await repo.listQuotes(deal.job_id)).find((x) => x.status === "current")!;
    expect(Object.fromEntries(q.requirement_results.map((r) => [r.requirement_id, r.met]))).toEqual(c.expected);
    const asked = await askedFor(repo, deal.job_id);
    if (c.expected_followup.length === 0) {
      expect(asked).toEqual([]);
      expect(emails.filter((m) => /Could you also tell us/.test(m.bodyText))).toHaveLength(0);
    } else {
      expect(asked).toHaveLength(1);
      for (const t of c.expected_followup) expect(asked[0]).toContain(t);
      // Never a restated fact of the request.
      expect(asked[0]).not.toContain("October 24");
    }
  });

  it("a call transcript then a follow-up call: Claude sees the earlier call, and the vegetarian yes survives the second call", async () => {
    const c = FX.cases.find((x) => x.name === "mission-eats-call-all-veg-then-confirms-date")!;
    const { engine, repo, seen, calls } = engineWith([c]);
    const deal = await engine.deal({ request: requestOf(c), budget_usd: 5000, businesses: [{ name: "Mission Eats", phone: "+14155550104" }] });
    await engine.advanceJob(deal.job_id);
    expect((await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: c.body })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    let q = (await repo.listQuotes(deal.job_id)).find((x) => x.status === "current")!;
    expect(q.compliant).toBe(true);
    expect(await askedFor(repo, deal.job_id)).toEqual([]);
    // $17 x 40 + $100 delivery + 10% tax, all stated: Haggle trusts the total it worked out and places
    // no confirmation call (decision 47; live, Mission Eats got one).
    expect(q.total_cents).toBe(84_800); // $680 + $68 tax on the food + $100 delivery
    expect(calls).toHaveLength(1);
    // A second call (the agent's message by phone); its transcript doesn't mention vegetarian.
    await engine.sendMessage(deal.job_id, q.business_id, { text: "Could you confirm lunch delivery on October 30th?" });
    expect(calls).toHaveLength(2);
    expect((await engine.ingestCall({ callId: "call_2", outcome: "completed", transcript: c.later!.body })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    const last = seen.at(-1)!;
    expect(last.request.history?.some((h) => h.from === "business" && h.channel === "phone" && /all the vegetarian meals/.test(h.text))).toBe(true);
    q = (await repo.listQuotes(deal.job_id)).find((x) => x.status === "current")!;
    expect(Object.fromEntries(q.requirement_results.map((r) => [r.requirement_id, r.met]))).toEqual(c.later!.expected);
    expect(q.requirement_results.find((r) => r.requirement_id === "veg12")!.reason).toMatch(/earlier reply/);
  });
});
