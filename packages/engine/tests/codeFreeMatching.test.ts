// No reference codes in anything Haggle sends a business (2026-10-30): how replies are still tied to
// the right deal. Pure units for matching rule 5, external-sender verification and the in-words
// request naming, plus engine flows for a new email and an inbound call. No network.
import { describe, expect, it } from "vitest";
import { matchInbound, type BusinessCandidate } from "../src/inbound/matching.ts";
import { verifyExternalReply } from "../src/inbound/senderAuth.ts";
import { bindingTermsTrustFor, CONTINUITY_ONLY_REASONS } from "../src/inbound/trustStrength.ts";
import { jobByDescription, requestLabel } from "../src/workflow/textRouting.ts";
import { buildVoiceInstructions } from "../src/workflow/callPolicy.ts";
import { quoteRequestSubject } from "../src/outbound/rfq.ts";
import type { JobRow } from "../src/store/types.ts";
import { BUYER, dealWith, external, liveEngine } from "./helpers/liveEngine.ts";

const V = "orders@valley.example";
const cand = (jobId: string, over: Partial<BusinessCandidate> = {}): BusinessCandidate => ({ businessId: "biz-v", jobId, shortCode: jobId.toUpperCase().slice(-4), email: V, threadId: null, outboundMessageId: `<rfq-${jobId}@ses>`, ...over });
const base = { to: [BUYER], threadId: null, inReplyTo: [] as string[], references: [] as string[], subject: "our quote", from: V };
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };

describe("subjects", () => {
  it("are plain: what, how many, when; no code", () => {
    expect(quoteRequestSubject({ what: "lunch", quantity: 40, date: "2026-11-03" })).toBe("Quote request: lunch, 40 people, Tuesday November 3");
    expect(quoteRequestSubject({ what: "fix a leak" })).toBe("Quote request: fix a leak");
  });
});

describe("matchInbound rule 5: a new email matched by its sender", () => {
  it("one open deal on the mailbox -> that deal (sender_only); two -> ambiguous_sender; none -> no_signal", () => {
    expect(matchInbound(base, [], [], undefined, [cand("job-a")])).toEqual({ kind: "business", businessId: "biz-v", jobId: "job-a", via: "sender_only" });
    expect(matchInbound(base, [], [], undefined, [cand("job-a"), cand("job-b")])).toEqual({ kind: "unmatched", reason: "ambiguous_sender" });
    expect(matchInbound(base, [], [], undefined, [])).toEqual({ kind: "unmatched", reason: "no_signal" });
    // Another address never matches by sender.
    expect(matchInbound({ ...base, from: "someone@else.example" }, [], [], undefined, [cand("job-a")])).toEqual({ kind: "unmatched", reason: "no_signal" });
  });

  it("thread signals win over the sender rule; a reply to any of Haggle's emails (not just the RFQ) counts", () => {
    const a = cand("job-a", { outboundMessageIds: ["<counter-a@ses>"] });
    const b = cand("job-b", { shortCode: "JOBB" });
    expect(matchInbound({ ...base, inReplyTo: ["<counter-a@ses>"] }, [a, b], [], undefined, [a, b])).toMatchObject({ jobId: "job-a", via: "message_id" });
    expect(matchInbound({ ...base, subject: "Re: [HG-JOBB] Quote request" }, [a, b], [], undefined, [a, b])).toMatchObject({ jobId: "job-b", via: "subject_tag" }); // an old thread's tag
  });
});

describe("verifyExternalReply without tokens", () => {
  const ours = ["<rfq@ses>"];
  const v = (over: Partial<Parameters<typeof verifyExternalReply>[0]> = {}) => verifyExternalReply({ from: V, pinned: V, inReplyTo: ["<rfq@ses>"], references: [], ourMessageIds: ours, evidence: noEvidence, ...over });
  it("our Message-ID from the pinned address: thread reply; aligned DMARC: identity; neither: only as a sender-only match", () => {
    expect(v()).toEqual({ ok: true, reason: "external-thread-reply" });
    expect(v({ inReplyTo: [], evidence: { ...noEvidence, dmarc: "pass", dmarcFromDomain: "valley.example" } })).toEqual({ ok: true, reason: "external-dmarc-aligned" });
    expect(v({ inReplyTo: [] })).toEqual({ ok: false, reason: "identity_unverified", detail: "not_in_our_thread" });
    expect(v({ inReplyTo: [], senderOnly: true })).toEqual({ ok: true, reason: "external-sender-only" });
    expect(v({ evidence: { ...noEvidence, dmarc: "fail" } })).toMatchObject({ ok: false, detail: "auth_failed" });
    expect(v({ from: "x@evil.example" })).toMatchObject({ ok: false, detail: "from_mismatch" });
  });
  it("thread and sender-only replies are continuity only: never a booking, a payee or a settled payment on their own", () => {
    for (const r of ["external-thread-reply", "external-sender-only"]) {
      expect(CONTINUITY_ONLY_REASONS.has(r)).toBe(true);
      expect(bindingTermsTrustFor(r)).toMatchObject({ mayConfirmBooking: false, mayNamePayee: false, mayVerifySettlement: false, requiresHumanAck: true });
    }
  });
});

