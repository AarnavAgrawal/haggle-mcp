// SIMULATED (sprint 5 A): every purchase stage has a way out, and the must-haves a quote never confirmed
// are confirmed by the vendor before anything is booked. Real engine on the manual pilot rail,
// in-memory store, fake ports; nothing is sent or paid.
import { describe, expect, it } from "vitest";
import { readBookingReply } from "../src/approvals/bookingReply.ts";
import { humanApproves, purchaseEnv, quotedDeal, type PurchaseEnv } from "./helpers/purchaseKit.ts";

const HARBOR = "events@harbor.example";
const GRILL = "orders@grill.example";
const PHONE = "+14155550188";
const HOUR = 3_600_000;

async function twoQuotes(env: PurchaseEnv, harbor = "$2,180 total incl tax, 14 vegetarian, delivered by 11:00, $500 deposit.") {
  return quotedDeal(env, [{ name: "Harbor Table", email: HARBOR, reply: harbor }, { name: "Golden Grill", email: GRILL, reply: "$2,250 total incl tax, 12 vegetarian, delivered by 11:00, $400 deposit." }]);
}

describe("readBookingReply: event day and unconfirmed must-haves", () => {
  const base = { agreedCents: [218_000, 50_000], quantity: 40, eventDate: "2026-11-14" };
  it("another day (any form) is unclear; the event day itself is fine", () => {
    expect(readBookingReply("Confirmed for November 14!", base).intent).toBe("confirm");
    expect(readBookingReply("Confirmed for the 14th of November.", base).intent).toBe("confirm");
    expect(readBookingReply("Confirmed for Nov 15.", base)).toMatchObject({ intent: "unclear", why: expect.stringMatching(/another date \(Nov 15\)/) });
    expect(readBookingReply("Yes, all set for 15 November.", base).intent).toBe("unclear");
    expect(readBookingReply("Confirmed, see you on the 13th.", base).intent).toBe("unclear");
    expect(readBookingReply("Confirmed! Deposit due by Nov 7.", base).intent).toBe("unclear");
  });
  it("a yes must cover each must-have the quote didn't confirm: by name, or 'all of the above'", () => {
    const ctx = { ...base, mustConfirm: ["At least 12 vegetarian meals", "Deliver to 500 Howard St by 11:30"] };
    expect(readBookingReply("Confirmed, all set.", ctx)).toMatchObject({ intent: "unclear", unconfirmedMusts: ["At least 12 vegetarian meals", "Deliver to 500 Howard St by 11:30"] });
    expect(readBookingReply("Confirmed. 12 vegetarian, no problem.", ctx)).toMatchObject({ intent: "unclear", unconfirmedMusts: ["Deliver to 500 Howard St by 11:30"] });
    expect(readBookingReply("Confirmed. 12 vegetarian included. We'll deliver by 11:15.", ctx).intent).toBe("confirm");
    expect(readBookingReply("Yes to all of the above, confirmed.", ctx).intent).toBe("confirm");
    expect(readBookingReply("Confirmed. Only 8 vegetarian though. Delivery by 11.", ctx)).toMatchObject({ intent: "unclear", unconfirmedMusts: ["At least 12 vegetarian meals"] });
  });
});

