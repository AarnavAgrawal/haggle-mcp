// Operator review of quarantined email (inbound/quarantineReview.ts; apps/mcp/scripts/quarantine.ts):
// list with a redacted preview, release after independent verification (provenance kept, read as a
// quote only: "operator_verified" is continuity-only), reject. In memory and on Postgres (migration
// 112's append-only table and release trigger). Real engine, fakes, no network.
import { describe, expect, it } from "vitest";
import { bindingTermsTrust, CONTINUITY_ONLY_REASONS, provesSenderIdentity } from "../src/inbound/trustStrength.ts";
import { PostgresRepository } from "../src/store/postgres.ts";
import type { TrustVerdict } from "../src/inbound/types.ts";
import { BUYER, dealWith, liveEngine, vendorReply, type LiveEnv } from "./helpers/liveEngine.ts";

const V = { name: "Valley Catering", email: "orders@valley.example" };
const W = { name: "Westside Kitchen", email: "hello@westside.example" };
const HOW = "phoned Valley Catering at the number on its website; they confirmed $1,150 total";

async function tokenlessReply(env: LiveEnv) {
  const d = await dealWith(env, [V, W]);
  const b = d.businesses.find((x) => x.email === V.email)!;
  const r = await vendorReply(env, b, d.token(b.business_id), { subject: "Re: Quote request", bodyText: `We can do it: $1,150 total, delivered. Call me at (415) 555-0199 or write ${V.email}.\n\nOn Thu, Haggle <${BUYER}> wrote:\n> Budget: up to $2,000 total` });
  expect(r.outcome).toBe("quarantined:identity_unverified");
  const held = (await env.repo.listMessages(d.jobId)).find((m) => m.direction === "in")!;
  return { ...d, b, held };
}

async function releaseFlow(env: LiveEnv) {
  const { jobId, b, held } = await tokenlessReply(env);
  const [entry] = await env.engine.quarantined({ jobId });
  expect(entry).toMatchObject({ message_id: held.id, reason: "identity_unverified:token_missing", decision: null, job_id: jobId, business_id: b.business_id });
  // The preview is redacted, quoted history cut, untrusted text only.
  expect(entry!.preview).toContain("$1,150 total");
  expect(entry!.preview).not.toMatch(/555-0199|orders@valley|Budget: up to/);
  expect(entry!.from).toBe("o***@valley.example");

  const r = await env.engine.releaseQuarantined({ messageId: held.id, verifiedBy: "Dana (ops)", how: HOW });
  expect(r).toMatchObject({ ok: true, jobId, businessId: b.business_id });
  const m = (await env.repo.getMessage(held.id))!;
  expect(m).toMatchObject({ kind: "reply", sender_trusted: true, trust_reason: "operator_verified", quarantine_reason: "identity_unverified:token_missing" });
  const [res] = await env.repo.listQuarantineResolutions({ messageId: held.id });
  expect(res).toMatchObject({ decision: "released", original_reason: "identity_unverified:token_missing", original_trust_reason: "unverified-external-sender", resolved_by: "Dana (ops)", verification: HOW, released_trust_reason: "operator_verified" });
  expect(res!.resolved_at).toBeTruthy();
  expect((await env.repo.listEvents(jobId)).find((e) => e.type === "quarantine_released")?.data).toMatchObject({ message_id: held.id, original_reason: "identity_unverified:token_missing", verified_by: "Dana (ops)" });

  // The next advance reads it as a quote; it is never proof of identity.
  await env.engine.advanceJob(jobId);
  const q = (await env.engine.getQuotes(jobId)).quotes.find((x) => x.business_id === b.business_id)!;
  expect(q.total_usd).toBe(1150);
  expect(provesSenderIdentity((await env.repo.getMessage(held.id))!)).toBe(false);
  expect(await env.engine.quarantined({ jobId })).toEqual([]);
  return { jobId, b, held };
}

