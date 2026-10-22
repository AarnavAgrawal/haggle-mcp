// SIMULATED end-to-end purchases on the manual pilot rail (sprint 5 A): a catering need, real-format
// vendor replies, the comparison, the human's coded text approval, the vendor's written booking
// confirmation, the customer paying the vendor directly. One scenario per way a real purchase goes.
// Real engine in live mode, in-memory store, fake email/SMS ports, deterministic extractor; nothing is
// sent, booked or paid for real.
import { describe, expect, it } from "vitest";
import { humanApproves, purchaseEnv, quotedDeal, type PurchaseEnv } from "./helpers/purchaseKit.ts";

const HARBOR = "events@harbor.example";
const GRILL = "orders@grill.example";
const HOUR = 3_600_000;
const HARBOR_QUOTE = "Hi! For Nov 14: $2,180 total incl tax, 14 vegetarian, delivered by 11:00. $500 deposit to hold the date.";
const GRILL_QUOTE = "$2,250 total incl tax, 12 vegetarian, delivered by 11:00, $400 deposit.";

async function compared(env: PurchaseEnv, harbor = HARBOR_QUOTE) {
  const d = await quotedDeal(env, [{ name: "Harbor Table", email: HARBOR, reply: harbor }, { name: "Golden Grill", email: GRILL, reply: GRILL_QUOTE }]);
  return { ...d, harbor: d.quote("Harbor Table"), grill: d.quote("Golden Grill") };
}
const stage = async (env: PurchaseEnv, jobId: string) => (await env.engine.getQuotes(jobId)).purchase;
const bookingAsks = (env: PurchaseEnv, to: string) => env.to(to).filter((e) => /Before anything is booked or paid/.test(e.bodyText));