describe("naming a request in words", () => {
  const job = (id: string, what: string, quantity?: number, date?: string) => ({ id, workspace_id: `ws_${id}`, request: { what, area: "SF", requirements: [], ...(quantity !== undefined ? { quantity } : {}), ...(date ? { date } : {}) } }) as unknown as Pick<JobRow, "id" | "workspace_id" | "request">;
  const lunch = job("j1", "lunch catering", 40, "2026-11-03");
  const dinner = job("j2", "dinner buffet", 25, "2026-11-05");
  it("labels a request by what, how many and when", () => {
    expect(requestLabel(lunch.request)).toBe("lunch catering for 40 on Nov 3");
  });
  it("picks the one request a text describes, never a tie", () => {
    expect(jobByDescription("it's for the dinner buffet: $900 total", [lunch, dinner])?.id).toBe("j2");
    expect(jobByDescription("the one for 40 people", [lunch, dinner])?.id).toBe("j1");
    expect(jobByDescription("re your Nov 5 request", [lunch, dinner])?.id).toBe("j2");
    expect(jobByDescription("$900 total, delivered", [lunch, dinner])).toBeNull();
    expect(jobByDescription("lunch or dinner?", [lunch, dinner])).toBeNull();
    expect(jobByDescription("dinner", [dinner])).toBeNull(); // nothing to choose between
  });
  it("the inbound voice instructions list requests in words and ask which one, with no codes", () => {
    const text = buildVoiceInstructions("Acme", [{ shortCode: "AB12", request: lunch.request, businesses: [{ name: "Valley", phone: "+14155550100" }] }, { shortCode: "CD34", request: dinner.request, businesses: [{ name: "Valley", phone: "+14155550100" }] }]);
    expect(text).not.toMatch(/HG-|AB12|CD34/);
    expect(text).toMatch(/^- lunch catering, 40 people/m);
    expect(text).toMatch(/ask which one by describing each/);
  });
});

describe("engine: a new email from a vendor (not a reply)", () => {
  const fresh = (env: ReturnType<typeof liveEngine>, k: string, to = [BUYER]) => env.engine.ingest({ providerEventId: `ev_${k}`, eventType: "message.received", providerEmailId: `in_${k}`, threadId: null, messageId: `<${k}@valley.example>`, inReplyTo: [], references: [], from: V, to, subject: "our quote", bodyText: "We can do it: $1,150 total, delivered.", attachments: [], attachmentsDownloadUrl: null }, external);

  it("one open deal: read as a quote at the lowest trust, never a booking confirmation; a closed deal doesn't count", async () => {
    const env = liveEngine();
    const d = await dealWith(env, [{ name: "Valley Catering", email: V }]);
    expect((await fresh(env, "f1")).outcome).toBe("stored");
    const m = (await env.repo.listMessages(d.jobId)).find((x) => x.direction === "in")!;
    expect(m).toMatchObject({ kind: "reply", sender_trusted: true, trust_reason: "external-sender-only", matched_via: "sender_only" });
    const ev = (await env.repo.listEvents(d.jobId)).find((e) => e.type === "reply" && /not a reply/.test(String(e.data.summary)));
    expect(ev).toBeTruthy();
    await env.engine.advanceJob(d.jobId);
    expect((await env.engine.getQuotes(d.jobId)).quotes.map((q) => q.total_usd)).toEqual([1150]);
    await env.engine.cancel(d.jobId);
    expect((await fresh(env, "f2")).outcome).toBe("quarantined:no_signal");
  });

  it("only deals on the mailbox that received it count", async () => {
    const env = liveEngine();
    await dealWith(env, [{ name: "Valley Catering", email: V }]);
    expect((await fresh(env, "f3", ["someone-else@inkboxmail.test"])).outcome).toBe("quarantined:no_signal");
  });

  it("a STOP in a new email stops this deal only; it never suppresses the address everywhere", async () => {
    const env = liveEngine();
    const d = await dealWith(env, [{ name: "Valley Catering", email: V }]);
    const r = await env.engine.ingest({ providerEventId: "ev_s", eventType: "message.received", providerEmailId: "in_s", threadId: null, messageId: "<s@valley.example>", inReplyTo: [], references: [], from: V, to: [BUYER], subject: "stop", bodyText: "STOP", attachments: [], attachmentsDownloadUrl: null }, external);
    expect(r.outcome).toBe("opted_out");
    expect(await env.repo.findSuppressions([V])).toEqual([]);
    expect((await env.repo.getBusinesses(d.jobId))[0]!.status).toBe("declined");
  });
});
