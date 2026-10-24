// SIMULATED (sprint 5 A): the comparison explains itself. Every quote says why it was or wasn't picked,
// and every contacted vendor that isn't compared says why not (declined, no reply, asked a question,
// unreadable reply), in plain words the agent can repeat. Real engine, in-memory store, fake ports.
import { describe, expect, it } from "vitest";
import { exclusionLine, exclusionOf } from "../src/ranking/exclusion.ts";
import { purchaseEnv, quotedDeal } from "./helpers/purchaseKit.ts";

describe("exclusionOf", () => {
  const base = { name: "Bay Catering", channel: "email", compared: false, declined: false, unreadable: false, quotesFinal: true, replied: false };
  it("a compared vendor needs no exclusion; a silent one only once quotes are final", () => {
    expect(exclusionOf({ ...base, compared: true })).toBeNull();
    expect(exclusionOf({ ...base, quotesFinal: false })).toBeNull();
    expect(exclusionOf(base)).toEqual({ status: "no_reply", detail: "Bay Catering didn't reply (email) before quotes closed, so it isn't compared." });
  });
  it("declined, unreachable, a question first and an unreadable reply say so even before quotes close", () => {
    expect(exclusionOf({ ...base, quotesFinal: false, declined: true })!.status).toBe("declined");
    expect(exclusionOf({ ...base, quotesFinal: false, unreachable: "no phone port" })!.detail).toMatch(/couldn't be contacted \(no phone port\)/);
    expect(exclusionOf({ ...base, quotesFinal: false, question: "Buffet or boxed?" })!.detail).toMatch(/asked a question before quoting \("Buffet or boxed\?"\)/);
    expect(exclusionOf({ ...base, quotesFinal: false, unreadable: true })!.status).toBe("reply_unreadable");
  });
  it("exclusionLine names each with a short reason", () => {
    expect(exclusionLine([{ name: "Bay", status: "no_reply" }, { name: "Delta", status: "declined" }, { name: "Echo", status: "bounced" }])).toBe("Not compared: Bay (no quote), Delta (declined), Echo (email bounced).");
    expect(exclusionLine([])).toBe("");
  });
});

describe("the board explains every vendor", () => {
  it("compared quotes carry a selection reason; vendors out of the comparison carry theirs; the next hint names them", async () => {
    const env = purchaseEnv();
    const d = await quotedDeal(env, [
      { name: "Harbor Table", email: "events@harbor.example", reply: "$2,180 total incl tax, 14 vegetarian, delivered by 11:00, $500 deposit." },
      { name: "Golden Grill", email: "orders@grill.example", reply: "$1,650 total incl tax, only 6 vegetarian, delivered by 11:00." },
      { name: "Sunset Kitchen", email: "events@sunset.example", reply: "$2,900 total incl tax, 14 vegetarian, delivered by 11:00, $500 deposit." },
      { name: "Delta Deli", email: "hello@delta.example", reply: "Sorry, we can't do that date, we're fully booked." },
      { name: "Bay Catering", email: "quotes@bay.example" },
    ]);
    const board = d.board;
    const sel = (name: string) => board.quotes.find((q) => q.business === name && q.status === "current")?.selection;
    expect(sel("Harbor Table")).toMatchObject({ status: "recommended" });
    expect(sel("Golden Grill")).toMatchObject({ status: "selectable", reason: expect.stringMatching(/doesn't meet: At least 12 vegetarian meals/) });
    expect(sel("Sunset Kitchen")).toMatchObject({ status: "selectable", reason: expect.stringMatching(/\$400 over the \$2,500 budget/) });
    const id = (name: string) => board.businesses.find((b) => b.name === name)!.business_id;
    expect(board.vendor_contact?.[id("Bay Catering")]).toEqual({ status: "no_reply", detail: "Bay Catering didn't reply (email) before quotes closed, so it isn't compared." });
    expect(board.vendor_contact?.[id("Delta Deli")]).toMatchObject({ status: "declined", detail: expect.stringMatching(/said it can't do this order/) });
    expect(board.vendor_contact?.[id("Harbor Table")]).toBeUndefined();
    // Haggle texted the human its recommendation (Harbor); the hint also says who isn't compared and why.
    expect(board.next).toMatch(/^Quotes are final\..*Not compared: Delta Deli \(declined\), Bay Catering \(no quote\)\.$/s);
    expect(board.recommended_quote_id).toBe(board.quotes.find((q) => q.business === "Harbor Table")!.quote_id);
  });
});
