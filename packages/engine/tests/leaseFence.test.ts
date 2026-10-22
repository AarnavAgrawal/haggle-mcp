// Job leases at every external side effect (sprint 4, workstream F). For each kind of send (email,
// a text to a business, a Voice AI call, an A2A task, a text to the human), the lease is lost
// immediately BEFORE the attempt (nothing reaches the provider, nothing is recorded, the new holder
// sends it once) and immediately AFTER the provider accepted it (the result is still recorded, the
// stale holder sends nothing more, the new holder never sends it again). Then renewal timeouts, a
// provider that hangs past the lease, and two replicas advancing at once. Fake clock and providers.
import { describe, expect, it } from "vitest";
import { InMemoryRepository, LeaseLostError } from "../src/index.ts";
import type { JobBusinessRow, JobRow } from "../src/store/types.ts";
import { APPROVER, BUDGET, FakeProviders, kit, leaseControl, newClock, REQUEST, type Kit } from "./helpers/reliabilityKit.ts";

const EMAIL = "harbor@inkboxmail.test";
const PHONE = "+14155550142";
const CARD = "https://agent.example/.well-known/agent-card.json";

/** Two engine instances (a, b) on one database and one set of providers; a holds the lease first. */
async function pair(business: Record<string, string>) {
  const repo = new InMemoryRepository();
  const clock = newClock();
  const providers = new FakeProviders(clock);
  const a = kit({ instanceId: "a" }, { repo, clock, providers, instanceId: "a" });
  const b = kit({ instanceId: "b" }, { repo, clock, providers, instanceId: "b" });
  const ctl = leaseControl(repo);
  const deal = await a.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", ...business }] });
  const job = (await repo.getJob(deal.job_id))!;
  const biz = (await repo.getBusinesses(job.id))[0]!;
  return { repo, clock, providers, a, b, ctl, job, biz };
}

type Effect = { name: string; business: Record<string, string>; key: (j: JobRow, b: JobBusinessRow) => string; run: (k: Kit, j: JobRow, b: JobBusinessRow) => Promise<unknown>; delivered: (p: FakeProviders, key: string) => number };

const EFFECTS: Effect[] = [
  {
    name: "email to a business", business: { email: EMAIL },
    key: (j, b) => `followup:${j.id}:${b.business_id}:9`,
    run: (k, j, b) => k.priv<(...a: unknown[]) => Promise<unknown>>("sendRecorded")(j, b, "followup", `followup:${j.id}:${b.business_id}:9`, { to: b.email, subject: "Following up", bodyText: "Just checking in on our quote request." }),
    delivered: (p, key) => p.deliveries.filter((d) => d.channel === "email" && d.key === key).length,
  },
  {
    name: "text to a business", business: { phone: PHONE, channel: "imessage" },
    key: (j, b) => `imsg-followup:${j.id}:${b.business_id}`,
    run: (k, j, b) => k.priv<(...a: unknown[]) => Promise<unknown>>("sendIMessageToBusiness")(j, b, "followup", `imsg-followup:${j.id}:${b.business_id}`, "Following up on our quote request.", null),
    delivered: (p, key) => p.deliveries.filter((d) => d.channel === "text" && d.key === key).length,
  },
  {
    name: "Voice AI call", business: { phone: PHONE },
    key: (j, b) => `call:counter:${j.id}:${b.business_id}`,
    run: (k, j, b) => k.priv<(...a: unknown[]) => Promise<unknown>>("placeCallOnce")(j.id, { jobId: j.id, businessId: b.business_id, toNumber: b.phone!, reason: "I'm an AI assistant calling about a quote.", idempotencyKey: `call:counter:${j.id}:${b.business_id}` }),
    delivered: (p) => p.deliveries.filter((d) => d.channel === "call" && /AI assistant calling about a quote/.test(d.text)).length,
  },
  {
    name: "A2A task", business: { a2a_card_url: CARD },
    key: (j, b) => `a2a-msg:${j.id}:${b.business_id}`,
    run: (k, j, b) => k.priv<(...a: unknown[]) => Promise<unknown>>("a2aSend")(j.id, `a2a-msg:${j.id}:${b.business_id}`, { cardUrl: b.a2a_card_url!, text: "Following up.", data: {}, messageId: `haggle-msg-${j.id}` }),
    delivered: (p, key) => p.attempts.filter((d) => d.channel === "a2a" && d.key === `haggle-msg-${key.split(":")[1]}`).length,
  },
  {
    name: "text to the human", business: { email: EMAIL },
    key: (j) => `notify:${j.id}:lease-test`,
    run: async (k, j) => {
      const r = await k.priv<(...a: unknown[]) => Promise<{ ok: boolean; reason?: string }>>("textHuman")(j, APPROVER, { key: `notify:${j.id}:lease-test`, text: "Haggle: all quotes are in" });
      if (!r.ok) throw Object.assign(new Error(r.reason), { reason: r.reason });
      return r;
    },
    delivered: (p, key) => p.deliveries.filter((d) => d.channel === "text" && d.key === key).length,
  },
];

