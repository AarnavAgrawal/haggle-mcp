// Regression tests for review findings in pure modules and adapters: channel learning, the heuristic
// parser, money coercion, value ranking, Inkbox call retries, website fetching and the brain seam.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { InkboxAPIError, InkboxConnectionError } from "@inkbox/sdk";
import { createBrain, loadDirectory, MemoryStore } from "@haggle/brain";
import { describe, expect, it, vi } from "vitest";
import { BrainAdapter } from "../src/brain/adapter.ts";
import type { ParsedReply, ReplyMeta } from "../src/contract.ts";
import { inkboxPhone } from "../src/live/inkbox.ts";
import { heuristicExtract } from "../src/parsing/heuristic.ts";
import type { ExtractionRequest } from "../src/parsing/parseReply.ts";
import { coerceField } from "../src/parsing/validate.ts";
import { scoreQuotes, type ValueInput } from "../src/ranking/value.ts";
import { guardedLookup, pinnedFetch, publicUrl, robotsDisallows } from "../src/reputation/website.ts";
import { chooseChannel, learnContact } from "../src/routing/channelStats.ts";
import type { MessageRow } from "../src/store/types.ts";
import { ChannelSendError } from "../src/workflow/ports.ts";

const noSleep = async () => {};

describe("channel learning: an unanswered call is not a reply", () => {
  let n = 0;
  const row = (o: Partial<MessageRow> & Pick<MessageRow, "job_id" | "direction" | "kind" | "channel" | "created_at">): MessageRow => ({
    id: `m${++n}`, business_id: "b", approval_id: null, provider_email_id: null, idempotency_key: null, rfc_message_id: null, thread_id: null, from_address: null, to_address: null,
    subject: null, body_text: null, attachments: [], attachments_download_url: null, sender_trusted: null, trust_reason: null, matched_via: null, parse_status: "none",
    quarantine_reason: null, round: null, simulated: false, ...o,
  });
  const callJob = (job: string, outcome: "none" | "pending") => [
    row({ job_id: job, direction: "out", kind: "call", channel: "phone", provider_email_id: `call_${job}`, created_at: `2026-10-1${job.slice(-1)}T10:00:00Z` }),
    row({ job_id: job, direction: "in", kind: "reply", channel: "phone", provider_email_id: `call-ended:call_${job}`, sender_trusted: true, parse_status: outcome, created_at: `2026-10-1${job.slice(-1)}T10:02:00Z` }),
  ];
  const emailJob = (job: string) => [row({ job_id: job, direction: "out", kind: "rfq", channel: "email", created_at: `2026-10-1${job.slice(-1)}T09:00:00Z` })];

  it("no_answer/failed call.ended rows don't count; a completed call (parsed) does", () => {
    const silent = learnContact([...callJob("j1", "none"), ...callJob("j2", "none"), ...emailJob("j1"), ...emailJob("j2")], []);
    expect(silent.channels.phone).toMatchObject({ contacted_jobs: 2, replied_jobs: 0, response_rate: 0 });
    expect(chooseChannel(["email", "phone"], "email", silent)).toEqual({ channel: "email", reason: null });
    const answered = learnContact([...callJob("j1", "pending"), ...callJob("j2", "pending")], []);
    expect(answered.channels.phone).toMatchObject({ contacted_jobs: 2, replied_jobs: 2, response_rate: 1, median_reply_minutes: 2 });
  });
});

describe("heuristic parser", () => {
  const request: ExtractionRequest = { what: "lunch catering", headcount: 40, location: "SF", dietary: [], requirements: [] };
  const read = (bodyText: string) => heuristicExtract({ request, bodyText });

  it("reads a k suffix on totals (×1000), like findDollarAmounts", () => {
    expect(read("Total is $5k, deposit $500")).toMatchObject({ total_usd: 5000, deposit_usd: 500 });
    expect(read("We can do $4.5k total")).toMatchObject({ total_usd: 4500 });
    expect(read("Total: $1,080")).toMatchObject({ total_usd: 1080 });
    expect(coerceField({ key: "price", label: "Price", type: "money", required: true }, "$5k")).toBe(500_000);
    expect(coerceField({ key: "price", label: "Price", type: "money", required: true }, "$4.5k")).toBe(450_000);
    expect(coerceField({ key: "price", label: "Price", type: "money", required: true }, "$1,080.50")).toBe(108_050);
  });

  it("'delivered for $75' is a delivery fee, not delivery included", () => {
    const x = read("Can be delivered for $75. Total: $900");
    expect(x.delivery_included).not.toBe(true);
    expect(x).toMatchObject({ total_usd: 900, delivery_fee_usd: 75 });
    expect(read("Everything is delivered hot. Total: $900").delivery_included).toBe(true);
    expect(read("Total: $1,080 delivered.").delivery_included).toBe(true); // a delivered price
  });

  it("'can't do it cheaper' with a price is a quote, not a decline", () => {
    expect(read("We can't do it cheaper than this. Total: $900")).toMatchObject({ available: true, total_usd: 900 });
    expect(read("Sorry, we're fully booked that day.").available).toBe(false);
  });
});

