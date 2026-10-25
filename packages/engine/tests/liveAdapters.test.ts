// Live adapters' safety rules, with fakes (no network).
import { describe, expect, it } from "vitest";
import { parseFleet } from "../src/live/fleet.ts";
import { disabledPayer } from "../src/payments/disabledPayer.ts";

describe("live adapters", () => {
  it("parses the demo fleet spec", () => {
    expect(parseFleet("Bay Catering <Quotes@Bay.inkboxmail.com>; bad entry; Harbor <h@x.test>")).toEqual([
      { name: "Bay Catering", email: "quotes@bay.inkboxmail.com" }, { name: "Harbor", email: "h@x.test" },
    ]);
    // A bare address (as typed into an .env) is kept, never silently dropped from the allowlist.
    expect(parseFleet("golden-grill-sf@inkboxmail.com")).toEqual([{ name: "Golden Grill Sf", email: "golden-grill-sf@inkboxmail.com" }]);
    expect(parseFleet("A <a@x.test>, b@y.test")).toEqual([{ name: "A", email: "a@x.test" }, { name: "B", email: "b@y.test" }]);
  });

  it("the disabled payer never signs and needs no wallet", async () => {
    const p = disabledPayer("Stripe test-mode payments are not enabled yet");
    expect(p).toMatchObject({ signer: null, simulated: false });
    await expect(p.client.payEmailChallenge({} as never, { signer: null })).rejects.toThrow(/Stripe test-mode payments are not enabled yet/);
  });
});