describe("SIMULATED purchase scenarios (manual rail)", () => {
  it("successful purchase: compare → approve by text → vendor confirms in writing → instructions → customer pays directly → PAID → vendor confirms receipt", async () => {
    const env = purchaseEnv();
    const d = await compared(env);
    expect(d.board.recommended_quote_id).toBe(d.harbor.quote_id);
    expect(d.harbor.selection).toMatchObject({ status: "recommended" });
    const { a, outcome } = await humanApproves(env, d.jobId, d.harbor.quote_id);
    expect(outcome).toBe("approved");
    expect(bookingAsks(env, HARBOR)).toHaveLength(1);
    expect(await stage(env, d.jobId)).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false });
    expect((await env.mail(d.jobId, HARBOR, "Confirmed for Nov 14, all set! For the $500 deposit please Zelle payments@harbor.example.")).outcome).toBe("booking_confirmed");
    expect(await stage(env, d.jobId)).toMatchObject({ stage: "instructions_received", booked: true, money_verified: false, instructions: { untrusted: true, has_link: false } });
    expect(env.lastToApprover()).toMatch(/Pay them \$500 directly; then reply PAID \d{4}/);
    expect((await env.human(`PAID ${a.code}`)).outcome).toBe("handoff_confirmed");
    expect((await env.repo.getJob(d.jobId))!.state).toBe("paid");
    expect(await stage(env, d.jobId)).toMatchObject({ stage: "human_reported_paid", money_verified: false });
    expect(env.to(HARBOR).at(-1)!.bodyText).toMatch(/The customer has told us they have paid the \$500\.00 directly to you/);
    expect((await env.mail(d.jobId, HARBOR, "Got the deposit, thanks! See you on the 14th.")).outcome).toBe("receipt_confirmed");
    expect(await stage(env, d.jobId)).toMatchObject({ stage: "settled_verified", money_verified: true });
    expect(env.to(GRILL).some((e) => /accepted your quote/.test(e.bodyText))).toBe(false);
  });

  it("vendor declines after acceptance: approval withdrawn, nothing paid; the human approves the runner-up, which gets its own booking request", async () => {
    const env = purchaseEnv();
    const d = await compared(env);
    const { a } = await humanApproves(env, d.jobId, d.harbor.quote_id);
    expect((await env.mail(d.jobId, HARBOR, "So sorry, we just took a wedding that day and can't do it after all.")).outcome).toBe("booking_declined");
    expect((await env.repo.getApproval(a.id))!.status).toBe("expired");
    expect(await stage(env, d.jobId)).toMatchObject({ stage: "booking_declined", booked: false });
    expect(env.lastToApprover()).toMatch(/can't take the booking after all.*nothing was paid/);
    expect((await env.human(`PAID ${a.code}`)).outcome).not.toBe("handoff_confirmed");
    const { outcome } = await humanApproves(env, d.jobId, d.grill.quote_id);
    expect(outcome).toBe("approved");
    expect(bookingAsks(env, GRILL)).toHaveLength(1);
  });

  it("vendor never confirms: one reminder, the human told not to pay, operator-visible; cancelling tells the vendor not to hold it", async () => {
    const env = purchaseEnv({ config: { bookingTimeoutMs: 24 * HOUR } });
    const d = await compared(env);
    const { a } = await humanApproves(env, d.jobId, d.harbor.quote_id);
    env.clock.advance(25 * HOUR);
    await env.engine.advanceJob(d.jobId);
    expect(env.to(HARBOR).at(-1)!.bodyText).toMatch(/can you confirm the booking/);
    expect(env.lastToApprover()).toMatch(/hasn't confirmed the booking yet.*Don't pay/);
    expect((await env.events(d.jobId, "operator_attention")).map((e) => e.data.reason)).toContain("booking_unconfirmed");
    expect(await stage(env, d.jobId)).toMatchObject({ stage: "awaiting_vendor_confirmation", stalled: true, next: expect.stringMatching(/don't pay/) });
    expect((await env.engine.cancel(d.jobId)).state).toBe("cancelled");
    expect(env.to(HARBOR).at(-1)!.bodyText).toMatch(/cancelled this order before paying.*No payment was made/s);
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("cancelled");
  });

  it("stale quote: approving it asks the vendor first; its 'still stands' sends the approval to the human; then the normal booking", async () => {
    const env = purchaseEnv();
    const d = await compared(env, `${HARBOR_QUOTE} Quote valid until 2026-10-24.`);
    env.clock.advance(3 * 24 * HOUR);
    await expect(env.engine.requestApproval(d.jobId, d.harbor.quote_id, "imessage", "pay", { text: true })).rejects.toMatchObject({ code: "quote_reconfirming", next: "wait_for_update" });
    expect(env.to(HARBOR).at(-1)!.bodyText).toMatch(/could you confirm that your quote of \$2,180 total.*still stands/s);
    expect((await env.engine.getQuotes(d.jobId)).quotes.find((q) => q.quote_id === d.harbor.quote_id)!.selection).toMatchObject({ status: "not_selectable", reason: expect.stringMatching(/stale.*re-confirmation requested/) });
    expect((await env.mail(d.jobId, HARBOR, "Yes, confirmed, that quote still stands.")).outcome).toBe("quote_reconfirmed");
    await env.engine.advanceJob(d.jobId);
    const a = (await env.repo.getLatestApproval(d.jobId))!;
    expect(a).toMatchObject({ status: "pending", quote_id: d.harbor.quote_id });
    expect((await env.human(`YES ${a.code}`)).outcome).toBe("approved");
    expect(bookingAsks(env, HARBOR)).toHaveLength(1);
  });

  it("requirement unconfirmed: the human approves knowingly (caveat shown), and the vendor must confirm it before anything is booked", async () => {
    const env = purchaseEnv();
    const d = await compared(env, "$2,180 total incl tax, delivered by 11:00, $500 deposit.");
    expect(await env.engine.approvalCaveats(d.jobId, d.harbor.quote_id)).toContain("Not confirmed by the business: At least 12 vegetarian meals");
    const { a } = await humanApproves(env, d.jobId, d.harbor.quote_id);
    expect((await env.mail(d.jobId, HARBOR, "Confirmed, see you on Nov 14!")).outcome).toBe("booking_unclear");
    expect(await stage(env, d.jobId)).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false });
    expect((await env.mail(d.jobId, HARBOR, "Only 8 vegetarian, sorry. Otherwise confirmed.")).outcome).toBe("booking_unclear");
    expect(await env.repo.getHandoffByApproval(a.id)).toBeNull();
    expect((await env.mail(d.jobId, HARBOR, "Update: we can do 12 vegetarian meals. Confirmed.")).outcome).toBe("booking_confirmed");
  });

  it("approver refuses (NO <code>): nothing is booked, the vendor isn't asked, pay is refused, the deal goes back to choosing", async () => {
    const env = purchaseEnv();
    const d = await compared(env);
    const a = await env.engine.requestApproval(d.jobId, d.harbor.quote_id, "imessage", "pay", { text: true });
    expect((await env.human(`NO ${a.code}`)).outcome).toMatch(/declined/);
    expect((await env.repo.getApproval(a.id))!.status).toBe("declined");
    expect(bookingAsks(env, HARBOR)).toHaveLength(0);
    expect(await env.repo.getBookingByApproval(a.id)).toBeNull();
    await expect(env.engine.pay(d.jobId, d.harbor.quote_id)).rejects.toMatchObject({ code: "approval_declined" });
    expect(["collecting", "negotiating"]).toContain((await env.repo.getJob(d.jobId))!.state);
  });

  it("customer cancels mid-booking (vendor confirmed, not yet paid): the vendor hears no payment was made; a later PAID records nothing", async () => {
    const env = purchaseEnv();
    const d = await compared(env);
    const { a } = await humanApproves(env, d.jobId, d.harbor.quote_id);
    expect((await env.mail(d.jobId, HARBOR, "Confirmed for Nov 14. Zelle payments@harbor.example for the deposit.")).outcome).toBe("booking_confirmed");
    expect((await env.engine.cancel(d.jobId)).state).toBe("cancelled");
    expect(env.to(HARBOR).at(-1)!.bodyText).toMatch(/cancelled this order before paying.*No payment was made or sent through Haggle/s);
    expect(env.to(GRILL).at(-1)!.bodyText).toMatch(/Thank you for your quote/);
    expect((await env.repo.getHandoffByApproval(a.id))!.status).toBe("cancelled");
    expect((await env.human(`PAID ${a.code}`)).outcome).not.toBe("handoff_confirmed");
    expect(await stage(env, d.jobId)).toMatchObject({ stage: "cancelled", booked: false });
  });

  it("payment reported, then the vendor no-shows: Haggle never claims a refund; the human is told to contact the vendor and the operator is flagged", async () => {
    const env = purchaseEnv();
    const d = await compared(env);
    const { a } = await humanApproves(env, d.jobId, d.harbor.quote_id);
    await env.mail(d.jobId, HARBOR, "Confirmed for Nov 14. Zelle payments@harbor.example for the deposit.");
    expect((await env.human(`PAID ${a.code}`)).outcome).toBe("handoff_confirmed");
    // The vendor goes quiet, then backs out after the customer paid.
    env.clock.advance(5 * 24 * HOUR);
    await env.engine.advanceJob(d.jobId);
    expect(await stage(env, d.jobId)).toMatchObject({ stage: "human_reported_paid", money_verified: false });
    expect((await env.mail(d.jobId, HARBOR, "Unfortunately we can't make it on the 14th anymore.")).outcome).toBe("operator_attention");
    expect(env.lastToApprover()).toMatch(/can't do it after you reported paying.*can't reverse or refund.*operator was flagged/);
    // The customer asks to cancel: nothing is sent to the vendor, nothing is promised.
    const sent = env.to(HARBOR).length;
    const r = await env.engine.cancel(d.jobId);
    expect(r).toMatchObject({ state: "paid", flagged: true, note: expect.stringMatching(/can't cancel or refund it: contact Harbor Table/) });
    expect(env.to(HARBOR).length).toBe(sent);
    expect((await env.events(d.jobId, "operator_attention")).map((e) => e.data.reason)).toEqual(expect.arrayContaining(["business_withdrew_after_reported_payment", "cancel_after_reported_payment"]));
    expect(await stage(env, d.jobId)).toMatchObject({ stage: "cancel_requested_after_payment", money_verified: false });
    for (const e of env.emails) expect(e.bodyText).not.toMatch(/refund/i);
  });
});
