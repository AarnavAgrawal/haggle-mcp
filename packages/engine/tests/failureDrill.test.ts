// A complete simulated failure-and-recovery exercise (sprint 4, workstream F). One deal goes
// through, in order: a crash in the middle of the RFQ fan-out (the process dies after Inkbox accepted
// an email, before it was recorded), a restart into a provider 5xx storm, a lease takeover in the
// middle of an advance, a reply whose webhook is lost, a database outage of 20 minutes with another
// reply arriving during it, and an ambiguous call. Recovery uses only the normal machinery (the
// restarted engine's advance, the reconciler's sweep, the stuck-job sweep) and job-ops.
// Asserted: no business contacted twice, no reply lost, nothing marked bounced that wasn't, every
// item still waiting on a person visible in the ops report. Fake Inkbox, fake clock, in memory.
import { describe, expect, it } from "vitest";
import { buildOpsReport, disabledPayer, HaggleEngine, InboundReconciler, inkboxEmail, InMemoryRepository, planOutboxRetry, StubBrain } from "../src/index.ts";
import type { Repository } from "../src/store/types.ts";
import { BUYER } from "./helpers/fakeInkbox.ts";
import { APPROVER, BUDGET, FakeProviders, leaseControl, newClock, REQUEST, textExtractor, TimedInkbox } from "./helpers/reliabilityKit.ts";

const VENDORS = ["harbor@inkboxmail.test", "sunset@inkboxmail.test", "mission@inkboxmail.test"];
const PHONE = "+14155550142";
const MIN = 60_000;

/** The database as every engine sees it: `down` makes every call fail like a dropped connection. */
function flakyDb(base: InMemoryRepository) {
  const state = { down: false };
  const repo = new Proxy(base, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => (state.down ? Promise.reject(Object.assign(new Error("connection terminated unexpectedly"), { code: "CONNECTION_ENDED" })) : (v as (...x: unknown[]) => unknown).apply(t, a));
    },
  }) as InMemoryRepository;
  return { repo, state };
}

