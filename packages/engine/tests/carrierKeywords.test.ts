// SIMULATED: carrier opt-out keywords vs Haggle's coded text commands (2026-10-22). Carriers and SMS
// providers commonly treat a text that is exactly STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT
// or REVOKE as an opt-out and block further texts to that number (CTIA; provider-dependent: confirm on
// Inkbox's line, docs/carrier-keywords.md). Haggle's commands always carry a code ("CANCEL 482913"),
// so they are never a bare keyword; these tests pin what happens when someone sends the bare word.
//   - A vendor's bare keyword opts it out like STOP (before: only STOP/UNSUBSCRIBE did; CANCEL, END,
//     QUIT were read as an ordinary reply while the carrier may already block texts to it).
//   - The approver's bare keyword: Haggle texts them nothing more (held, re-sent when they text again,
//     e.g. START), the deal and the operator are told. Before: Haggle replied and kept texting.
import { describe, expect, it } from "vitest";
import { isCarrierOptOut } from "../src/inbound/senderAuth.ts";
import { humanApproves, purchaseEnv, quotedDeal, type PurchaseEnv } from "./helpers/purchaseKit.ts";

const HARBOR = "events@harbor.example";
async function compared(env: PurchaseEnv) {
  const d = await quotedDeal(env, [{ name: "Harbor Table", email: HARBOR, reply: "Hi! For Nov 14: $2,180 total incl tax, 14 vegetarian, delivered by 11:00. $500 deposit to hold the date." }, { name: "Golden Grill", email: "orders@grill.example", reply: "$2,250 total incl tax, 12 vegetarian, delivered by 11:00, $400 deposit." }]);
  return { ...d, harbor: d.quote("Harbor Table") };
}

describe("isCarrierOptOut: only the bare standard keywords", () => {
  it("matches each keyword alone (any case, trailing punctuation)", () => {
    for (const w of ["STOP", "stop", "Stop.", "STOPALL", "stop all", "UNSUBSCRIBE", "CANCEL", "cancel!", "END", "QUIT", "OPTOUT", "opt out", "REVOKE"]) expect(isCarrierOptOut(w), w).toBe(true);
  });
  it("never matches Haggle's coded commands or ordinary sentences", () => {
    for (const w of ["CANCEL 482913", "cancel 482913", "YES 4821", "BOOKED 4821", "PAID 4821", "CALL 482913", "START", "YES", "HELP", "Cancel 2 of the trays please", "we can't end before 5", "stop by at noon?"]) expect(isCarrierOptOut(w), w).toBe(false);
  });
});

describe("a text vendor's bare carrier keyword is an opt-out", () => {
  for (const word of ["CANCEL", "END", "QUIT", "STOPALL"]) {
    it(`"${word}" from a text vendor's number suppresses it and stops contact`, async () => {
      const env = purchaseEnv();
      const VENDOR = "+14155550199";
      const deal = await env.engine.deal({ request: { what: "team lunch catering", quantity: 40, unit: "people", date: "2026-11-14", area: "San Francisco, CA" } as never, budget_usd: 2500, businesses: [{ name: "Sunset Kitchen", phone: VENDOR, channel: "imessage" }] });
      expect((await env.vendorText(VENDOR, word)).outcome).toBe("opted_out");
      expect((await env.repo.findSuppressions([VENDOR])).length).toBe(1);
      expect((await env.repo.getBusinesses(deal.job_id))[0]!.status).toBe("declined");
    });
  }
});

describe("the approver's bare carrier keyword", () => {
  it("STOP: no reply is texted; later texts are held and re-sent after they text START; the deal and the operator are told", async () => {
    const env = purchaseEnv();
    const d = await compared(env);
    await humanApproves(env, d.jobId, d.harbor.quote_id);
    const before = env.toApprover().length;
    expect((await env.human("STOP")).outcome).toBe("approver_opted_out");
    expect(env.toApprover()).toHaveLength(before);
    const events = await env.events(d.jobId);
    expect(events.some((e) => e.type === "operator_attention" && e.data.reason === "approver_carrier_opt_out")).toBe(true);
    expect(events.some((e) => e.type === "reply" && /texted STOP/.test(String(e.data.summary)))).toBe(true);
    // The vendor confirms: the human's update is held, not texted.
    expect((await env.mail(d.jobId, HARBOR, "Confirmed for Nov 14. Zelle payments@harbor.example for the deposit.")).outcome).toBe("booking_confirmed");
    expect(env.toApprover()).toHaveLength(before);
    // They opt back in: what they missed is re-sent.
    await env.human("START");
    expect(env.toApprover().length).toBeGreaterThan(before);
    expect(env.lastToApprover()).toMatch(/Harbor/);
  });

  it("a bare CANCEL (no code) cancels nothing and isn't answered by text", async () => {
    const env = purchaseEnv();
    const d = await compared(env);
    await humanApproves(env, d.jobId, d.harbor.quote_id);
    await env.mail(d.jobId, HARBOR, "Confirmed for Nov 14. Zelle payments@harbor.example for the deposit.");
    const before = env.toApprover().length;
    expect((await env.human("CANCEL")).outcome).toBe("approver_opted_out");
    expect((await env.repo.getJob(d.jobId))!.state).toBe("paying");
    expect(env.toApprover()).toHaveLength(before);
  });
});

describe("the vendor holding the approved booking texts a bare opt-out", () => {
  it("the human is told Haggle can no longer text them and not to pay before checking directly", async () => {
    const env = purchaseEnv();
    const VENDOR = "+14155550198";
    const deal = await env.engine.deal({ request: { what: "team lunch catering", quantity: 40, unit: "people", date: "2026-11-14", area: "San Francisco, CA" } as never, budget_usd: 2500, businesses: [{ name: "Sunset Kitchen", phone: VENDOR, channel: "imessage" }] });
    env.clock.advance(5 * 60_000);
    await env.vendorText(VENDOR, "We can do it: $1,900 total incl tax, delivered by 11:00, $400 deposit.");
    env.clock.advance(31 * 60_000);
    await env.engine.advanceJob(deal.job_id);
    const q = (await env.engine.getQuotes(deal.job_id)).quotes[0]!;
    await humanApproves(env, deal.job_id, q.quote_id);
    expect((await env.vendorText(VENDOR, "QUIT")).outcome).toBe("opted_out");
    expect(env.lastToApprover()).toMatch(/Sunset Kitchen.*can't text them.*Don't pay/s);
    expect((await env.events(deal.job_id)).some((e) => e.type === "operator_attention" && e.data.reason === "booked_vendor_opted_out")).toBe(true);
  });
});

describe("over iMessage too", () => {
  for (const word of ["STOP", "CANCEL", "unsubscribe"]) {
    it(`a vendor's "${word}" by iMessage suppresses it`, async () => {
      const env = purchaseEnv({ imessage: true });
      const VENDOR = "+14155550197";
      const deal = await env.engine.deal({ request: { what: "team lunch catering", quantity: 40, unit: "people", date: "2026-11-14", area: "San Francisco, CA" } as never, budget_usd: 2500, businesses: [{ name: "Sunset Kitchen", phone: VENDOR, channel: "imessage" }] });
      expect((await env.engine.ingestIMessage({ messageId: `im_stop_${word}`, from: VENDOR, text: word, isGroup: false })).outcome).toBe("opted_out");
      expect((await env.repo.findSuppressions([VENDOR])).length).toBe(1);
      expect((await env.repo.getBusinesses(deal.job_id))[0]!.status).toBe("declined");
    });
  }
});