describe("unconfirmed must-haves block the booking until the vendor confirms them", () => {
  it("the booking request names them; a bare yes stays unbooked and the vendor is asked once; its specific yes books", async () => {
    const env = purchaseEnv();
    // Harbor never said anything about vegetarian meals.
    const d = await twoQuotes(env, "$2,180 total incl tax, delivered by 11:00, $500 deposit.");
    const q = d.quote("Harbor Table");
    expect(d.board.quotes.find((x) => x.quote_id === q.quote_id)!.compliance).toMatchObject({ status: "unconfirmed" });
    const { a } = await humanApproves(env, d.jobId, q.quote_id);
    const ask = env.to(HARBOR).at(-1)!.bodyText;
    expect(ask).toMatch(/Your quote didn't confirm this one, so please confirm it specifically: At least 12 vegetarian meals/);
    expect((await env.mail(d.jobId, HARBOR, "Confirmed, all set for November 14.")).outcome).toBe("booking_unclear");
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("awaiting_vendor_confirmation");
    expect(await env.repo.getHandoffByApproval(a.id)).toBeNull();
    expect(env.to(HARBOR).at(-1)!.bodyText).toMatch(/please confirm you'll meet this must-have: At least 12 vegetarian meals/);
    expect(env.lastToApprover()).toMatch(/hasn't clearly confirmed it yet.*Don't pay yet/);
    // Asked once, however many unclear replies.
    const asks = env.to(HARBOR).length;
    await env.mail(d.jobId, HARBOR, "Yes confirmed!");
    expect(env.to(HARBOR).length).toBe(asks);
    expect((await env.mail(d.jobId, HARBOR, "Yes, 12 vegetarian meals included. Confirmed.")).outcome).toBe("booking_confirmed");
    expect((await env.repo.getHandoffByApproval(a.id))!.status).toBe("instructions_requested");
  });
});

describe("no dead ends after approval", () => {
  it("a vendor that never confirms: after the reminder, approving another quote withdraws the first (the vendor is told) and asks the human", async () => {
    const env = purchaseEnv({ config: { bookingTimeoutMs: HOUR } });
    const d = await twoQuotes(env);
    const { a } = await humanApproves(env, d.jobId, d.quote("Harbor Table").quote_id);
    // Not yet stalled: another approval is refused (the vendor still has time).
    await expect(env.engine.requestApproval(d.jobId, d.quote("Golden Grill").quote_id, "imessage", "pay", { text: true })).rejects.toMatchObject({ code: "not_approvable" });
    env.clock.advance(HOUR + 60_000);
    await env.engine.advanceJob(d.jobId);
    expect((await env.engine.getQuotes(d.jobId)).purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", stalled: true });
    const b = await env.engine.requestApproval(d.jobId, d.quote("Golden Grill").quote_id, "imessage", "pay", { text: true });
    expect(b.status).toBe("pending");
    expect((await env.repo.getApproval(a.id))!.status).toBe("expired");
    expect((await env.repo.getBookingByApproval(a.id))!).toMatchObject({ status: "cancelled", cancel_reason: expect.stringMatching(/didn't confirm/) });
    expect(env.to(HARBOR).at(-1)!.bodyText).toMatch(/gone with another option.*don't hold the booking.*Nothing was paid/s);
    // Harbor's late yes books nothing now.
    await env.mail(d.jobId, HARBOR, "Confirmed, sorry for the delay!");
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("cancelled");
    expect((await env.human(`YES ${b.code}`)).outcome).toBe("approved");
    expect((await env.repo.getBookingByApproval(b.id))!.status).toBe("awaiting_vendor_confirmation");
  });

  it("a handoff the payment checks refused (cap lowered after approval) can be approved again once fixed, without telling the vendor to drop it", async () => {
    const env = purchaseEnv();
    const d = await twoQuotes(env);
    const q = d.quote("Harbor Table");
    const { a } = await humanApproves(env, d.jobId, q.quote_id);
    await env.engine.updateSettings({ spending_cap_cents: 10_000 });
    expect((await env.mail(d.jobId, HARBOR, "Confirmed for November 14.")).outcome).toBe("booking_confirmed");
    expect((await env.engine.getQuotes(d.jobId)).purchase).toMatchObject({ stage: "handoff_refused" });
    await env.engine.updateSettings({ spending_cap_cents: 250_000 });
    const sent = env.to(HARBOR).length;
    const again = await env.engine.requestApproval(d.jobId, q.quote_id, "imessage", "pay", { text: true });
    expect(again.id).not.toBe(a.id);
    expect(env.to(HARBOR).slice(sent).some((e) => /don't hold/.test(e.bodyText))).toBe(false);
    expect((await env.human(`YES ${again.code}`)).outcome).toBe("approved");
    expect(env.to(HARBOR).at(-1)!.bodyText).toMatch(/Before anything is booked or paid/);
  });

  it("a phone vendor the human never confirms: one reminder to the human, operator-visible; then another quote can be approved", async () => {
    const env = purchaseEnv({ phone: true, config: { bookingTimeoutMs: HOUR } });
    const d = await quotedDeal(env, [
      { name: "Mission Eats", phone: PHONE, channel: "phone", reply: "We can do $1,700 total all-in, 14 vegetarian, delivered by 11:00, with a $300 deposit." },
      { name: "Golden Grill", email: GRILL, reply: "$2,250 total incl tax, 12 vegetarian, delivered by 11:00, $400 deposit." },
    ]);
    const { a } = await humanApproves(env, d.jobId, d.quote("Mission Eats").quote_id);
    env.clock.advance(HOUR + 60_000);
    await env.engine.advanceJob(d.jobId);
    await env.engine.advanceJob(d.jobId);
    expect((await env.events(d.jobId, "operator_attention")).filter((e) => e.data.reason === "booking_unattested")).toHaveLength(1);
    expect(env.lastToApprover()).toMatch(/still needs you: confirm it with them directly and reply BOOKED \d{4}/);
    const b = await env.engine.requestApproval(d.jobId, d.quote("Golden Grill").quote_id, "imessage", "pay", { text: true });
    expect(b.status).toBe("pending");
    expect((await env.repo.getApproval(a.id))!.status).toBe("expired");
    expect((await env.human(`BOOKED ${a.code}`)).outcome).not.toBe("booking_confirmed");
  });

  it("cancelling a confirm-only order before the vendor's yes closes its booking and tells the vendor not to hold it", async () => {
    const env = purchaseEnv();
    const d = await twoQuotes(env);
    const { a } = await humanApproves(env, d.jobId, d.quote("Harbor Table").quote_id, "confirm");
    expect((await env.engine.cancel(d.jobId)).state).toBe("cancelled");
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("cancelled");
    expect((await env.repo.getApproval(a.id))!.status).toBe("expired");
    expect(env.to(HARBOR).at(-1)!.bodyText).toMatch(/please don't hold the booking/);
    expect(env.to(GRILL).at(-1)!.bodyText).toMatch(/Thank you for your quote/);
  });

  it("cancelling an order the vendor already confirmed says how (contact the vendor), sending nothing", async () => {
    const env = purchaseEnv();
    const d = await twoQuotes(env);
    await humanApproves(env, d.jobId, d.quote("Harbor Table").quote_id, "confirm");
    expect((await env.mail(d.jobId, HARBOR, "Confirmed for November 14.")).outcome).toBe("order_confirmed");
    const sent = env.emails.length;
    await expect(env.engine.cancel(d.jobId)).rejects.toMatchObject({ code: "cannot_cancel", fix: expect.stringMatching(/contact Harbor Table directly/) });
    expect(env.emails.length).toBe(sent);
  });
});