describe("failure drill: crash, storm, takeover, lost webhook, database outage, then recovery", () => {
  it("no duplicate business contact, no lost reply, every stuck item visible", { timeout: 60_000 }, async () => {
    const clock = newClock(Date.parse("2026-10-22T16:00:00Z"));
    const api = new TimedInkbox(clock);
    const providers = new FakeProviders(clock); // calls and texts to the human
    const base = new InMemoryRepository();
    const db = flakyDb(base);
    const logs: { who: string; event: string; data: Record<string, unknown> }[] = [];
    const engineFor = (who: string, repo: Repository) => new HaggleEngine({
      repo, now: clock.now, email: inkboxEmail(api, BUYER, { sleep: async () => {} }), phone: providers.phone, sms: providers.sms,
      extractor: textExtractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
      log: (event, data) => logs.push({ who, event, data }),
      config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER, collectionWindowMs: 3 * 60 * MIN, negotiationWindowMs: 10 * MIN, approvalTtlMs: 30 * MIN, globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, instanceId: who, leaseTtlMs: MIN },
    });

    // ── 1. Crash mid fan-out: Inkbox accepts the second RFQ, then the process dies before recording it.
    const crashing = Object.create(base) as InMemoryRepository;
    let rfqs = 0;
    let crashed!: () => void;
    const died = new Promise<void>((r) => { crashed = r; });
    crashing.insertMessage = async (m) => {
      if (m.kind === "rfq" && ++rfqs === 2) { crashed(); return new Promise<never>(() => {}); }
      return base.insertMessage(m);
    };
    const a = engineFor("a", crashing);
    providers.fail("call", "timeout_after"); // the phone vendor's call will be ambiguous
    void a.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [...VENDORS.map((email, i) => ({ name: ["Harbor Table", "Sunset Kitchen", "Mission Eats"][i]!, email })), { name: "Golden Grill", phone: PHONE }] });
    await died;
    const jobId = (await base.listOpenJobs())[0]!.id;
    expect(api.sent.map((s) => s.o.to[0])).toEqual(VENDORS.slice(0, 2)); // Harbor sent and recorded; Sunset sent, not recorded; the rest never reached

    // ── 2. Restart into a 5xx storm: the restarted engine retries; nothing gets through, nothing is bounced.
    const b = engineFor("b", db.repo);
    const leaseB = leaseControl(base);
    clock.advance(3 * MIN); // past the stuck-contacting and stale-claim ages
    api.failNext = Array(12).fill(503);
    await b.advanceJob(jobId);
    expect(api.sent).toHaveLength(2);
    expect((await base.getBusinesses(jobId)).every((x) => x.status !== "bounced")).toBe(true);
    api.failNext = [];

    // ── 3. Lease takeover mid advance: b loses the job right after one send gets through; c takes over.
    const send = api.send.bind(api);
    let tookOver = false;
    api.send = async (mb, o) => {
      const r = await send(mb, o);
      if (!tookOver) { tookOver = true; leaseB.lose = true; }
      return r;
    };
    clock.advance(2 * MIN);
    await b.advanceJob(jobId);
    api.send = send;
    leaseB.lose = false;
    const c = engineFor("c", db.repo);
    // ...and the database drops a write right after Inkbox accepts the next RFQ (sent, not recorded).
    const insert = base.insertMessage.bind(base);
    let dropped = false;
    base.insertMessage = async (m) => {
      if (!dropped && m.kind === "rfq") { dropped = true; throw Object.assign(new Error("connection terminated unexpectedly"), { code: "CONNECTION_ENDED" }); }
      return insert(m);
    };
    for (let i = 0; i < 4; i++) {
      clock.advance(2 * MIN);
      await c.advanceJob(jobId);
    }
    const businesses = await base.getBusinesses(jobId);
    for (const v of VENDORS) expect(api.sent.filter((s) => s.o.to[0] === v), v).toHaveLength(1); // each reached exactly once
    expect(businesses.filter((x) => x.email).every((x) => x.status === "contacted")).toBe(true);
    expect(providers.to(PHONE)).toHaveLength(1);
    expect(logs.some((l) => l.who === "b" && l.event === "lease_lost")).toBe(true);

    // ── 4. A reply whose webhook is lost (Harbor), then a 20-minute database outage with Sunset replying during it.
    const rfqOf = (email: string) => businesses.find((x) => x.email === email)!.rfq_message_id!;
    clock.advance(5 * MIN);
    const harbor = api.reply(VENDORS[0]!, rfqOf(VENDORS[0]!), "We can do it: $1,150 total, delivered. $345 deposit.");
    const reconciler = new InboundReconciler({ engine: c, repo: db.repo, now: clock.now, sources: { mail: { api, buyerMailbox: BUYER, senderTrust: { policy: "outbound-verified" }, identityAddresses: async () => [BUYER, ...VENDORS] } } });
    db.state.down = true;
    clock.advance(5 * MIN);
    const sunset = api.reply(VENDORS[1]!, rfqOf(VENDORS[1]!), "We can do it: $1,300 total, delivered.");
    for (let i = 0; i < 4; i++) {
      clock.advance(5 * MIN);
      await c.advanceAllOpen().catch(() => undefined);
      await reconciler.sweepAll().catch(() => undefined);
    }
    db.state.down = false;
    expect(api.sent).toHaveLength(3); // nothing sent while the database was down

    // ── 5. Recovery: the reconciler's sweep, the advance, the stuck-job sweep.
    const swept = await reconciler.sweepAll();
    expect(swept.recovered.map((x) => x.providerId).sort()).toEqual([harbor.id, sunset.id].sort());
    await c.advanceJob(jobId);
    expect((await c.getQuotes(jobId)).quotes.map((q) => q.total_usd).sort()).toEqual([1150, 1300]);
    clock.advance(4 * 60 * MIN); // the collection window closes; the backup tick runs
    await c.advanceAllOpen();
    await c.recoverStuck();
    expect((await reconciler.sweepAll()).recovered).toEqual([]); // nothing recovered twice

    // No business contacted twice, by any channel, over the whole drill.
    for (const v of VENDORS) expect(api.sent.filter((s) => s.o.to[0] === v && /^rfq:/.test(s.o.idempotencyKey ?? ""))).toHaveLength(1);
    expect(providers.to(PHONE)).toHaveLength(1);
    expect(new Set(api.sent.map((s) => s.o.idempotencyKey)).size).toBe(api.sent.length);

    // The ambiguous call is never redialed, not even by an operator.
    const callKey = `call:${jobId}:${businesses.find((x) => x.phone === PHONE)!.business_id}`;
    const callRow = (await base.getOutbox(callKey))!;
    expect(callRow.status).toBe("unknown");
    expect(planOutboxRetry({ key: callKey, row: callRow, review: await base.findOpenReview("outbox", callKey), job: await base.getJob(jobId), override: true, by: "ops" })).toMatchObject({ ok: false, reason: expect.stringMatching(/never redialed/) });

    // Every open review is in the ops report, under its workspace.
    const open = await base.listReviews({ status: "open", limit: 1000 });
    expect(open.some((r) => r.subject === callKey)).toBe(true);
    const report = await buildOpsReport(base, { now: clock.now() });
    const listed = new Set(report.workspaces.flatMap((w) => w.reviews.map((r) => r.id)));
    for (const r of open) expect(listed.has(r.id), `${r.kind} ${r.subject}`).toBe(true);
    expect(report.workspaces.flatMap((w) => w.failed_communications).some((f) => f.status === "unknown" && f.what.includes(callKey))).toBe(true);
  });
});
