// Contact hours wired into the engine (config.contactWindow): a first RFQ outside the window waits
// for the next opening unless the reply-by makes that impossible (then it goes, and why is recorded);
// silent email businesses get at most two reminders, spaced in business hours, inside the window,
// and never after a reply, a bounce or an opt-out. Fake clock in America/Los_Angeles, incl. DST.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTACT_WINDOW, zonedInstant } from "../src/workflow/contactWindow.ts";
import { dealWith, liveEngine, vendorReply } from "./helpers/liveEngine.ts";

const LA = "America/Los_Angeles";
const la = (y: number, m: number, d: number, h: number, min = 0) => zonedInstant(y, m, d, h * 60 + min, LA);
const V = { name: "Valley Catering", email: "orders@valley.example" };
const DAY = 86_400_000;
const windowed = (start: Date, collectionWindowMs = 7 * DAY) => liveEngine({ start, config: { contactWindow: DEFAULT_CONTACT_WINDOW, collectionWindowMs } });

describe("first contact", () => {
  it("an RFQ created at 23:00 is deferred to 08:00 and sent by the advance that comes due", async () => {
    const env = windowed(la(2026, 10, 21, 23));
    const d = await dealWith(env, [V]);
    expect(env.emails).toEqual([]);
    const b = (await env.repo.getBusinesses(d.jobId))[0]!;
    expect(b).toMatchObject({ status: "pending", next_attempt_at: la(2026, 10, 22, 8).toISOString() });
    expect((await env.repo.listEvents(d.jobId)).some((e) => e.data.contact_window === "deferred")).toBe(true);
    expect((await env.engine.contactStatuses(d.jobId))[0]).toMatchObject({ contact_status: "scheduled" });
    env.clock.set(la(2026, 10, 22, 7, 59));
    await env.engine.advanceJob(d.jobId);
    expect(env.emails).toEqual([]);
    env.clock.set(la(2026, 10, 22, 8, 0));
    await env.engine.advanceJob(d.jobId);
    expect(env.emails.map((e) => e.idempotencyKey)).toEqual([`rfq:${d.jobId}:${b.business_id}`]);
    expect((await env.repo.getBusinesses(d.jobId))[0]!.status).toBe("contacted");
  });

  it("when the reply-by doesn't leave time to wait, it is sent at once and the reason recorded", async () => {
    const env = windowed(la(2026, 10, 21, 23), 30 * 60_000);
    const d = await dealWith(env, [V]);
    expect(env.emails).toHaveLength(1);
    const ev = (await env.repo.listEvents(d.jobId)).find((e) => e.data.contact_window === "sent_outside_window")!;
    expect(String(ev.data.why)).toMatch(/too little time before the reply-by/);
  });

  it("across the spring-forward weekend: Saturday 22:00 waits until Monday 08:00 PDT", async () => {
    const env = windowed(la(2027, 3, 13, 22));
    const d = await dealWith(env, [V]);
    expect((await env.repo.getBusinesses(d.jobId))[0]!.next_attempt_at).toBe("2027-03-15T15:00:00.000Z");
  });

  it("without config.contactWindow nothing is deferred and no reminders go out (mock mode, tests)", async () => {
    const env = liveEngine({ start: la(2026, 10, 21, 23), config: { collectionWindowMs: 7 * DAY } });
    const d = await dealWith(env, [V]);
    expect(env.emails).toHaveLength(1);
    env.clock.set(la(2026, 10, 26, 12));
    await env.engine.advanceJob(d.jobId);
    expect(env.emails).toHaveLength(1);
  });
});

describe("reminders to a silent business", () => {
  it("first ≥ 24 business hours after the RFQ, threaded on it with the token; the second spaced again; never a third", async () => {
    const env = windowed(la(2026, 10, 21, 10)); // Wed 10:00
    const d = await dealWith(env, [V]);
    const rfq = env.emails[0]!;
    env.clock.set(la(2026, 10, 23, 11, 59));
    await env.engine.advanceJob(d.jobId);
    expect(env.emails).toHaveLength(1);
    env.clock.set(la(2026, 10, 23, 12, 0)); // Fri 12:00 = 24 business hours
    await env.engine.advanceJob(d.jobId);
    expect(env.emails).toHaveLength(2);
    const r1 = env.emails[1]!;
    expect(r1.idempotencyKey).toBe(`reminder:${d.jobId}:${d.businesses[0]!.business_id}:1`);
    expect(r1.thread?.inReplyTo).toMatch(/^<em_1_/);
    expect(r1.subject).toBe(rfq.subject);
    expect(r1.bodyText).toMatch(/reply STOP/);
    expect(r1.bodyText).toContain(d.token(d.businesses[0]!.business_id));
    // Due again Mon 14:00 (Fri 7h + Sat 11h + Mon 6h). Saturday 18:00 is too soon; Monday 23:00 is outside the window.
    env.clock.set(la(2026, 10, 24, 18));
    await env.engine.advanceJob(d.jobId);
    env.clock.set(la(2026, 10, 26, 23));
    await env.engine.advanceJob(d.jobId);
    expect(env.emails).toHaveLength(2);
    env.clock.set(la(2026, 10, 27, 9)); // the next opening after that: Tue 08:00
    await env.engine.advanceJob(d.jobId);
    expect(env.emails).toHaveLength(3);
    env.clock.set(la(2026, 10, 28, 15));
    await env.engine.advanceJob(d.jobId);
    expect(env.emails).toHaveLength(3);
    expect((await env.engine.contactStatuses(d.jobId))[0]).toMatchObject({ contact_status: "awaiting_reply", reminders_sent: 2 });
  });

  it("never after a reply (even a held one), a bounce or an opt-out", async () => {
    for (const what of ["reply", "held", "bounce", "optout"] as const) {
      const env = windowed(la(2026, 10, 21, 10));
      const d = await dealWith(env, [V]);
      const b = d.businesses[0]!;
      const token = d.token(b.business_id);
      if (what === "reply") await vendorReply(env, (await env.repo.getBusinesses(d.jobId))[0]!, token, { bodyText: "Let me check with the chef and get back to you." });
      if (what === "held") await vendorReply(env, (await env.repo.getBusinesses(d.jobId))[0]!, token, { subject: "Re: Quote request", bodyText: "Checking with the chef." });
      if (what === "bounce") {
        const rfq = (await env.repo.listMessages(d.jobId)).find((m) => m.kind === "rfq")!;
        await env.engine.ingestDeliveryStatus({ providerMessageId: rfq.provider_email_id!, status: "bounced", source: "webhook" });
      }
      if (what === "optout") await env.repo.addSuppression({ contact: V.email, reason: "opt_out", job_id: null, evidence: "STOP (another deal)" });
      env.clock.set(la(2026, 10, 27, 12));
      await env.engine.advanceJob(d.jobId);
      expect(env.emails.filter((e) => e.idempotencyKey.startsWith("reminder:")), what).toEqual([]);
    }
  });
});