describe("release", () => {
  it("a verified release becomes an operator_verified reply and a quote, with provenance; never identity", async () => {
    const env = liveEngine();
    const { jobId, b } = await releaseFlow(env);
    const status = (await env.engine.contactStatuses(jobId)).find((s) => s.business_id === b.business_id)!;
    expect(status).toMatchObject({ contact_status: "replied", line: expect.stringMatching(/released by an operator/) });
  });

  it("operator_verified is continuity-only: it can't confirm a booking, name a payee or verify a payment on its own", () => {
    expect(CONTINUITY_ONLY_REASONS.has("operator_verified")).toBe(true);
    const v = bindingTermsTrust({ sender_trusted: true, trust_reason: "operator_verified" });
    expect(v).toMatchObject({ senderIdentity: "thread_only", mayConfirmBooking: false, requiresHumanAck: true, mayNamePayee: false, mayVerifySettlement: false });
    expect(bindingTermsTrust({ sender_trusted: true, trust_reason: "external-reply-token" })).toMatchObject({ senderIdentity: "thread_only", requiresHumanAck: true });
    expect(bindingTermsTrust({ sender_trusted: true, trust_reason: "trusted" })).toMatchObject({ senderIdentity: "verified", mayConfirmBooking: true, requiresHumanAck: false, warning: null });
    expect(bindingTermsTrust({ sender_trusted: false, trust_reason: null })).toMatchObject({ senderIdentity: "unverified", mayConfirmBooking: false, requiresHumanAck: false });
  });

  it("refuses without who and how, twice, onto another deal or business, or once the deal is past approval", async () => {
    const env = liveEngine();
    const { jobId, b, held } = await tokenlessReply(env);
    const other = (await env.repo.getBusinesses(jobId)).find((x) => x.business_id !== b.business_id)!;
    expect(await env.engine.releaseQuarantined({ messageId: held.id, verifiedBy: "", how: HOW })).toMatchObject({ ok: false, code: "bad_input" });
    expect(await env.engine.releaseQuarantined({ messageId: held.id, verifiedBy: "Dana", how: "ok" })).toMatchObject({ ok: false, code: "bad_input" });
    expect(await env.engine.releaseQuarantined({ messageId: held.id, verifiedBy: "Dana", how: HOW, businessId: other.business_id })).toMatchObject({ ok: false, code: "wrong_target" });
    expect(await env.engine.releaseQuarantined({ messageId: "msg_nope", verifiedBy: "Dana", how: HOW })).toMatchObject({ ok: false, code: "not_found" });
    await env.engine.cancel(jobId);
    expect(await env.engine.releaseQuarantined({ messageId: held.id, verifiedBy: "Dana", how: HOW })).toMatchObject({ ok: false, code: "job_not_open" });
    expect(await env.repo.listQuarantineResolutions({ messageId: held.id })).toEqual([]);
  });

  it("never releases a likely forgery (authentication failed) or a delivery report", async () => {
    const env = liveEngine();
    const d = await dealWith(env, [V]);
    const b = d.businesses[0]!;
    const failing = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: { dmarc: "fail", dmarcPolicy: "reject", dmarcFromDomain: "valley.example", spf: "fail", alignedDkimDomains: [] } });
    expect((await vendorReply(env, b, d.token(b.business_id), {}, failing)).outcome).toBe("quarantined:identity_unverified");
    const held = (await env.repo.listMessages(d.jobId)).find((m) => m.direction === "in")!;
    expect(held.quarantine_reason).toBe("identity_unverified:auth_failed");
    expect(await env.engine.releaseQuarantined({ messageId: held.id, verifiedBy: "Dana", how: HOW })).toMatchObject({ ok: false, code: "not_releasable" });
  });

  it("a message that matched no deal needs --job and --business, and only from that business's address on file", async () => {
    const env = liveEngine();
    const d = await dealWith(env, [V]);
    const b = d.businesses[0]!;
    const fresh = (from: string, k: string) => env.engine.ingest({ providerEventId: `ev_${k}`, eventType: "message.received", providerEmailId: `in_${k}`, threadId: null, messageId: `<${k}@mail.gmail.com>`, inReplyTo: [], references: [], from, to: [BUYER], subject: "catering quote", bodyText: "Hi! $1,150 total for 40 people.", attachments: [], attachmentsDownloadUrl: null }, () => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }));
    expect((await fresh(V.email, "u1")).outcome).toBe("quarantined:no_signal");
    expect((await fresh("someone@else.example", "u2")).outcome).toBe("quarantined:no_signal");
    const [fromVendor, fromStranger] = [(await env.repo.findMessageByProviderId("in_u1"))!, (await env.repo.findMessageByProviderId("in_u2"))!];
    expect(await env.engine.releaseQuarantined({ messageId: fromVendor.id, verifiedBy: "Dana", how: HOW })).toMatchObject({ ok: false, code: "needs_target" });
    expect(await env.engine.releaseQuarantined({ messageId: fromStranger.id, verifiedBy: "Dana", how: HOW, jobId: d.jobId, businessId: b.business_id })).toMatchObject({ ok: false, code: "wrong_target" });
    expect(await env.engine.releaseQuarantined({ messageId: fromVendor.id, verifiedBy: "Dana", how: HOW, jobId: d.jobId, businessId: b.business_id })).toMatchObject({ ok: true });
    await env.engine.advanceJob(d.jobId);
    expect((await env.engine.getQuotes(d.jobId)).quotes.map((q) => q.total_usd)).toEqual([1150]);
  });

  it("a suppressed (opted-out) business's held mail stays held", async () => {
    const env = liveEngine();
    const { b, held } = await tokenlessReply(env);
    await env.repo.addSuppression({ contact: b.email!, reason: "opt_out", job_id: null, evidence: "STOP" });
    expect(await env.engine.releaseQuarantined({ messageId: held.id, verifiedBy: "Dana", how: HOW })).toMatchObject({ ok: false, code: "suppressed" });
  });
});

