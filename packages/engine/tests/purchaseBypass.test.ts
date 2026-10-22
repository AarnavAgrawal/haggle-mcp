// SIMULATED (sprint 5 A): every way around "the vendor confirmed the booking" we could think of, on the
// manual pilot rail. A deal counts as booked, and a payment handoff starts, only after the vendor's own
// written yes from a verified sender, or the approver's BOOKED <code> after checking with the vendor
// directly (a thread-only email, or a vendor Haggle can't get a written answer from). Real engine,
// in-memory store, fake ports; nothing is sent or paid.
import { describe, expect, it } from "vitest";
import { PostgresRepository } from "../src/store/postgres.ts";
import type { Repository } from "../src/store/types.ts";
import { humanApproves, purchaseEnv, quotedDeal, type PurchaseEnv } from "./helpers/purchaseKit.ts";

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;

const HARBOR = "events@harbor.example";
const GRILL = "orders@grill.example";
const PHONE = "+14155550188";
const CLEAN = "$2,180 total incl tax, 14 vegetarian, delivered by 11:00, $500 deposit.";
/** Outside mail is accepted on Haggle's reply token alone (continuity, not identity). */
const THREAD = { config: { externalSenders: "reply_token" as const, replyTokenSecret: "purchase-bypass-reply-token-secret-0123456789" } };

async function approvedHarbor(env: PurchaseEnv, trust: "verified" | "thread" = "verified") {
  const d = await quotedDeal(env, [{ name: "Harbor Table", email: HARBOR, reply: CLEAN, trust }, { name: "Golden Grill", email: GRILL, reply: "$2,250 total incl tax, 12 vegetarian, delivered by 11:00, $400 deposit." }]);
  const q = d.quote("Harbor Table");
  const { a, outcome } = await humanApproves(env, d.jobId, q.quote_id);
  expect(outcome).toBe("approved");
  return { ...d, q, a };
}
const handoff = (env: PurchaseEnv, approvalId: string) => env.repo.getHandoffByApproval(approvalId);