describe("value ranking is a total order", () => {
  const q = (id: string, totalCents: number, mc: number): ValueInput => ({
    quoteId: id, businessId: id, business: id, totalCents, depositCents: null, deliveryIncluded: true, deliveryStated: true, taxStated: true, dietaryStated: true, itemsListed: true, confidence: 0.9,
    reputationStatus: "found", reputation: { source: "Google Places", rating: 5, review_count: 100_000, matched_name: id, match_confidence: mc, fetched_at: "2026-10-18T00:00:00Z" }, reliability: null,
  });

  it("the same quotes give the same winner in every input order", () => {
    // Scores ~0.004 apart: A~B and B~C within the old tolerance, A vs C outside it (a cycle).
    const qs = [q("A", 100_000, 0.5), q("B", 100_100, 0.545), q("C", 100_200, 0.59)];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const results = perms.map((p) => scoreQuotes(p.map((i) => qs[i]!)));
    expect(new Set(results.map((r) => r.recommendedQuoteId)).size).toBe(1);
    expect(new Set(results.map((r) => r.ranked.map((x) => x.quoteId).join(","))).size).toBe(1);
  });
});

describe("Inkbox placeCall: retried only when nothing was placed", () => {
  const phone = (fail: (n: number) => Error | null) => {
    let attempts = 0;
    const port = inkboxPhone({ placeCall: async () => { const e = fail(++attempts); if (e) throw e; return { id: "call_1" }; } }, "dedicated_number", noSleep);
    return { port, attempts: () => attempts };
  };
  const req = { jobId: "j", businessId: "b", toNumber: "+14155550104", reason: "I'm an AI assistant requesting a quote", idempotencyKey: "k" };

  it("503 hosted_agent_at_capacity (string or object detail) is retried", async () => {
    for (const detail of ["hosted_agent_at_capacity", { error: "hosted_agent_at_capacity" }, { detail: { code: "hosted_agent_at_capacity" } }]) {
      const p = phone((n) => (n === 1 ? new InkboxAPIError(503, detail as never) : null));
      expect(await p.port.placeCall(req)).toEqual({ callId: "call_1" });
      expect(p.attempts()).toBe(2);
    }
  });

  it("an ambiguous 5xx or connection error is not retried (the call may be ringing) and is not retryable later", async () => {
    for (const err of [new InkboxAPIError(500, "boom"), new InkboxAPIError(502, "bad gateway"), new InkboxConnectionError("socket hang up")]) {
      const p = phone(() => err);
      const e = await p.port.placeCall(req).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ChannelSendError);
      expect((e as ChannelSendError).retryable).toBe(false);
      expect(p.attempts()).toBe(1);
    }
  });

  it("an exhausted capacity error stays retryable at the engine level", async () => {
    const p = phone(() => new InkboxAPIError(503, { error: "hosted_agent_at_capacity" }));
    const e = await p.port.placeCall(req).catch((x: unknown) => x);
    expect(e).toMatchObject({ retryable: true });
    expect(p.attempts()).toBe(3);
  });
});

