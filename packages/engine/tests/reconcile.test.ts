// Inbound reconciliation (src/live/reconcile.ts): a business reply whose webhook was lost is
// recovered from the buyer identity's own mailbox, texts and calls, through the same ingest and
// trust checks, exactly once. Reproduces live job HG-2QAM (2026-10-18): Sunset Kitchen's $2,660
// counter answer hit "EMAXCONNSESSION max clients reached" in the webhook (503, never redelivered),
// the round closed treating Sunset as unanswered, and the human paid Mission Eats' $2,740.
// Real engine, FakeInkbox mail, fake text/call listings; no network.
import { InkboxAPIError, InkboxConnectionError } from "@inkbox/sdk";
import { describe, expect, it } from "vitest";
import {
  callOutcome, classifyFailure, disabledPayer, GOLDEN_REQUEST, HaggleEngine, InboundReconciler, inkboxEmail, inkboxSenderTrust, inkboxToInbound, InMemoryRepository, retryingReads, StubBrain, trustForSender,
  type InkboxMailApi, type ListedCall, type ListedText, type SmsPort,
} from "../src/index.ts";
import { BUYER, FakeInkbox } from "./helpers/fakeInkbox.ts";

const HARBOR = "harbor-table-sf@inkboxmail.test";
const MISSION = "mission-eats-sf@inkboxmail.test";
const SUNSET = "sunset-kitchen-sf@inkboxmail.test";
const OUTSIDER = "someone@gmail.test";
const HUMAN = "+14155550199";
const GRILL = "+14085550123";
const PHONE_BIZ = "+14155550104";

// Reads "$2,660 total all-in, ... $532 deposit" (and the tail of a text after Haggle's context line).
const textExtractor = {
  async extract(i: { bodyText: string }) {
    const t = (i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText).split("\n").filter((l) => !/^\s*(local|agent|haggle[^:]*)\s*:/i.test(l)).join("\n");
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:total|all[- ]in)/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    return {
      available: true, price_per_head_usd: null, headcount: 40, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true,
      tax_usd: null, tax_included: true, total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
      sources: [
        ...(total !== null ? [{ field: "total" as const, source: "text", excerpt: `$${total} total` }] : []),
        ...(deposit !== null ? [{ field: "deposit" as const, source: "text", excerpt: `$${deposit} deposit` }] : []),
      ],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    };
  },
};

function setup(opts: { identities?: () => Promise<string[]>; api?: FakeInkbox } = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const api = opts.api ?? new FakeInkbox();
  const repo = new InMemoryRepository();
  const texts: { to: string; text: string }[] = [];
  const sms: SmsPort = { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } };
  const placed: string[] = [];
  const inboxTexts: ListedText[] = [];
  const inboxCalls: ListedCall[] = [];
  const transcripts = new Map<string, string>();
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const log = (event: string, data: Record<string, unknown>) => { logs.push({ event, data }); };
  let reconciler: InboundReconciler | null = null;
  const engine = new HaggleEngine({
    repo, now: clock.now, email: inkboxEmail(api, BUYER), sms,
    phone: { async placeCall(r) { placed.push(r.toNumber); return { callId: `call_${placed.length}` }; } },
    extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"), log,
    reconcile: (jobId) => reconciler!.sweepJob(jobId),
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 5 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 2, notifyPhone: HUMAN,
    },
  });
  reconciler = new InboundReconciler({
    engine, repo, log, now: clock.now, callGraceMs: 0,
    sources: {
      mail: { api, buyerMailbox: BUYER, senderTrust: { policy: "outbound-verified" }, identityAddresses: opts.identities ?? (async () => [BUYER, HARBOR, MISSION, SUNSET]) },
      texts: { list: async () => inboxTexts },
      calls: { list: async () => inboxCalls, transcript: async (id) => transcripts.get(id) ?? "" },
    },
  });
  return { engine, repo, api, clock, texts, placed, inboxTexts, inboxCalls, transcripts, logs, reconciler };
}

type Env = ReturnType<typeof setup>;
const { budget_usd: _b, ...request } = GOLDEN_REQUEST;
let evt = 0;

