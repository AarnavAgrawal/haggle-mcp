// Per-business contact status (inbound/contactStatus.ts, engine.contactStatuses) and delivery status
// consistency: message.bounced / message.failed mark the outbound row, the business's status and the
// suppression list once, whether they arrive by webhook, by the reconciler's sweep, or both.
import { describe, expect, it } from "vitest";
import { PostgresRepository } from "../src/store/postgres.ts";
import type { TrustVerdict } from "../src/inbound/primitive.ts";
import { dealWith, liveEngine, vendorReply, type LiveEnv } from "./helpers/liveEngine.ts";

const V = { name: "Valley Catering", email: "orders@valley.example" };
const W = { name: "Westside Kitchen", email: "hello@westside.example" };
const uniq = () => Math.random().toString(36).slice(2, 8);

async function twoVendors(env: LiveEnv, v = V, w = W) {
  const d = await dealWith(env, [v, w]);
  const bv = d.businesses.find((b) => b.email === v.email)!;
  const bw = d.businesses.find((b) => b.email === w.email)!;
  const rfq = async (b: typeof bv) => (await env.repo.listMessages(d.jobId)).find((m) => m.direction === "out" && m.kind === "rfq" && m.business_id === b.business_id)!;
  const status = async (b: typeof bv) => (await env.engine.contactStatuses(d.jobId)).find((s) => s.business_id === b.business_id)!;
  return { ...d, bv, bw, rfq, status };
}

async function bounceIdempotent(env: LiveEnv, v = V, w = W) {
  const d = await twoVendors(env, v, w);
  expect(await d.status(d.bv)).toMatchObject({ contact_status: "awaiting_reply", delivered: null });
  const rfq = await d.rfq(d.bv);
  const first = await env.engine.ingestDeliveryStatus({ providerMessageId: rfq.provider_email_id!, rfcMessageId: rfq.rfc_message_id, status: "bounced", source: "webhook" });
  expect(first).toMatchObject({ jobId: d.jobId, outcome: "bounced" });
  // The reconciler's sweep finds the same status later; a webhook replay too: no second effect.
  expect((await env.engine.ingestDeliveryStatus({ providerMessageId: rfq.provider_email_id!, rfcMessageId: rfq.rfc_message_id, status: "bounced", source: "reconcile" })).outcome).toBe("duplicate");
  expect((await env.engine.ingestDeliveryStatus({ providerMessageId: rfq.provider_email_id!, rfcMessageId: null, status: "bounced", source: "webhook" })).outcome).toBe("duplicate");
  const row = (await env.repo.getMessage(rfq.id))!;
  expect(row.delivery_status).toBe("bounced");
  expect(row.delivery_status_at).toBeTruthy();
  expect((await env.repo.getBusinesses(d.jobId)).find((b) => b.business_id === d.bv.business_id)!.status).toBe("bounced");
  expect(await env.repo.findSuppressions([v.email])).toHaveLength(1);
  expect((await env.repo.listEvents(d.jobId)).filter((e) => e.data.delivery_status === "bounced")).toHaveLength(1);
  // The outbox row stays "sent": the provider accepted the send; the bounce is a later fact.
  expect((await env.repo.getOutbox(rfq.idempotency_key!))!.status).toBe("sent");
  expect(await d.status(d.bv)).toMatchObject({ contact_status: "bounced", delivered: false, line: "Email bounced; address suppressed" });
  expect(await d.status(d.bw)).toMatchObject({ contact_status: "awaiting_reply" });
  return d;
}

describe("bounced / failed: one consistent record, however it arrives", () => {
  it("a bounce by webhook, then the sweep, then a replay: suppressed once, one event, the message and business marked", async () => {
    await bounceIdempotent(liveEngine());
  });

  it("failed is recorded on the message and in the contact status, never suppressed; a later bounce outranks it", async () => {
    const env = liveEngine();
    const d = await twoVendors(env);
    const rfq = await d.rfq(d.bv);
    expect((await env.engine.ingestDeliveryStatus({ providerMessageId: rfq.provider_email_id!, status: "failed", source: "reconcile" })).outcome).toBe("delivery_failed");
    expect((await env.engine.ingestDeliveryStatus({ providerMessageId: rfq.provider_email_id!, status: "failed", source: "webhook" })).outcome).toBe("duplicate");
    expect((await env.repo.getMessage(rfq.id))!.delivery_status).toBe("failed");
    expect(await env.repo.findSuppressions([V.email])).toEqual([]);
    expect(await d.status(d.bv)).toMatchObject({ contact_status: "failed", delivered: false });
    expect((await env.engine.ingestDeliveryStatus({ providerMessageId: rfq.provider_email_id!, status: "bounced", source: "webhook" })).outcome).toBe("bounced");
    expect((await env.repo.getMessage(rfq.id))!.delivery_status).toBe("bounced");
    expect(await d.status(d.bv)).toMatchObject({ contact_status: "bounced" });
  });

  it("an event naming a message Haggle didn't send changes nothing", async () => {
    const env = liveEngine();
    const d = await twoVendors(env);
    expect((await env.engine.ingestDeliveryStatus({ providerMessageId: "someone-elses", status: "bounced", source: "webhook" })).outcome).toBe("unmatched");
    expect(await d.status(d.bv)).toMatchObject({ contact_status: "awaiting_reply" });
  });
});

describe("contact status per business", () => {
  it("replied, quarantined reply, opted out (verified: everywhere; unverified: this deal), awaiting reply", async () => {
    const env = liveEngine();
    const d = await twoVendors(env);
    // V answers properly; W's answer lacks the reference: held.
    await vendorReply(env, d.bv, d.token(d.bv.business_id));
    await vendorReply(env, d.bw, d.token(d.bw.business_id), { subject: "Re: Quote request", bodyText: "$1,300 total" });
    await env.engine.advanceJob(d.jobId);
    expect(await d.status(d.bv)).toMatchObject({ contact_status: "replied", line: "Replied" });
    expect(await d.status(d.bw)).toMatchObject({ contact_status: "quarantined_reply", line: expect.stringMatching(/no reference code/) });
    // W then writes STOP with its token: verified opt-out, suppressed everywhere.
    await vendorReply(env, d.bw, d.token(d.bw.business_id), { bodyText: "STOP" });
    expect(await d.status(d.bw)).toMatchObject({ contact_status: "opted_out", line: expect.stringMatching(/won't contact them again/) });

    const env2 = liveEngine();
    const e = await twoVendors(env2);
    const unverified = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
    await vendorReply(env2, e.bv, d.token(d.bv.business_id) /* not this deal's token */, { bodyText: "Please stop emailing us." }, unverified);
    expect(await e.status(e.bv)).toMatchObject({ contact_status: "opted_out", line: expect.stringMatching(/unverified/) });
    expect(await env2.repo.findSuppressions([V.email])).toEqual([]);
    expect(await e.status(e.bw)).toMatchObject({ contact_status: "awaiting_reply", reminders_sent: 0 });
  });
});

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("delivery status on Postgres (migration 112)", { timeout: 60_000 }, () => {
  it("bounce by webhook and sweep: idempotent under the database's constraints", async () => {
    const pg = new PostgresRepository(PG_URL!);
    try {
      await bounceIdempotent(liveEngine({ repo: pg }), { name: "Valley Catering", email: `orders-${uniq()}@valley.example` }, { name: "Westside Kitchen", email: `hello-${uniq()}@westside.example` });
    } finally {
      await pg.close();
    }
  });
});
