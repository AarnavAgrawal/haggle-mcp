// Ported from quote-broker@8a68559 tests/guard.test.ts (Partner): every rule of the payment
// guard, the idempotent repeat and the happy path, adapted to x402 over email (Haggle v3).
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA_USDC, checkX402PaymentAllowed, type X402GuardInput } from "../src/payments/guard.ts";

const NOW = new Date("2026-10-17T21:00:00Z");

const base = (): X402GuardInput => ({
  job: { id: "job-1", state: "paying" },
  approval: {
    id: "ap-1", job_id: "job-1", quote_id: "q-bay-2", business_id: "b-bay",
    quote_total_cents: 99500, payment_cents: 500, status: "approved", expires_at: "2026-10-17T21:30:00Z",
  },
  quote: { id: "q-bay-2", business_id: "b-bay", total_cents: 99500, deposit_cents: 500, status: "current" },
  challenge: {
    business_id: "b-bay", sender_trusted: true, thread_matched: true, network: "base-sepolia",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount_base_units: "5000000",
    pay_to: "0xPAYEE", expires_at: "2026-10-17T21:05:00Z",
  },
  knownPayTo: null,
  existingPayment: null,
  spendCapCents: 500,
  now: NOW,
});

const code = (input: X402GuardInput) => {
  const r = checkX402PaymentAllowed(input);
  return r.ok ? "OK" : r.code;
};

describe("checkX402PaymentAllowed", () => {
  it("allows a fully valid payment and returns the exact base units", () => {
    expect(checkX402PaymentAllowed(base())).toEqual({ ok: true, amountBaseUnits: "5000000" });
    expect(BASE_SEPOLIA_USDC).toBe(BASE_SEPOLIA_USDC.toLowerCase());
  });

  it("1. refuses with no approval or another job's approval", () => {
    expect(code({ ...base(), approval: null })).toBe("APPROVAL_NOT_FOUND");
    const i = base();
    i.approval!.job_id = "job-2";
    expect(code(i)).toBe("APPROVAL_NOT_FOUND");
  });

  it("2. returns the settled payment for a repeat call, and never re-signs an in-flight one", () => {
    const settled = { ...base(), existingPayment: { id: "pay-1", status: "settled" } };
    settled.approval!.status = "used";
    expect(checkX402PaymentAllowed(settled)).toMatchObject({ ok: true, existingPayment: { id: "pay-1" } });
    for (const status of ["signed", "sent"]) {
      expect(code({ ...base(), existingPayment: { id: "pay-1", status } })).toBe("PAYMENT_IN_FLIGHT");
    }
  });

  it("3./4. refuses pending, declined, expired, used, and timed-out approvals", () => {
    const cases = { pending: "APPROVAL_PENDING", declined: "APPROVAL_DECLINED", expired: "APPROVAL_EXPIRED", used: "APPROVAL_EXPIRED" } as const;
    for (const [status, expected] of Object.entries(cases)) {
      const i = base();
      i.approval!.status = status;
      expect(code(i)).toBe(expected);
    }
    const i = base();
    i.approval!.expires_at = "2026-10-17T20:59:59Z";
    expect(code(i)).toBe("APPROVAL_EXPIRED");
  });

  it("5. refuses a revised, superseded, or different quote, or a different business", () => {
    const superseded = base();
    superseded.quote!.status = "superseded";
    expect(code(superseded)).toBe("QUOTE_CHANGED");
    const other = base();
    other.quote!.id = "q-bay-3";
    expect(code(other)).toBe("QUOTE_CHANGED");
    const biz = base();
    biz.quote!.business_id = "b-harbor";
    expect(code(biz)).toBe("QUOTE_CHANGED");
    expect(code({ ...base(), quote: null })).toBe("QUOTE_CHANGED");
  });

  it("5. refuses when the total or deposit no longer matches what was approved, or is zero", () => {
    const total = base();
    total.quote!.total_cents = 101600;
    expect(code(total)).toBe("AMOUNT_MISMATCH");
    const dep = base();
    dep.quote!.deposit_cents = 600;
    expect(code(dep)).toBe("AMOUNT_MISMATCH");
    const zero = base();
    zero.approval!.payment_cents = 0;
    zero.quote!.deposit_cents = 0;
    expect(code(zero)).toBe("AMOUNT_MISMATCH");
  });

  it("6. refuses over the spend cap", () => {
    expect(code({ ...base(), spendCapCents: 499 })).toBe("OVER_SPEND_CAP");
  });

  it("7. refuses when the job is not in the paying state", () => {
    for (const state of ["awaiting_approval", "negotiating", "cancelled", "paid"]) expect(code({ ...base(), job: { id: "job-1", state } })).toBe("JOB_NOT_READY");
  });

  it("8. waits for an invoice instead of signing anything", () => {
    expect(code({ ...base(), challenge: null })).toBe("AWAITING_INVOICE");
  });

  it("9. refuses an invoice from another business, an untrusted sender, or another thread", () => {
    for (const over of [{ business_id: "b-harbor" }, { sender_trusted: false }, { thread_matched: false }]) {
      const i = base();
      Object.assign(i.challenge!, over);
      expect(code(i)).toBe("UNTRUSTED_PAYEE");
    }
  });

  it("10. refuses any network or asset but Base Sepolia USDC", () => {
    const net = base();
    net.challenge!.network = "base";
    expect(code(net)).toBe("WRONG_NETWORK");
    const asset = base();
    asset.challenge!.asset = "0x0000000000000000000000000000000000000001";
    expect(code(asset)).toBe("WRONG_NETWORK");
  });

  it("11. refuses any amount other than the approved base units", () => {
    for (const amount of ["5000001", "4999999", "500", "5000000.0", "50000000"]) {
      const i = base();
      i.challenge!.amount_base_units = amount;
      expect(code(i)).toBe("AMOUNT_MISMATCH");
    }
  });

  it("12. refuses a payee address that changed since the business's last challenge", () => {
    expect(code({ ...base(), knownPayTo: "0xOTHER" })).toBe("PAYEE_CHANGED");
    expect(code({ ...base(), knownPayTo: "0xpayee" })).toBe("OK");
  });

  it("13. refuses a challenge without enough time left to settle", () => {
    const i = base();
    i.challenge!.expires_at = "2026-10-17T21:00:30Z";
    expect(code(i)).toBe("CHALLENGE_EXPIRED");
  });
});