/** The seller's reply lands in the buyer mailbox (Inkbox) but its webhook never arrives. */
async function lostReply(env: Env, jobId: string, from: string, text: string) {
  const b = (await env.repo.getBusinesses(jobId)).find((x) => x.email === from)!;
  return env.api.reply(from, b.rfq_message_id!, text);
}
/** ...and a reply whose webhook did arrive: the same path as POST /webhooks/inkbox. */
async function deliveredReply(env: Env, jobId: string, from: string, text: string) {
  const detail = await lostReply(env, jobId, from, text);
  const payload = { id: `evt_${++evt}`, event_type: "message.received", data: { agent_identities: [{ bucket: "from", address: from }] } };
  const trust = await inkboxSenderTrust(env.api, payload as never, detail, { policy: "outbound-verified" });
  const msg = inkboxToInbound(payload, detail);
  await env.engine.ingest(msg, trustForSender(trust, msg.from));
  await env.engine.advanceJob(jobId);
  return detail;
}
const board = (env: Env, jobId: string) => env.engine.getQuotes(jobId);

describe("inbound reconciliation: a reply whose webhook was lost is never lost", () => {
  it("the periodic sweep ingests mail missing from the store (same trust checks), exactly once", async () => {
    const env = setup();
    const deal = await env.engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: HARBOR }] });
    const detail = await lostReply(env, deal.job_id, HARBOR, "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    expect(await env.repo.findMessageByProviderId(detail.id)).toBeNull();

    const r = await env.reconciler.sweepAll();
    expect(r.recovered).toEqual([{ channel: "email", providerId: detail.id, jobId: deal.job_id, outcome: "stored" }]);
    expect(env.logs.some((l) => l.event === "reconciled_inbound" && l.data.provider_id === detail.id)).toBe(true);
    const stored = await env.repo.findMessageByProviderId(detail.id);
    expect(stored).toMatchObject({ sender_trusted: true, trust_reason: "trusted", kind: "reply" });
    await env.engine.advanceJob(deal.job_id);
    expect((await board(env, deal.job_id)).quotes).toMatchObject([{ business: "Harbor Table", total_usd: 1000 }]);

    // Never double-ingested: a second sweep (and a fresh reconciler, as after a restart) finds it stored.
    expect((await env.reconciler.sweepAll()).recovered).toEqual([]);
    const fresh = new InboundReconciler({ engine: env.engine, repo: env.repo, sources: { mail: { api: env.api, buyerMailbox: BUYER, senderTrust: { policy: "outbound-verified" }, identityAddresses: async () => [HARBOR] } } });
    expect((await fresh.sweepAll()).recovered).toEqual([]);
    expect((await env.repo.listMessages(deal.job_id)).filter((m) => m.direction === "in")).toHaveLength(1);
  });

  it("mail the webhook already ingested is skipped; a sender outside Inkbox is stored unverified (never a quote), as by the webhook", async () => {
    const env = setup();
    const deal = await env.engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: HARBOR }] });
    await deliveredReply(env, deal.job_id, HARBOR, "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
    // Someone outside Inkbox writes into the business's thread (no outbound copy, not an identity).
    const spoof = env.api.reply(OUTSIDER, b.rfq_message_id!, "$10 total all-in", [], { recordOutbound: false });
    const r = await env.reconciler.sweepAll();
    expect(r.recovered.map((x) => x.providerId)).toEqual([spoof.id]);
    expect(await env.repo.findMessageByProviderId(spoof.id)).toMatchObject({ sender_trusted: false });
    await env.engine.advanceJob(deal.job_id);
    expect((await board(env, deal.job_id)).quotes.map((q) => q.total_usd)).toEqual([1000]);
  });

  it("when trust can't be decided right now (identity directory or sender mailbox unavailable) nothing is stored; the next sweep recovers it", async () => {
    let down = true;
    const env = setup({ identities: async () => { if (down) throw new InkboxAPIError(503, "unavailable"); return [HARBOR]; } });
    const deal = await env.engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: HARBOR }] });
    const detail = await lostReply(env, deal.job_id, HARBOR, "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    expect((await env.reconciler.sweepAll()).recovered).toEqual([]);
    expect(env.logs.some((l) => l.event === "reconcile_skipped")).toBe(true);
    expect(await env.repo.findMessageByProviderId(detail.id)).toBeNull(); // never stored as untrusted

    // Directory back, but the seller's mailbox (outbound check) is briefly unreachable: still nothing stored.
    down = false;
    const real = env.api.list.bind(env.api);
    let flaky = true;
    env.api.list = (async function* (mailbox: string, o?: { direction?: string }) {
      if (mailbox === HARBOR && flaky) throw new InkboxConnectionError("socket hang up");
      yield* real(mailbox, o);
    }) as InkboxMailApi["list"] as never;
    expect((await env.reconciler.sweepAll()).recovered).toEqual([]);
    expect(await env.repo.findMessageByProviderId(detail.id)).toBeNull();
    flaky = false;
    expect((await env.reconciler.sweepAll()).recovered.map((x) => x.providerId)).toEqual([detail.id]);
    expect(await env.repo.findMessageByProviderId(detail.id)).toMatchObject({ sender_trusted: true });
  });

  it("texts: a business's lost text reply is recovered once; outbound texts and texts already stored are skipped", async () => {
    const env = setup();
    const deal = await env.engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Golden Grill", phone: GRILL, channel: "imessage" }, { name: "Harbor Table", email: HARBOR }] });
    await env.engine.advanceJob(deal.job_id);
    // Haggle texted Golden Grill its request; Golden Grill's answer never arrived by webhook.
    expect(env.texts.some((x) => x.to === GRILL)).toBe(true);
    env.inboxTexts.push(
      { id: "tx_out", direction: "outbound", remotePhoneNumber: GRILL, text: "Hi, I'm an AI assistant", createdAt: new Date() },
      { id: "tx_1", direction: "inbound", remotePhoneNumber: GRILL, text: "$1,100 total all-in, 12 vegetarian, delivered, $200 deposit", createdAt: new Date() },
    );
    const r = await env.reconciler.sweepAll();
    expect(r.recovered).toEqual([{ channel: "text", providerId: "tx_1", jobId: deal.job_id, outcome: "stored" }]);
    await env.engine.advanceJob(deal.job_id);
    expect((await board(env, deal.job_id)).quotes).toMatchObject([{ business: "Golden Grill", total_usd: 1100 }]);
    expect((await env.reconciler.sweepAll()).recovered).toEqual([]);
    const fresh = new InboundReconciler({ engine: env.engine, repo: env.repo, sources: { texts: { list: async () => env.inboxTexts } } });
    expect((await fresh.sweepAll()).recovered).toEqual([]); // stored as sms-in:tx_1
  });

  it("calls: a placed call with no call.ended is looked up once it is over (full transcript); one still ringing is left alone", async () => {
    const env = setup();
    const deal = await env.engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Mission Eats", phone: PHONE_BIZ }] });
    await env.engine.advanceJob(deal.job_id);
    expect(env.placed).toEqual([PHONE_BIZ]);
    env.clock.advance(60_000);
    env.inboxCalls.push({ id: "call_1", direction: "outbound", status: "answered", hangupReason: null, remotePhoneNumber: PHONE_BIZ, endedAt: null, createdAt: new Date() });
    expect((await env.reconciler.sweepAll()).recovered).toEqual([]); // still on the line
    env.inboxCalls[0] = { ...env.inboxCalls[0]!, status: "completed", hangupReason: "remote", endedAt: new Date() };
    env.transcripts.set("call_1", "haggle (AI assistant): Hi, I'm an AI assistant calling for a quote.\nremote: $1,070 total all-in, 12 vegetarian, delivered, $100 deposit.");
    const r = await env.reconciler.sweepAll();
    expect(r.recovered).toEqual([{ channel: "call", providerId: "call_1", jobId: deal.job_id, outcome: "stored" }]);
    await env.engine.advanceJob(deal.job_id);
    expect((await board(env, deal.job_id)).quotes).toMatchObject([{ business: "Mission Eats", channel: "phone", total_usd: 1070 }]);
    expect((await env.reconciler.sweepAll()).recovered).toEqual([]);
    expect(callOutcome({ status: "completed", hangupReason: "voicemail" })).toBe("no_answer");
    expect(callOutcome({ status: "completed", hangupReason: "rejected" })).toBe("declined");
    expect(callOutcome({ status: "ringing", hangupReason: null })).toBeNull();
  });

  it("HG-2QAM: before the negotiation round closes, the lost $2,660 counter answer is recovered, so 'all quotes are in' recommends it", async () => {
    const env = setup();
    const deal = await env.engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: HARBOR }, { name: "Mission Eats", email: MISSION }, { name: "Sunset Kitchen", email: SUNSET }] });
    await env.engine.advanceJob(deal.job_id);
    await deliveredReply(env, deal.job_id, HARBOR, "$2,750 total all-in, 12 vegetarian, delivered, $550 deposit.");
    await deliveredReply(env, deal.job_id, MISSION, "$2,900 total all-in, 12 vegetarian, delivered, $580 deposit.");
    await deliveredReply(env, deal.job_id, SUNSET, "$2,950 total all-in, 12 vegetarian, delivered, $590 deposit.");
    expect((await board(env, deal.job_id)).state).toBe("negotiating"); // Mission and Sunset countered with Harbor's $2,750
    await deliveredReply(env, deal.job_id, MISSION, "We can do $2,740 total all-in, $548 deposit.");
    const lost = await lostReply(env, deal.job_id, SUNSET, "Fair enough. We can do $2,660 total all-in, $532 deposit.");
    await env.engine.advanceJob(deal.job_id);
    expect((await board(env, deal.job_id)).ready).toBe(false); // still waiting for Sunset (its answer is only in the mailbox)

    env.clock.advance(5 * 60_000 + 1_000); // the round's deadline
    await env.engine.advanceJob(deal.job_id);
    const b = await board(env, deal.job_id);
    expect(env.logs.some((l) => l.event === "reconciled_inbound" && l.data.provider_id === lost.id)).toBe(true);
    expect(b.ready).toBe(true);
    expect(b.quotes.find((q) => q.business === "Sunset Kitchen")).toMatchObject({ total_usd: 2660, round: 2 });
    const ready = env.texts.filter((x) => x.to === HUMAN && /All quotes are in/.test(x.text));
    expect(ready).toHaveLength(1);
    expect(ready[0]!.text).toMatch(/Recommended: Sunset Kitchen \$2,660/);
    expect(ready[0]!.text).not.toMatch(/Mission Eats/);
  });

  it("a better quote after 'all quotes are in': Haggle's suggestion is replaced and the human texted once; the old code can't pay", async () => {
    const env = setup();
    const deal = await env.engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: HARBOR }, { name: "Mission Eats", email: MISSION }, { name: "Sunset Kitchen", email: SUNSET }] });
    await env.engine.advanceJob(deal.job_id);
    await deliveredReply(env, deal.job_id, HARBOR, "$2,750 total all-in, 12 vegetarian, delivered, $550 deposit.");
    await deliveredReply(env, deal.job_id, MISSION, "$2,900 total all-in, 12 vegetarian, delivered, $580 deposit.");
    await deliveredReply(env, deal.job_id, SUNSET, "$2,950 total all-in, 12 vegetarian, delivered, $590 deposit.");
    await deliveredReply(env, deal.job_id, MISSION, "We can do $2,740 total all-in, $548 deposit.");
    env.clock.advance(5 * 60_000 + 1_000); // Sunset hasn't answered (yet): quotes are final without it
    await env.engine.advanceJob(deal.job_id);
    const first = env.texts.filter((x) => x.to === HUMAN).at(-1)!;
    expect(first.text).toMatch(/All quotes are in .*Recommended: Mission Eats \$2,740/);
    const old = (await env.repo.getLatestApproval(deal.job_id))!;
    expect(old).toMatchObject({ status: "pending", quote_total_cents: 274_000 });

    // Sunset's answer arrives late (a webhook, or the sweep): $2,660, now the best.
    await deliveredReply(env, deal.job_id, SUNSET, "Fair enough. We can do $2,660 total all-in, $532 deposit.");
    expect((await env.repo.getApproval(old.id))!.status).toBe("expired");
    const next = (await env.repo.getLatestApproval(deal.job_id))!;
    expect(next).toMatchObject({ status: "pending", quote_total_cents: 266_000, payment_cents: 53_200 });
    const update = env.texts.filter((x) => x.to === HUMAN).at(-1)!;
    expect(update.text).toBe(`Haggle update: Sunset Kitchen lowered to $2,660 (now the best). Reply YES ${next.code} to approve the $532 deposit to Sunset Kitchen (your assistant then pays it) instead; the earlier code no longer works. (HG-${(await env.repo.getJob(deal.job_id))!.short_code})`);
    const b = await board(env, deal.job_id);
    expect(b.quotes.find((q) => q.business === "Sunset Kitchen")).toMatchObject({ total_usd: 2660 });

    // Once only: further advances don't text again.
    const sent = env.texts.length;
    await env.engine.advanceJob(deal.job_id);
    await env.engine.advanceJob(deal.job_id);
    expect(env.texts.length).toBe(sent);

    // A YES for the superseded code approves (and charges) nothing.
    await env.engine.ingestText({ messageId: "tx_yes_old", from: HUMAN, text: `YES ${old.code}`, inbound: true });
    expect((await env.repo.getApproval(old.id))!.status).toBe("expired");
    expect((await env.repo.getApproval(next.id))!.status).toBe("pending");
    expect(await env.repo.getPaymentForJob(deal.job_id)).toBeNull();
  });
});