describe("reject", () => {
  it("records the decision and changes nothing; no second decision", async () => {
    const env = liveEngine();
    const { jobId, held } = await tokenlessReply(env);
    expect(await env.engine.rejectQuarantined({ messageId: held.id, by: "Dana", why: "vendor says it never sent this" })).toMatchObject({ ok: true, jobId });
    expect((await env.repo.getMessage(held.id))!).toMatchObject({ kind: "quarantine", sender_trusted: false });
    expect(await env.engine.releaseQuarantined({ messageId: held.id, verifiedBy: "Dana", how: HOW })).toMatchObject({ ok: false, code: "already_resolved" });
    expect(await env.engine.quarantined({ jobId })).toEqual([]);
    expect((await env.engine.quarantined({ jobId, includeResolved: true }))[0]).toMatchObject({ decision: "rejected" });
    // The store refuses a trust flip without a release (the 112 trigger's in-memory twin).
    await expect(env.repo.updateMessage(held.id, { sender_trusted: true, trust_reason: "operator_verified" })).rejects.toThrow(/recorded operator release/);
  });
});

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("quarantine review on Postgres (migration 112)", { timeout: 60_000 }, () => {
  it("release, provenance and the quote, under the database's triggers", async () => {
    const pg = new PostgresRepository(PG_URL!);
    try {
      const env = liveEngine({ repo: pg });
      const { held } = await releaseFlow(env);
      // Append-only, and no trust flip without a release.
      const [res] = await pg.listQuarantineResolutions({ messageId: held.id });
      expect(res).toMatchObject({ decision: "released", original_reason: "identity_unverified:token_missing" });
      await expect((pg as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }).sql`update quarantine_resolutions set resolved_by = 'x' where id = ${res!.id}`).rejects.toThrow(/append-only/);
    } finally {
      await pg.close();
    }
  });

  it("reject, then the database refuses a direct trust flip and a second decision", async () => {
    const pg = new PostgresRepository(PG_URL!);
    try {
      const env = liveEngine({ repo: pg });
      const { held } = await tokenlessReply(env);
      expect(await env.engine.rejectQuarantined({ messageId: held.id, by: "Dana", why: "vendor says it never sent this" })).toMatchObject({ ok: true });
      await expect(pg.updateMessage(held.id, { kind: "reply", sender_trusted: true, trust_reason: "operator_verified" })).rejects.toThrow(/recorded operator release/);
      expect(await env.engine.releaseQuarantined({ messageId: held.id, verifiedBy: "Dana", how: HOW })).toMatchObject({ ok: false, code: "already_resolved" });
      expect(await pg.insertQuarantineResolution({ id: "qr_dup_test", message_id: held.id, job_id: held.job_id, business_id: held.business_id, decision: "rejected", original_reason: "x", original_trust_reason: null, resolved_by: "Dana", verification: "second decision attempt", released_trust_reason: null })).toBeNull();
    } finally {
      await pg.close();
    }
  });
});