describe("website fetching: SSRF and robots.txt", () => {
  it("blocks more private and reserved ranges, IPv6 included", async () => {
    for (const ip of ["198.18.0.1", "198.19.255.255", "224.0.0.1", "239.1.2.3", "240.0.0.1", "255.255.255.255", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::", "::1", "ff02::1"]) {
      expect(await publicUrl("https://shop.example.com/", async () => [ip]), ip).toBeNull();
    }
    expect(await publicUrl("https://shop.example.com/", async () => ["93.184.216.34", "2606:2800:220:1::1"])).not.toBeNull();
  });

  it("the connect-time lookup refuses private addresses and passes public ones", async () => {
    const call = (addrs: string[], all: boolean) => new Promise<{ err: unknown; out: unknown }>((done) => {
      guardedLookup(async () => addrs)("shop.example.com", { all } as never, ((err: unknown, a: unknown, f?: unknown) => done({ err, out: all ? a : [a, f] })) as never);
    });
    expect((await call(["127.0.0.1"], false)).err).toBeTruthy();
    expect((await call(["93.184.216.34", "10.0.0.1"], true)).err).toBeTruthy();
    expect(await call(["93.184.216.34"], false)).toEqual({ err: null, out: ["93.184.216.34", 4] });
    expect(await call(["93.184.216.34"], true)).toEqual({ err: null, out: [{ address: "93.184.216.34", family: 4 }] });
  });

  it("DNS rebinding: a host that resolves public, then private at connect time, is never connected to", async () => {
    let hits = 0;
    const server = createServer((_q, r) => { hits++; r.end("secret"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await pinnedFetch(async () => ["127.0.0.1"])(`http://rebind.example.com:${port}/`, { method: "GET", headers: {}, redirect: "manual", signal: AbortSignal.timeout(2000) }).catch((e: unknown) => e);
      expect(res).toBeInstanceOf(Error);
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });

  it("consecutive User-agent lines form one group", () => {
    expect(robotsDisallows("User-agent: *\nUser-agent: Googlebot\nDisallow: /", "/")).toBe(true);
    expect(robotsDisallows("User-agent: Googlebot\nUser-agent: *\nDisallow: /private", "/private/x")).toBe(true);
    expect(robotsDisallows("User-agent: Googlebot\nUser-agent: Bingbot\nDisallow: /\n\nUser-agent: *\nAllow: /", "/")).toBe(false);
    expect(robotsDisallows("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /", "/")).toBe(false);
  });
});

describe("BrainAdapter: negotiation and category reach the brain", () => {
  const directory = loadDirectory(undefined);
  const harbor = directory.find((d) => d.name === "Harbor Table")!;
  const setup = () => {
    const core = createBrain({ store: new MemoryStore() });
    return { core, brain: new BrainAdapter({ brain: core, directory }) };
  };
  const meta = (over: Partial<ReplyMeta> = {}): ReplyMeta => ({
    job_id: "job_1", business_id: "biz_engine_harbor", business_email: harbor.email!, message_id: "msg_2", thread_id: "thr_1",
    received_at: "2026-10-17T19:30:00Z", rfq_sent_at: "2026-10-17T19:00:00Z", channel: "text", sender_trusted: true, sender_trust_reason: "trusted", simulated: true,
    request: { what: "lunch catering", quantity: 40, date: "2026-10-22", area: "San Francisco, CA", requirements: [] }, ...over,
  });
  const counter: ParsedReply = {
    injection_detected: false,
    items: [{ kind: "quote", quote: { kind: "quote", job_id: "job_1", business_id: "biz_engine_harbor", business: "Harbor Table", total_usd: 1035, items: [], meets_requirements: true, requirement_results: [], missing: [], flags: [], negotiated_from: 1150, round: 2, confidence: 0.9, source: "email body", evidence: {}, message_id: "msg_2" } }],
  };

  it("learnFromReply passes negotiated_from (and cited_competing_quote when known), so live data teaches discounts", async () => {
    const { core, brain } = setup();
    const spy = vi.spyOn(core, "learnFromReply");
    await brain.learnFromReply("biz_engine_harbor", counter, { ...meta(), cited_competing_quote: true });
    expect(spy.mock.calls[0]![2]).toMatchObject({ round: 2, negotiated_from: 1150, cited_competing_quote: true });
    expect(await core.getProfile(harbor.id)).toMatchObject({ discount_pct: 0.1, discount_needs_competing_quote: true });
    spy.mockClear();
    await brain.learnFromReply("biz_engine_harbor", { ...counter, items: [{ ...counter.items[0]!, quote: { ...(counter.items[0] as { quote: object }).quote, negotiated_from: undefined, round: 1 } } as never] }, meta());
    expect(spy.mock.calls[0]![2]).not.toHaveProperty("negotiated_from");
    expect(spy.mock.calls[0]![2]).not.toHaveProperty("cited_competing_quote");
  });

  it("checkPrice passes the request's category, so a plumbing job isn't judged as catering", async () => {
    const { core, brain } = setup();
    const spy = vi.spyOn(core, "checkPrice");
    const v = await brain.checkPrice({ total_usd: 400, request: { what: "fix a leaking pipe (plumbing)", area: "San Francisco, CA" } });
    expect(spy.mock.calls[0]![0]).toMatchObject({ category: "fix a leaking pipe (plumbing)" });
    expect(v.basis).not.toMatch(/catering/i);
  });
});