describe("classifyFailure: which webhook failures Inkbox should retry", () => {
  it("database pool/connection errors, Inkbox 5xx/unreachable, Anthropic overload and timeouts are transient; 4xx answers are permanent", () => {
    expect(classifyFailure(Object.assign(new Error("(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15"), { code: "XX000" }))).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("write CONNECT_TIMEOUT db:5432"), { code: "CONNECT_TIMEOUT" }))).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("sorry, too many clients already"), { code: "53300" }))).toBe("transient");
    expect(classifyFailure(new InkboxAPIError(502, "bad gateway"))).toBe("transient");
    expect(classifyFailure(new InkboxConnectionError("fetch failed"))).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("Overloaded"), { name: "OverloadedError", status: 529 }))).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("rate limited"), { name: "RateLimitError", status: 429 }))).toBe("transient");
    expect(classifyFailure(new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" }) }))).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toBe("transient");
    expect(classifyFailure(new InkboxAPIError(404, "not found"))).toBe("permanent");
    expect(classifyFailure(new InkboxAPIError(403, "forbidden"))).toBe("permanent");
    expect(classifyFailure(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe("unknown");
  });
});

describe("Postgres store: one retry for a read that hit a full pool", () => {
  it("retries a SELECT once after EMAXCONNSESSION; never retries a write or haggle_append_event; helpers pass through", async () => {
    const calls: string[] = [];
    let failNext = 0;
    const raw = Object.assign(
      (strings: TemplateStringsArray | Record<string, unknown>, ..._values: unknown[]) => {
        if (!Array.isArray(strings)) return { helper: strings };
        calls.push((strings as TemplateStringsArray).join("?"));
        if (failNext > 0) { failNext--; return Promise.reject(Object.assign(new Error("(EMAXCONNSESSION) max clients reached in session mode"), { code: "XX000" })); }
        return Promise.resolve([{ ok: 1 }]);
      },
      { json: (v: unknown) => ({ json: v }), marker: "raw" },
    );
    const sql = retryingReads(raw as never, 1) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    failNext = 1;
    expect(await sql`select * from jobs where id = ${"j1"}`).toEqual([{ ok: 1 }]);
    expect(calls).toHaveLength(2);
    failNext = 2; // a second failure is not retried again
    await expect(sql`select * from jobs`).rejects.toThrow(/EMAXCONNSESSION/);
    calls.length = 0;
    failNext = 1;
    await expect(sql`update jobs set x = 1`).rejects.toThrow(/EMAXCONNSESSION/);
    failNext = 1;
    await expect(sql`select haggle_append_event(${"j"}, ${"t"}, ${"{}"}) as seq`).rejects.toThrow(/EMAXCONNSESSION/);
    expect(calls).toHaveLength(2); // one attempt each
    expect((sql as unknown as { json: (v: unknown) => unknown }).json(1)).toEqual({ json: 1 });
    expect((sql as unknown as (o: Record<string, unknown>) => unknown)({ a: 1 })).toEqual({ helper: { a: 1 } });
  });
});
