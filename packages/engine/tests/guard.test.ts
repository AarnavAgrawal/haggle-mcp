// Ported from quote-broker@8a68559 tests/guard.test.ts (Partner): every approval rule of the payment
// guard (1–7), the idempotent repeat and the happy path. The Stripe-specific rules are in stripe.test.ts.
import { describe, expect, it } from "vitest";
import { checkApprovedPayment, type ApprovedPaymentInput } from "../src/payments/guard.ts";

const NOW = new Date("2026-10-17T21:00:00Z");
const IN_FLIGHT = new Set(["charging"]);

const base = (): ApprovedPaymentInput => ({
  job: { id: "job-1", state: "paying" },
  approval: {
    id: "ap-1", job_id: "job-1", quote_id: "q-bay-2", business_id: "b-bay",
    quote_total_cents: 99500, payment_cents: 500, status: "approved", expires_at: "2026-10-17T21:30:00Z",
  },
  quote: { id: "q-bay-2", business_id: "b-bay", total_cents: 99500, deposit_cents: 500, status: "current" },
  existingPayment: null,
  spendCapCents: 500,
  now: NOW,
});

const code = (input: ApprovedPaymentInput) => {
  const r = checkApprovedPayment(input, IN_FLIGHT);
  return r.ok ? "OK" : r.code;
};

describe("checkApprovedPayment", () => {
  it("allows a fully valid payment", () => {
    expect(checkApprovedPayment(base(), IN_FLIGHT)).toEqual({ ok: true });
  });

  it("1. refuses with no approval or another job's approval", () => {
    expect(code({ ...base(), approval: null })).toBe("APPROVAL_NOT_FOUND");
    const i = base();
    i.approval!.job_id = "job-2";
    expect(code(i)).toBe("APPROVAL_NOT_FOUND");
  });

  it("2. returns the settled payment for a repeat call, and never repeats an in-flight one", () => {
    const settled = { ...base(), existingPayment: { id: "pay-1", status: "settled" } };
    settled.approval!.status = "used";
    expect(checkApprovedPayment(settled, IN_FLIGHT)).toMatchObject({ ok: true, existingPayment: { id: "pay-1" } });
    expect(code({ ...base(), existingPayment: { id: "pay-1", status: "charging" } })).toBe("PAYMENT_IN_FLIGHT");
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
});