describe("lease lost immediately before a side effect: nothing reaches the provider; the new holder sends it once", () => {
  for (const e of EFFECTS) {
    it(e.name, async () => {
      const t = await pair(e.business);
      const key = e.key(t.job, t.biz);
      const before = t.providers.attempts.length;
      t.ctl.lose = true; // another instance took the job just before this send
      const r = await t.a.inAdvance(t.job.id, () => e.run(t.a, t.job, t.biz)).then((v) => ({ ok: true, v }), (err: unknown) => ({ ok: false, err }));
      if (e.name === "text to a business") expect(r).toEqual({ ok: true, v: null }); // logged as deferred, not sent
      else if (e.name === "text to the human") expect(r).toMatchObject({ ok: false, err: { reason: "lease_lost" } });
      else expect(r).toMatchObject({ ok: false, err: expect.any(LeaseLostError) });
      expect(t.providers.attempts.length).toBe(before);
      expect(await t.repo.getOutbox(key)).toBeNull(); // not even claimed
      expect(t.a.logs.some((l) => l.event === "lease_lost")).toBe(true);
      // The new holder (b) sends it, exactly once.
      t.ctl.lose = false;
      await t.b.inAdvance(t.job.id, () => e.run(t.b, t.job, t.biz));
      expect(e.delivered(t.providers, key)).toBe(1);
      expect((await t.repo.getOutbox(key))!.status).toBe("sent");
    });
  }
});

describe("lease lost immediately after the provider accepted: recorded anyway, nothing more from the stale holder, never sent again", () => {
  for (const e of EFFECTS) {
    it(e.name, async () => {
      const t = await pair(e.business);
      const key = e.key(t.job, t.biz);
      t.providers.afterDeliver = () => { t.ctl.lose = true; };
      const sendAfter = async () => {
        await e.run(t.a, t.job, t.biz);
        // A second send in the same advance, after the lease is gone: refused at the fence.
        return t.a.priv<(...a: unknown[]) => Promise<unknown>>("sendRecorded")(t.job, null, "message", `probe:${t.job.id}`, { to: "ops@haggle.test", subject: "probe", bodyText: "probe" }).then(() => "sent", (err: unknown) => (err instanceof LeaseLostError ? "fenced" : String(err)));
      };
      expect(await t.a.inAdvance(t.job.id, sendAfter)).toBe("fenced");
      t.providers.afterDeliver = null;
      expect(e.delivered(t.providers, key)).toBe(1);
      expect((await t.repo.getOutbox(key))!.status).toBe("sent"); // the stale holder still recorded what it sent
      expect(t.providers.deliveries.some((d) => d.key === `probe:${t.job.id}`)).toBe(false);
      // The new holder tries the same action: the record stops it (or the provider replays it); never a second delivery.
      t.ctl.lose = false;
      await t.b.inAdvance(t.job.id, () => e.run(t.b, t.job, t.biz)).catch(() => undefined);
      expect(e.delivered(t.providers, key)).toBe(1);
    });
  }
});

