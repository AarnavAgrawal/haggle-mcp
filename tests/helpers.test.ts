// Pure helpers behind the tools: approval email, wait conditions, summaries.
import { describe, expect, it } from "vitest";
import { buildApprovalEmail } from "../src/approvals/requestApproval.js";
import { conditionMet } from "../src/tools/waitForJob.js";
import { timelineLine } from "../src/tools/getJob.js";
import { nextStep, summarizeJob } from "../src/jobs/summary.js";
import { maskEmail, money } from "../src/tools/format.js";
import { bareAddress } from "../src/webhooks/primitive.js";
import type { ApprovalRow, JobRow, QuoteRow, VendorRow } from "../src/db/queries.js";

const event = { date: "2026-10-24", time: "18:30", headcount: 40, location: "123 Main St", dietary: [{ need: "vegetarian", count: 6 }] };

describe("buildApprovalEmail", () => {
  const email = buildApprovalEmail({
    shortCode: "7F3K",
    vendorName: "Taqueria Sol",
    event,
    perHeadCents: 2100,
    totalCents: 88000,
    depositCents: 20000,
    others: [{ vendorName: "Le Petit Four", perHeadCents: 3800, totalCents: 159500 }],
    code: "4821",
    expiresAt: new Date("2026-10-17T21:10:00Z"),
  });

  it("puts the tag, amount, and vendor in the subject", () => {
    expect(email.subject).toBe("[QB-7F3K] Approve $200.00 deposit to Taqueria Sol?");
  });

  it("includes the code, the decline option, the other quotes, and the expiry", () => {
    expect(email.bodyText).toContain("To approve, reply with: APPROVE 4821");
    expect(email.bodyText).toContain("To decline, reply with: NO");
    expect(email.bodyText).toContain("- Le Petit Four: $38.00/person, total $1595.00");
    expect(email.bodyText).toContain("expires Saturday October 17 at 21:10 UTC");
  });
});

describe("conditionMet", () => {
  it("any_change compares versions", () => {
    expect(conditionMet("any_change", { status: "collecting", version: 3 }, 3)).toBe(false);
    expect(conditionMet("any_change", { status: "collecting", version: 4 }, 3)).toBe(true);
  });
  it("ready waits out collecting and negotiating", () => {
    expect(conditionMet("ready", { status: "negotiating", version: 9 }, 0)).toBe(false);
    expect(conditionMet("ready", { status: "ready", version: 9 }, 0)).toBe(true);
    expect(conditionMet("ready", { status: "expired", version: 9 }, 0)).toBe(true);
  });
  it("approval_decided and done", () => {
    expect(conditionMet("approval_decided", { status: "awaiting_approval", version: 1 }, 0)).toBe(false);
    expect(conditionMet("approval_decided", { status: "approved", version: 1 }, 0)).toBe(true);
    expect(conditionMet("done", { status: "approved", version: 1 }, 0)).toBe(false);
    expect(conditionMet("done", { status: "paid", version: 1 }, 0)).toBe(true);
  });
});

describe("summaries", () => {
  const job = { id: "j", status: "collecting", round: 0, max_rounds: 1, collect_until: "2026-10-17T21:30:00Z", event } as unknown as JobRow;
  const vendors = [
    { id: "v1", name: "Taqueria Sol", status: "replied" },
    { id: "v2", name: "Golden Wok", status: "contacted" },
  ] as VendorRow[];
  const quote = {
    id: "q1", vendor_id: "v1", available: true, price_per_head_cents: 2250, total_cents: 94000,
    dietary_coverage: { vegetarian: true }, round: 0,
  } as unknown as QuoteRow;

  it("describes collection progress with the best quote", () => {
    expect(summarizeJob(job, vendors, [quote], null)).toBe(
      "1 of 2 vendors replied. Best so far: Taqueria Sol at $22.50/head. Collecting until 21:30 UTC.",
    );
  });

  it("names the approval amount and vendor while waiting", () => {
    const approval = { id: "ap", vendor_id: "v1", amount_cents: 20000, expires_at: "2026-10-17T21:10:00Z", status: "pending" } as ApprovalRow;
    expect(summarizeJob({ ...job, status: "awaiting_approval" }, vendors, [quote], approval)).toContain("approve $200.00 to Taqueria Sol");
  });

  it("tells the agent exactly what to call next", () => {
    expect(nextStep({ id: "j", status: "approved" }, { id: "ap-9", status: "approved" })).toBe("Call pay with job_id and approval_id='ap-9'.");
    expect(nextStep({ id: "j", status: "ready" }, null)).toContain("list_quotes");
  });

  it("formats timeline lines", () => {
    expect(timelineLine({ id: 1, job_id: "j", type: "deadline_passed", data: { from: "collecting", to: "negotiating" }, created_at: "2026-10-17T20:41:07Z" }))
      .toBe("20:41:07 deadline_passed (collecting -> negotiating)");
  });
});

describe("format and address helpers", () => {
  it("formats money and masks emails", () => {
    expect(money(2250)).toBe("22.50");
    expect(money(null)).toBeNull();
    expect(maskEmail("aarnav@gmail.com")).toBe("a***@gmail.com");
  });

  it("extracts the bare address from a From header", () => {
    expect(bareAddress('"Taqueria Sol" <Sol@Taqueria.test>')).toBe("sol@taqueria.test");
    expect(bareAddress("plain@x.test")).toBe("plain@x.test");
  });
});
