// Every failure code of the payment guard (DESIGN.md §14.2), the idempotent
// repeat, and the happy path.
import { describe, expect, it } from "vitest";
import { checkPaymentAllowed, type GuardInput } from "../src/payments/guard.js";

const NOW = new Date("2026-10-17T21:00:00Z");

const base = (): GuardInput => ({
  job: { id: "job-1", status: "approved" },
  approval: {
    id: "ap-1",
    job_id: "job-1",
    quote_id: "q-1",
    vendor_id: "v-sol",
    amount_cents: 20000,
    status: "approved",
    expires_at: "2026-10-17T21:10:00Z",
  },
  quote: { id: "q-1", vendor_id: "v-sol", deposit_cents: 20000 },
  existingPayment: null,
  spendCapCents: 50000,
  now: NOW,
});

const code = (input: GuardInput) => {
  const r = checkPaymentAllowed(input);
  return r.ok ? "OK" : r.code;
};

describe("checkPaymentAllowed", () => {
  it("allows a fully valid payment", () => {
    expect(checkPaymentAllowed(base())).toEqual({ ok: true });
  });

  it("1. refuses with no approval", () => {
    expect(code({ ...base(), approval: null })).toBe("APPROVAL_NOT_FOUND");
  });

  it("1. refuses an approval from another job", () => {
    const i = base();
    i.approval!.job_id = "job-2";
    expect(code(i)).toBe("APPROVAL_NOT_FOUND");
  });

  it("2. returns the existing payment for a repeat call (idempotent)", () => {
    const i = { ...base(), existingPayment: { id: "pay-1", status: "succeeded" } };
    i.approval!.status = "used";
    i.job.status = "paid";
    expect(checkPaymentAllowed(i)).toEqual({ ok: true, existingPayment: { id: "pay-1", status: "succeeded" } });
  });

  it("3. refuses pending, declined, expired, and already-used approvals", () => {
    const cases = { pending: "APPROVAL_PENDING", declined: "APPROVAL_DECLINED", expired: "APPROVAL_EXPIRED", used: "APPROVAL_EXPIRED" } as const;
    for (const [status, expected] of Object.entries(cases)) {
      const i = base();
      i.approval!.status = status;
      expect(code(i)).toBe(expected);
    }
  });

  it("4. refuses an approval past its expiry even if approved", () => {
    const i = base();
    i.approval!.expires_at = "2026-10-17T20:59:59Z";
    expect(code(i)).toBe("APPROVAL_EXPIRED");
  });

  it("5. refuses when the amount no longer matches the quote's deposit", () => {
    const i = base();
    i.quote!.deposit_cents = 25000;
    expect(code(i)).toBe("AMOUNT_MISMATCH");
  });

  it("5. refuses when the vendor doesn't match", () => {
    const i = base();
    i.quote!.vendor_id = "v-other";
    expect(code(i)).toBe("AMOUNT_MISMATCH");
  });

  it("5. refuses when the approved quote is missing or a different quote", () => {
    expect(code({ ...base(), quote: null })).toBe("AMOUNT_MISMATCH");
    const i = base();
    i.quote!.id = "q-2";
    expect(code(i)).toBe("AMOUNT_MISMATCH");
  });

  it("6. refuses over the spend cap", () => {
    expect(code({ ...base(), spendCapCents: 19999 })).toBe("OVER_SPEND_CAP");
  });

  it("6. refuses a zero or negative amount", () => {
    const i = base();
    i.approval!.amount_cents = 0;
    i.quote!.deposit_cents = 0;
    expect(code(i)).toBe("AMOUNT_MISMATCH");
  });

  it("7. refuses when the job is not approved or payment_failed", () => {
    for (const status of ["ready", "awaiting_approval", "cancelled"]) {
      const i = base();
      i.job.status = status;
      expect(code(i)).toBe("JOB_NOT_READY");
    }
  });

  it("7. allows a retry after payment_failed", () => {
    const i = base();
    i.job.status = "payment_failed";
    expect(code(i)).toBe("OK");
  });
});