describe("lease renewal timeouts, hung providers and replicas", () => {
  it("a renewal that times out (database stall) fences the send: nothing sent, the business is not bounced, the next advance sends once", async () => {
    const t = await pair({ email: EMAIL });
    // The RFQ failed before the provider accepted it; its retry comes due inside an advance.
    const key = `rfq:${t.job.id}:${t.biz.business_id}`;
    const fresh = await (async () => {
      const repo = new InMemoryRepository();
      const clock = newClock();
      const providers = new FakeProviders(clock);
      providers.fail("email", "5xx_before");
      const a = kit({ instanceId: "a" }, { repo, clock, providers, instanceId: "a" });
      const ctl = leaseControl(repo);
      const d = await a.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: EMAIL }] });
      return { repo, clock, providers, a, ctl, jobId: d.job_id };
    })();
    expect(key).toMatch(/^rfq:/);
    expect(fresh.providers.deliveries).toHaveLength(0);
    const b0 = (await fresh.repo.getBusinesses(fresh.jobId))[0]!;
    expect(b0).toMatchObject({ status: "pending", send_attempts: 1 });
    fresh.clock.advance(5_000);
    fresh.ctl.renewThrows = true;
    await fresh.a.engine.advanceJob(fresh.jobId);
    expect(fresh.providers.deliveries).toHaveLength(0);
    expect((await fresh.repo.getBusinesses(fresh.jobId))[0]).toMatchObject({ status: "pending", send_attempts: 1 }); // untouched by the fenced advance
    fresh.ctl.renewThrows = false;
    await fresh.a.engine.advanceJob(fresh.jobId);
    expect(fresh.providers.to(EMAIL)).toHaveLength(1);
    expect((await fresh.repo.getBusinesses(fresh.jobId))[0]!.status).toBe("contacted");
  });

  it("a provider that hangs past the lease: the new holder re-sends under the same key; the provider delivers it once", async () => {
    const repo = new InMemoryRepository();
    const clock = newClock();
    const providers = new FakeProviders(clock);
    providers.fail("email", "5xx_before", "hang");
    const a = kit({ instanceId: "a" }, { repo, clock, providers, instanceId: "a" });
    const b = kit({ instanceId: "b" }, { repo, clock, providers, instanceId: "b" });
    const d = await a.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: EMAIL }] });
    clock.advance(5_000);
    const stuck = a.engine.advanceJob(d.job_id); // hangs inside email.send
    await new Promise((r) => setTimeout(r, 20));
    clock.advance(3 * 60_000); // past the lease TTL (60 s) and the outbox's stale-claim age (2 min)
    await b.engine.advanceJob(d.job_id);
    expect(providers.to(EMAIL)).toHaveLength(1);
    providers.releaseHung();
    await stuck;
    expect(providers.to(EMAIL)).toHaveLength(1); // a's late attempt was replayed by the provider, not delivered again
    expect((await repo.getOutbox(`rfq:${d.job_id}:${(await repo.getBusinesses(d.job_id))[0]!.business_id}`))!.status).toBe("sent");
  });

  it("two replicas advancing the same job at once: one holds the lease, every due send goes out once", async () => {
    const repo = new InMemoryRepository();
    const clock = newClock();
    const providers = new FakeProviders(clock);
    providers.fail("email", "5xx_before", "5xx_before");
    providers.fail("call", "refuse");
    const [a, b] = ["a", "b"].map((id) => kit({ instanceId: id }, { repo, clock, providers, instanceId: id }));
    const d = await a!.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: EMAIL }, { name: "Bay Grill", email: "bay@inkboxmail.test" }, { name: "Mission Eats", phone: PHONE }] });
    expect(providers.deliveries).toHaveLength(0);
    clock.advance(5_000);
    await Promise.all([a!.engine.advanceJob(d.job_id), b!.engine.advanceJob(d.job_id), a!.engine.advanceJob(d.job_id), b!.engine.advanceJob(d.job_id)]);
    clock.advance(5_000);
    await Promise.all([a!.engine.advanceJob(d.job_id), b!.engine.advanceJob(d.job_id)]);
    expect(providers.to(EMAIL)).toHaveLength(1);
    expect(providers.to("bay@inkboxmail.test")).toHaveLength(1);
    expect(providers.to(PHONE)).toHaveLength(1);
  });
});