describe("bypass attempts: nothing is booked or handed off without the vendor's (or the attesting human's) confirmation", () => {
  it("pay before the human approves starts nothing; pay after approval only reports the stage", async () => {
    const env = purchaseEnv();
    const d = await quotedDeal(env, [{ name: "Harbor Table", email: HARBOR, reply: CLEAN }, { name: "Golden Grill", email: GRILL, reply: "$2,250 total incl tax, 12 vegetarian, delivered by 11:00, $400 deposit." }]);
    // Haggle texted its own suggestion (Harbor): Golden Grill has no approval at all, and Harbor's isn't decided.
    await expect(env.engine.pay(d.jobId, d.quote("Golden Grill").quote_id)).rejects.toMatchObject({ code: "no_approval" });
    expect(await env.engine.pay(d.jobId, d.quote("Harbor Table").quote_id)).toMatchObject({ status: "awaiting_approval" });
    expect((await env.repo.getJob(d.jobId))!.state).toBe("awaiting_approval");
    const { a } = await humanApproves(env, d.jobId, d.quote("Harbor Table").quote_id);
    const line = await env.engine.pay(d.jobId, d.quote("Harbor Table").quote_id);
    expect(line).toMatchObject({ status: "awaiting_vendor_confirmation", rail: "manual" });
    expect(await handoff(env, a.id)).toBeNull();
  });

  it("PAID before the vendor confirmed records nothing and doesn't tell the vendor", async () => {
    const env = purchaseEnv();
    const { jobId, a } = await approvedHarbor(env);
    const sent = env.to(HARBOR).length;
    expect((await env.human(`PAID ${a.code}`)).outcome).toBe("paid_before_booking");
    expect(await handoff(env, a.id)).toBeNull();
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
    expect(env.to(HARBOR).length).toBe(sent);
  });

  it("another vendor on the same deal saying 'confirmed' never books the approved vendor", async () => {
    const env = purchaseEnv();
    const { jobId, a } = await approvedHarbor(env);
    await env.mail(jobId, GRILL, "Confirmed! All set, all of the above.");
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("awaiting_vendor_confirmation");
    expect(await handoff(env, a.id)).toBeNull();
  });

  it("a thread-only 'confirmed' waits for BOOKED <code> from the approver's own phone; a wrong code or another number changes nothing", async () => {
    const env = purchaseEnv(THREAD);
    const { jobId, a } = await approvedHarbor(env, "thread");
    expect((await env.mail(jobId, HARBOR, "Confirmed, all set. Zelle pay@harbor.example for the deposit.", "thread")).outcome).toBe("booking_unverified");
    expect(await handoff(env, a.id)).toBeNull();
    expect((await env.human(`PAID ${a.code}`)).outcome).toBe("paid_before_booking");
    const wrong = a.code === "1111" ? "2222" : "1111";
    expect((await env.human(`BOOKED ${wrong}`)).outcome).toBe("booked_no_match");
    expect((await env.vendorText("+14155550999", `BOOKED ${a.code}`)).outcome).not.toBe("booking_confirmed");
    expect(await handoff(env, a.id)).toBeNull();
    expect((await env.human(`BOOKED ${a.code}`)).outcome).toBe("booking_confirmed");
    expect((await handoff(env, a.id))!.status).toBe("instructions_received");
  });

  it("a vendor Haggle can't get a written answer from (phone): no handoff until the approver's BOOKED <code>; PAID before that records nothing", async () => {
    await phoneVendorNeedsBooked();
  });

  it("a confirm-only order by a thread-only email isn't confirmed until BOOKED <code>", async () => {
    const env = purchaseEnv(THREAD);
    const d = await quotedDeal(env, [{ name: "Harbor Table", email: HARBOR, reply: CLEAN, trust: "thread" }]);
    const { a } = await humanApproves(env, d.jobId, d.quote("Harbor Table").quote_id, "confirm");
    expect((await env.mail(d.jobId, HARBOR, "Confirmed, we're all set.", "thread")).outcome).toBe("booking_unverified");
    expect((await env.repo.getJob(d.jobId))!.state).toBe("paying");
    expect((await env.human(`BOOKED ${a.code}`)).outcome).toBe("order_confirmed");
    expect((await env.repo.getJob(d.jobId))!.state).toBe("confirmed");
  });

  it("a 'confirmed' after the approval was withdrawn (a void that lost a race) books nothing", async () => {
    const env = purchaseEnv();
    const { jobId, a } = await approvedHarbor(env);
    // The approval is expired but the job is still `paying` (its approval_void transition never committed).
    await env.repo.transitionApproval(a.id, "approved", { status: "expired" });
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
    await env.mail(jobId, HARBOR, "Confirmed, all set for November 14.");
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("awaiting_vendor_confirmation");
    expect(await handoff(env, a.id)).toBeNull();
  });

  it("the same confirmation delivered twice (webhook retry) books once and asks once", async () => {
    const env = purchaseEnv();
    const { jobId, a } = await approvedHarbor(env);
    const ours = (await env.repo.listMessages(jobId)).filter((m) => m.direction === "out" && m.to_address === HARBOR).at(-1)!;
    const msg = { providerEventId: "ev_dup", eventType: "message.received", providerEmailId: "in_dup", threadId: "th", messageId: "<dup@mail.example>", inReplyTo: [ours.rfc_message_id!], references: [ours.rfc_message_id!], from: HARBOR, to: ["haggle@inkboxmail.test"], subject: `Re: ${ours.subject}`, bodyText: "Confirmed, all set for November 14.", attachments: [], attachmentsDownloadUrl: null };
    const trust = (address: string) => ({ trusted: true, address, reason: "inkbox-same-org", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }) as never;
    expect((await env.engine.ingest(msg, trust)).outcome).toBe("booking_confirmed");
    const asks = env.to(HARBOR).length;
    expect((await env.engine.ingest(msg, trust)).outcome).toBe("duplicate");
    expect(env.to(HARBOR).length).toBe(asks);
    expect((await env.events(jobId, "booking")).filter((e) => e.data.status === "confirmed")).toHaveLength(1);
    expect((await handoff(env, a.id))!.status).toBe("instructions_requested");
  });

  it("a duplicate YES approves once and sends one booking request", async () => {
    const env = purchaseEnv();
    const { a } = await approvedHarbor(env);
    const requests = env.to(HARBOR).filter((e) => /Before anything is booked or paid/.test(e.bodyText)).length;
    expect(requests).toBe(1);
    expect((await env.human(`YES ${a.code}`)).outcome).not.toBe("approved");
    expect(env.to(HARBOR).filter((e) => /Before anything is booked or paid/.test(e.bodyText))).toHaveLength(1);
  });

  it("a 'confirmed' naming another day is unclear, never a booking", async () => {
    const env = purchaseEnv();
    const { jobId, a } = await approvedHarbor(env);
    expect((await env.mail(jobId, HARBOR, "Confirmed! See you on November 15.")).outcome).toBe("booking_unclear");
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("awaiting_vendor_confirmation");
    expect((await env.mail(jobId, HARBOR, "Sorry, typo: confirmed for November 14.")).outcome).toBe("booking_confirmed");
  });
});

