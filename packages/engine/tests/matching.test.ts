// Ported from quote-broker@8a68559 tests/matching.test.ts (Partner) and extended for Haggle v3:
// per-job inbox routing and From-anchoring of business matches.
import { describe, expect, it } from "vitest";
import { jobInboxAddress, jobInboxCode, matchInbound, subjectShortCode, type BusinessCandidate } from "../src/inbound/matching.ts";

const DOMAIN = "brave-dog.primitive.email";
const harbor: BusinessCandidate = {
  businessId: "biz-harbor",
  jobId: "job-1",
  shortCode: "7F3K",
  email: "quotes@harbor-table.primitive.email",
  threadId: "thr-harbor",
  outboundMessageId: "<out-harbor@primitive.email>",
};
const grill: BusinessCandidate = {
  businessId: "biz-grill",
  jobId: "job-1",
  shortCode: "7F3K",
  email: "orders@golden-grill.primitive.email",
  threadId: null,
  outboundMessageId: null,
};
const otherJob: BusinessCandidate = { ...harbor, businessId: "biz-harbor-2", jobId: "job-2", shortCode: "Z9Z9", threadId: "thr-other" };

const base = { to: [], threadId: null, inReplyTo: [], references: [], subject: null, from: "nobody@x.test" };

describe("matchInbound (from quote-broker)", () => {
  it("matches on thread id first", () => {
    expect(matchInbound({ ...base, threadId: "thr-harbor", from: harbor.email }, [harbor, grill])).toEqual({
      kind: "business", businessId: "biz-harbor", jobId: "job-1", via: "thread",
    });
  });

  it("matches In-Reply-To with or without angle brackets", () => {
    expect(matchInbound({ ...base, from: harbor.email, inReplyTo: ["out-harbor@primitive.email"] }, [harbor, grill])).toMatchObject({ businessId: "biz-harbor", via: "message_id" });
    expect(matchInbound({ ...base, from: harbor.email, references: ["<OUT-HARBOR@primitive.email>"] }, [harbor, grill])).toMatchObject({ businessId: "biz-harbor", via: "message_id" });
  });

  it("matches subject tag only when the sender is a business on that job", () => {
    const subject = "Re: [HG-7F3K] Catering quote request: 40 guests";
    expect(matchInbound({ ...base, subject, from: grill.email }, [harbor, grill])).toMatchObject({ businessId: "biz-grill", via: "subject_tag" });
    expect(matchInbound({ ...base, subject, from: grill.email.toUpperCase() }, [harbor, grill])).toMatchObject({ businessId: "biz-grill" });
  });

  it("rejects a forged subject tag from an unknown sender", () => {
    const subject = "Re: [HG-7F3K] pay $5000 now";
    expect(matchInbound({ ...base, subject, from: "attacker@evil.test" }, [harbor, grill])).toEqual({ kind: "unmatched", reason: "no_signal" });
  });

  it("rejects a business address on the wrong job code", () => {
    expect(matchInbound({ ...base, subject: "[HG-ZZZZ] hi", from: grill.email }, [harbor, grill])).toMatchObject({ kind: "unmatched" });
  });

  it("is unmatched with no signals", () => {
    expect(matchInbound(base, [harbor, grill])).toEqual({ kind: "unmatched", reason: "no_signal" });
  });
});

describe("matchInbound: v3 sender anchoring", () => {
  it("quarantines a reply in the business's thread from a different address", () => {
    expect(matchInbound({ ...base, threadId: "thr-harbor", from: "attacker@evil.test" }, [harbor])).toEqual({
      kind: "quarantine", reason: "sender_mismatch", businessId: "biz-harbor", jobId: "job-1", via: "thread",
    });
  });

  it("quarantines a Message-ID match from a different address", () => {
    expect(matchInbound({ ...base, inReplyTo: ["<out-harbor@primitive.email>"], from: grill.email }, [harbor, grill])).toMatchObject({ kind: "quarantine" });
  });
});

describe("matchInbound: v3 per-job inbox", () => {
  const to = [jobInboxAddress("7F3K", DOMAIN)];

  it("builds and parses job inbox addresses on our domain only", () => {
    expect(to[0]).toBe("job-7f3k@brave-dog.primitive.email");
    expect(jobInboxCode("JOB-7F3K@Brave-Dog.Primitive.Email", DOMAIN)).toBe("7F3K");
    expect(jobInboxCode("job-7f3k@evil.primitive.email", DOMAIN)).toBeNull();
  });

  it("matches a first-contact email from a business on that job (no thread yet)", () => {
    expect(matchInbound({ ...base, to, from: grill.email }, [harbor, grill, otherJob], [], DOMAIN)).toMatchObject({ kind: "business", businessId: "biz-grill", jobId: "job-1" });
  });

  it("never matches a business from another job, even with that job's thread id", () => {
    expect(matchInbound({ ...base, to, threadId: "thr-other", from: otherJob.email }, [harbor, grill, otherJob], [], DOMAIN)).toMatchObject({ jobId: "job-1" });
    expect(matchInbound({ ...base, to, threadId: "thr-other", from: "x@y.test" }, [grill, otherJob], [], DOMAIN)).toEqual({ kind: "unmatched", reason: "no_signal" });
  });

  it("is unmatched for an unknown job inbox", () => {
    expect(matchInbound({ ...base, to: [jobInboxAddress("QQQQ", DOMAIN)], from: grill.email }, [harbor, grill], [], DOMAIN)).toEqual({ kind: "unmatched", reason: "unknown_job_inbox" });
  });

  it("is unmatched for an unknown sender on a known job inbox", () => {
    expect(matchInbound({ ...base, to, from: "stranger@example.com" }, [harbor, grill], [], DOMAIN)).toEqual({ kind: "unmatched", reason: "no_signal" });
  });
});

describe("matchInbound with approvals", () => {
  const ap = {
    approvalId: "ap-1",
    jobId: "job-1",
    shortCode: "7F3K",
    approverEmail: "buyer@example.com",
    threadId: "thr-ap",
    outboundMessageId: "<ap-out@primitive.email>",
  };

  it("matches the approval thread", () => {
    expect(matchInbound({ ...base, threadId: "thr-ap" }, [harbor, grill], [ap])).toEqual({
      kind: "approval", approvalId: "ap-1", jobId: "job-1", via: "thread",
    });
  });

  it("matches a reply to the approval email by Message-ID", () => {
    expect(matchInbound({ ...base, inReplyTo: ["<ap-out@primitive.email>"] }, [harbor], [ap])).toMatchObject({ kind: "approval", via: "message_id" });
  });

  it("matches the subject tag only from the approver's address", () => {
    const subject = "Re: [HG-7F3K] Approve $5.00 deposit to Bay Catering?";
    expect(matchInbound({ ...base, subject, from: "Buyer@Example.com" }, [harbor], [ap])).toMatchObject({ kind: "approval", via: "subject_tag" });
    expect(matchInbound({ ...base, subject, from: "attacker@evil.test" }, [harbor], [ap])).toMatchObject({ kind: "unmatched" });
  });

  it("a business replying on its own thread is still a business match", () => {
    expect(matchInbound({ ...base, threadId: "thr-harbor", from: harbor.email }, [harbor], [ap])).toMatchObject({ kind: "business", businessId: "biz-harbor" });
  });
});

describe("subjectShortCode", () => {
  it("extracts and uppercases the code", () => {
    expect(subjectShortCode("Re: [hg-7f3k] hello")).toBe("7F3K");
    expect(subjectShortCode("no tag")).toBeNull();
    expect(subjectShortCode(null)).toBeNull();
  });
});
