// Crash recovery and duplicate-send safety (production audit 2026-10-21). A process can die at any
// point: between creating a job and starting it, or half way through the first round of contacts.
// The next advance must finish the job's work without contacting anyone twice. A provider failure
// after a call may already be ringing is never retried (no second ring). Real engine, fake ports.
import { describe, expect, it } from "vitest";
import { InkboxAPIError } from "@inkbox/sdk";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain } from "../src/index.ts";
import { inkboxPhone } from "../src/live/inkbox.ts";
import { ChannelSendError, type PhonePort } from "../src/workflow/ports.ts";

const { budget_usd, ...request } = GOLDEN_REQUEST;
const BUSINESSES = [
  { name: "Harbor Table", email: "harbor@inkboxmail.test" },
  { name: "Sunset Kitchen", email: "sunset@inkboxmail.test" },
  { name: "Mission Eats", phone: "+14155550104" },
];

function setup(phone?: PhonePort) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string }[] = [];
  const calls: { toNumber: string }[] = [];
  const repo = new InMemoryRepository({ now: clock.now });
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: { extract: async () => { throw new Error("not used"); } } as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    phone: phone ?? { async placeCall(r) { calls.push(r); return { callId: `call_${calls.length}` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 2 },
  });
  return { engine, repo, clock, emails, calls };
}

describe("stuck-job recovery", () => {
  it("a job left in `created` (crash before it started) is started by a later advance", async () => {
    const { engine, repo, clock, emails } = setup();
    const deal = await engine.deal({ request, budget_usd, businesses: BUSINESSES.slice(0, 2) });
    const sent = emails.length;
    // The crash: the job row exists, but `created -> contacting` never committed; nothing was sent.
    const j = (await repo.getJob(deal.job_id))!;
    await repo.casJob(j.id, j.version, { state: "created" });
    for (const b of await repo.getBusinesses(j.id)) await repo.updateBusiness(j.id, b.business_id, { status: "pending", contacted_at: null });
    clock.advance(3 * 60_000);
    await engine.advanceJob(j.id);
    expect((await repo.getJob(j.id))!.state).toBe("collecting");
    expect(emails.length).toBe(sent); // the RFQs already sent (idempotency keys) are not re-sent
    expect((await repo.getBusinesses(j.id)).every((b) => b.status === "contacted")).toBe(true);
  });

  it("a job left in `contacting` with businesses never reached (crash mid-send) contacts them once and moves on", async () => {
    const { engine, repo, clock, emails } = setup();
    const deal = await engine.deal({ request, budget_usd, businesses: BUSINESSES.slice(0, 2) });
    const j = (await repo.getJob(deal.job_id))!;
    const [first, second] = await repo.getBusinesses(j.id);
    // The crash: one RFQ out, the second never sent; rfqs_sent never fired.
    await repo.casJob(j.id, j.version, { state: "contacting" });
    await repo.updateBusiness(j.id, second!.business_id, { status: "pending", contacted_at: null, next_attempt_at: null });
    const before = emails.filter((e) => e.to === second!.email).length;
    clock.advance(3 * 60_000);
    await engine.advanceJob(j.id);
    expect((await repo.getJob(j.id))!.state).toBe("collecting");
    expect((await repo.getBusinesses(j.id)).find((b) => b.business_id === second!.business_id)!.status).toBe("contacted");
    expect(emails.filter((e) => e.to === first!.email)).toHaveLength(1);
    expect(emails.filter((e) => e.to === second!.email)).toHaveLength(Math.max(before, 1)); // sent at most once
  });
});

describe("no duplicate phone calls", () => {
  it("an ambiguous provider failure (the call may be ringing) is never retried or re-placed", async () => {
    let n = 0;
    const phone: PhonePort = { async placeCall() { n++; throw new ChannelSendError("provider_error", true, 1_000, "HTTP 502 after send", true); } };
    const { engine, repo, clock } = setup(phone);
    const deal = await engine.deal({ request, budget_usd, businesses: [BUSINESSES[2]!] });
    for (let i = 0; i < 5; i++) {
      clock.advance(5 * 60_000);
      await engine.advanceJob(deal.job_id);
    }
    expect(n).toBe(1);
    const b = (await repo.getBusinesses(deal.job_id))[0]!;
    expect(b.status).not.toBe("pending");
    expect((await repo.listEvents(deal.job_id)).some((e) => e.type === "reply" && /outcome unknown/.test(String(e.data.summary)))).toBe(true);
  });

  it("an attempt whose outcome was never recorded (crash after dialing) is not dialed again", async () => {
    const { engine, repo, clock, calls } = setup();
    const deal = await engine.deal({ request, budget_usd, businesses: [BUSINESSES[2]!] });
    expect(calls).toHaveLength(1);
    // The crash: the call went out but its message row was never written; the business looks unreached.
    const call = (await repo.listMessages(deal.job_id)).find((m) => m.kind === "call")!;
    const store = repo as unknown as { messages: { id: string }[] };
    store.messages = store.messages.filter((m) => m.id !== call.id);
    const b = (await repo.getBusinesses(deal.job_id))[0]!;
    await repo.updateBusiness(deal.job_id, b.business_id, { status: "pending", next_attempt_at: new Date(clock.now().getTime() + 1_000).toISOString() });
    clock.advance(5 * 60_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
  });

  it("Inkbox: a 5xx or connection error on placeCall is ambiguous (no retry); a capacity refusal is retried", async () => {
    let tries = 0;
    const flaky = inkboxPhone({ async placeCall() { tries++; throw new InkboxAPIError(502, "bad gateway"); } }, "dedicated_number", async () => {});
    await expect(flaky.placeCall({ jobId: "j", businessId: "b", toNumber: "+14155550104", reason: "x", idempotencyKey: "k" })).rejects.toMatchObject({ ambiguous: true, retryable: false });
    expect(tries).toBe(1);
    let busy = 0;
    const capacity = inkboxPhone({ async placeCall() { if (busy++ === 0) throw new InkboxAPIError(503, { error: "hosted_agent_at_capacity" }); return { id: "call_ok" }; } }, "dedicated_number", async () => {});
    await expect(capacity.placeCall({ jobId: "j", businessId: "b", toNumber: "+14155550104", reason: "x", idempotencyKey: "k" })).resolves.toEqual({ callId: "call_ok" });
    expect(busy).toBe(2);
  });
});

describe("duplicated and repeated events", () => {
  it("a redelivered call.ended, a repeated advance and a re-run deal change nothing twice", async () => {
    const { engine, repo, calls } = setup();
    const deal = await engine.deal({ request, budget_usd, businesses: [BUSINESSES[2]!], client_request_id: "dup-1" });
    const callId = (await repo.listMessages(deal.job_id)).find((m) => m.kind === "call")!.provider_email_id!;
    const ended = { callId, outcome: "completed" as const, transcript: "remote: $1,150 total all-in, delivered, $345 deposit." };
    await engine.ingestCall(ended);
    expect((await engine.ingestCall(ended)).outcome).toBe("duplicate");
    for (let i = 0; i < 3; i++) await engine.advanceJob(deal.job_id);
    expect((await engine.deal({ request, budget_usd, businesses: [BUSINESSES[2]!], client_request_id: "dup-1" })).job_id).toBe(deal.job_id);
    expect(calls).toHaveLength(1);
    expect((await repo.listMessages(deal.job_id)).filter((m) => m.direction === "in")).toHaveLength(1);
  });
});