/** A phone vendor (not in writing): nothing is handed off before the approver's BOOKED <code>. Unique numbers per run (Postgres is shared). */
async function phoneVendorNeedsBooked(repo?: Repository) {
  const u = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  const env = purchaseEnv({ phone: true, ...(repo ? { repo, approver: `+1415${u}` } : {}) });
  const phone = repo ? `+1628${u}` : PHONE;
  const d = await quotedDeal(env, [{ name: "Mission Eats", phone, channel: "phone", reply: "We can do $1,700 total all-in, 14 vegetarian, delivered by 11:00, with a $300 deposit." }]);
  const q = d.quote("Mission Eats");
  expect(q.total_usd).toBe(1700);
  const { a } = await humanApproves(env, d.jobId, q.quote_id);
  // The approval text asks for BOOKED once they've checked with the vendor, never "pay now".
  expect(env.lastToApprover()).toMatch(/confirm the booking with them directly.*reply BOOKED \d{4}.*Don't pay before that/);
  expect(await handoff(env, a.id)).toBeNull();
  expect((await env.engine.getQuotes(d.jobId)).purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false });
  expect((await env.human(`PAID ${a.code}`)).outcome).toBe("paid_before_booking");
  expect((await env.repo.getJob(d.jobId))!.state).toBe("paying");
  // The approver checked with Mission Eats by phone and accepts it.
  expect((await env.human(`BOOKED ${a.code}`)).outcome).toBe("booking_confirmed");
  expect(env.lastToApprover()).toMatch(/accepted the booking with Mission Eats.*reply PAID \d{4}/);
  expect((await handoff(env, a.id))!.status).toBe("instructions_requested");
  expect((await env.engine.getQuotes(d.jobId)).purchase).toMatchObject({ stage: "instructions_requested", booked_by_human: true, money_verified: false });
  // A second BOOKED changes nothing; PAID now records the customer's report.
  expect((await env.human(`BOOKED ${a.code}`)).outcome).toBe("booked_already");
  expect((await env.human(`PAID ${a.code}`)).outcome).toBe("handoff_confirmed");
}

describe.skipIf(!PG_URL)("on Postgres (migration 118's trigger enforces the same rule)", { timeout: 60_000 }, () => {
  it("a phone vendor's booking needs the approver's BOOKED <code> before any handoff", async () => {
    const repo = new PostgresRepository(PG_URL!);
    try {
      await phoneVendorNeedsBooked(repo);
    } finally {
      await repo.close();
    }
  });
});
