// Unverified external senders must never silently confirm binding financial terms. A reply proven
// only by the reply token (or an operator release) is "thread_only" (inbound/trustStrength.ts
// bindingTermsTrust). Today's booking hook (engine.ingestPurchaseReply, workstream B) still treats
// it like an authenticated sender for the booking confirmation and the "payment received" receipt;
// the two `it.fails` below pin that gap (they pass while it exists) and flip to `it` once B wires
// bindingTermsTrustFor(trustReason) into the hook. Real engine, fakes, no network.
import { describe, expect, it } from "vitest";
import { bindingTermsTrustFor } from "../src/inbound/trustStrength.ts";
import type { TrustVerdict } from "../src/inbound/types.ts";
import { APPROVER, dealWith, liveEngine, vendorReply } from "./helpers/liveEngine.ts";

const V = { name: "Real Caterer", email: "orders@realcaterer.example" };
const authenticated = (e: string): TrustVerdict => ({ trusted: true, address: e, reason: "trusted", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });

async function approvedManualDeal(trustQuote?: (e: string) => TrustVerdict) {
  const env = liveEngine({ config: { manualPaymentHandoff: true } });
  const d = await dealWith(env, [V]);
  const b = d.businesses[0]!;
  const reply = (body: string, trust?: (e: string) => TrustVerdict) => vendorReply(env, { email: V.email, rfq_message_id: b.rfq_message_id }, d.token(b.business_id), { bodyText: body }, trust);
  await reply("We can do it: $1,150 total, delivered. $345 deposit.", trustQuote);
  await env.engine.advanceJob(d.jobId);
  const q = (await env.engine.getQuotes(d.jobId)).quotes[0]!;
  const a = await env.engine.requestApproval(d.jobId, q.quote_id, "imessage");
  await env.engine.ingestText({ messageId: `yes_${a.id}`, from: APPROVER, text: `YES ${a.code}`, inbound: true });
  return { env, jobId: d.jobId, a, reply };
}

describe("bindingTermsTrustFor: the check the booking hook must make", () => {
  it("thread-only senders need the human's acknowledgement; authenticated ones don't", () => {
    expect(bindingTermsTrustFor("external-reply-token")).toMatchObject({ senderIdentity: "thread_only", mayConfirmBooking: false, requiresHumanAck: true, mayVerifySettlement: false, mayNamePayee: false });
    expect(bindingTermsTrustFor("operator_verified")).toMatchObject({ senderIdentity: "thread_only", requiresHumanAck: true });
    expect(bindingTermsTrustFor("trusted")).toMatchObject({ senderIdentity: "verified", mayConfirmBooking: true, mayVerifySettlement: true });
    expect(bindingTermsTrustFor("inkbox-org-identity")).toMatchObject({ senderIdentity: "verified" });
  });
});

describe("booking and receipt from a reply-token-only sender (workstream B hook)", () => {
  it("control: an authenticated sender's confirmation books the deal", async () => {
    const { env, jobId, reply } = await approvedManualDeal();
    expect((await reply("Confirmed, we're all set for your event.", authenticated)).outcome).toBe("booking_confirmed");
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "booking" && e.data.status === "confirmed")).toBe(true);
  });

  it("a token-only 'Confirmed' must not mark the booking confirmed without the human acknowledging it (records sender_identity thread_only)", async () => {
    const { env, jobId, reply } = await approvedManualDeal();
    await reply("Confirmed, we're all set for your event.");
    const confirmed = (await env.repo.listEvents(jobId)).find((e) => e.type === "booking" && e.data.status === "confirmed");
    // Desired: not confirmed until the human acknowledges, or at least recorded as thread_only with the warning.
    expect(confirmed === undefined || confirmed.data.sender_identity === "thread_only").toBe(true);
  });

  it("a token-only 'payment received' must not make a manual payment settled_verified", async () => {
    const { env, jobId, a, reply } = await approvedManualDeal();
    await reply("Confirmed, we're all set for your event.", authenticated);
    await reply("Pay by card on pickup.", authenticated);
    await env.engine.ingestText({ messageId: `paid_${a.id}`, from: APPROVER, text: `PAID ${a.code}`, inbound: true });
    await reply("Payment received, thank you!");
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "payment" && e.data.status === "settled_verified")).toBe(false);
  });
});
