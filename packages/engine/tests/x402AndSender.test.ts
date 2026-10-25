// x402 challenge processing (guard before signing), with fakes only.
// The real SDK X402Client is used with a fetch that throws, proving payEmailChallenge is local.
import { describe, expect, it } from "vitest";
import { createX402Client } from "@primitivedotdev/sdk/x402";
import { parseChallengePart, preparePayment, type PayerClient } from "../src/payments/x402Challenge.ts";

// Anchored to the wall clock: the x402 SDK checks challenge expiry against real time, so fixed
// dates would expire the fixtures (they did on 2026-10-17 at 21:05Z).
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const envelope = (over: Record<string, unknown> = {}, req: Record<string, unknown> = {}) => JSON.stringify({
  interaction_version: 1,
  interaction_id: "5f0c1b9e-2d3a-4c5b-9e8f-7a6b5c4d3e2f@bay-catering.primitive.email",
  protocol: "x402.payment",
  protocol_version: 1,
  step: "challenge",
  step_id: "0b6d7f2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  prev_step_id: null,
  expires_at: at(5),
  payload: {
    challenge_nonce: "a".repeat(64),
    payment_requirements: {
      scheme: "exact", network: "base-sepolia", maxAmountRequired: "5000000",
      payTo: "0x1111111111111111111111111111111111111111",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", extra: { name: "USDC", version: "2" },
      ...req,
    },
  },
  ...over,
});

const guardBase = () => ({
  job: { id: "job-1", state: "paying" },
  approval: { id: "ap-1", job_id: "job-1", quote_id: "q-bay-2", business_id: "b-bay", quote_total_cents: 99500, payment_cents: 500, status: "approved", expires_at: at(30) },
  quote: { id: "q-bay-2", business_id: "b-bay", total_cents: 99500, deposit_cents: 500, status: "current" },
  knownPayTo: null as string | null,
  existingPayment: null as { id: string; status: string } | null,
  spendCapCents: 500,
  now: NOW,
  challengeEmail: { business_id: "b-bay", sender_trusted: true, thread_matched: true },
});

const stubSigner = {
  address: "0x2222222222222222222222222222222222222222" as const,
  signTypedData: async () => `0x${"ab".repeat(65)}` as const,
};

describe("parseChallengePart", () => {
  it("parses a valid challenge with the SDK and exposes what the guard checks", () => {
    const r = parseChallengePart(envelope());
    expect(r).toMatchObject({ ok: true, parsed: { network: "base-sepolia", amountBaseUnits: "5000000", stepId: "0b6d7f2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f" } });
  });

  it("rejects malformed JSON, the wrong protocol or step, and a bad nonce", () => {
    expect(parseChallengePart("{not json").ok).toBe(false);
    expect(parseChallengePart(envelope({ protocol: "x402.other" })).ok).toBe(false);
    expect(parseChallengePart(envelope({ step: "receipt" })).ok).toBe(false);
    expect(parseChallengePart(envelope({ payload: { challenge_nonce: "xyz", payment_requirements: {} } })).ok).toBe(false);
  });
});

describe("preparePayment", () => {
  it("signs only after the guard passes, via the real SDK with no network access", async () => {
    const parsed = parseChallengePart(envelope());
    if (!parsed.ok) throw new Error(parsed.reason);
    const payer = createX402Client({ apiKey: "prim_test", fetch: (async () => { throw new Error("network must not be used"); }) as typeof fetch });
    const r = await preparePayment(payer as unknown as PayerClient, stubSigner, parsed.parsed, guardBase());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const step = JSON.parse(new TextDecoder().decode(r.interactionJson));
    expect(step).toMatchObject({ protocol: "x402.payment", step: "payment", prev_step_id: parsed.parsed.stepId, interaction_id: parsed.parsed.interactionId });
    expect(r.amountBaseUnits).toBe("5000000");
  });

  it("never calls the signer when the guard refuses (altered amount, wrong network, untrusted payee, unapproved)", async () => {
    let calls = 0;
    const payer: PayerClient = { payEmailChallenge: async () => (calls++, { json: "{}" }) };
    const cases: [string, ReturnType<typeof guardBase>, string][] = [
      [envelope({}, { maxAmountRequired: "5000001" }), guardBase(), "AMOUNT_MISMATCH"],
      [envelope({}, { network: "base" }), guardBase(), "WRONG_NETWORK"],
      [envelope(), { ...guardBase(), challengeEmail: { business_id: "b-deli", sender_trusted: true, thread_matched: true } }, "UNTRUSTED_PAYEE"],
      [envelope(), { ...guardBase(), approval: { ...guardBase().approval, status: "pending" } }, "APPROVAL_PENDING"],
      [envelope(), { ...guardBase(), existingPayment: { id: "p1", status: "sent" } }, "PAYMENT_IN_FLIGHT"],
    ];
    for (const [part, g, code] of cases) {
      const parsed = parseChallengePart(part);
      if (!parsed.ok) throw new Error(parsed.reason);
      const r = await preparePayment(payer, stubSigner, parsed.parsed, g);
      expect(r).toMatchObject({ ok: false, guard: { code } });
    }
    expect(calls).toBe(0);
  });
});

describe("preparePayment when the SDK refuses to sign", () => {
  it("returns CHALLENGE_EXPIRED instead of throwing", async () => {
    const parsed = parseChallengePart(envelope());
    if (!parsed.ok) throw new Error(parsed.reason);
    const payer: PayerClient = { payEmailChallenge: async () => { throw new Error("challenge has already expired; not signing"); } };
    expect(await preparePayment(payer, stubSigner, parsed.parsed, guardBase())).toMatchObject({ ok: false, guard: { code: "CHALLENGE_EXPIRED" } });
    const other: PayerClient = { payEmailChallenge: async () => { throw new Error("bad signer"); } };
    expect(await preparePayment(other, stubSigner, parsed.parsed, guardBase())).toMatchObject({ ok: false, guard: { code: "SIGNING_REFUSED" } });
  });
});
