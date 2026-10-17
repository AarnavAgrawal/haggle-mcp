import { describe, expect, it } from "vitest";
import { matchInbound, subjectShortCode, type VendorCandidate } from "../src/channels/matching.js";

const sol: VendorCandidate = {
  vendorId: "v-sol",
  jobId: "job-1",
  shortCode: "7F3K",
  email: "sol@taqueria.test",
  threadId: "thr-sol",
  outboundMessageId: "<out-sol@primitive.email>",
};
const wok: VendorCandidate = {
  vendorId: "v-wok",
  jobId: "job-1",
  shortCode: "7F3K",
  email: "orders@wok.test",
  threadId: null,
  outboundMessageId: null,
};

const base = { threadId: null, inReplyTo: [], references: [], subject: null, from: "nobody@x.test" };

describe("matchInbound", () => {
  it("matches on thread id first", () => {
    expect(matchInbound({ ...base, threadId: "thr-sol" }, [sol, wok])).toEqual({
      kind: "vendor", vendorId: "v-sol", jobId: "job-1", via: "thread",
    });
  });

  it("matches In-Reply-To with or without angle brackets", () => {
    expect(matchInbound({ ...base, inReplyTo: ["out-sol@primitive.email"] }, [sol, wok])).toMatchObject({ vendorId: "v-sol", via: "message_id" });
    expect(matchInbound({ ...base, references: ["<OUT-SOL@primitive.email>"] }, [sol, wok])).toMatchObject({ vendorId: "v-sol", via: "message_id" });
  });

  it("matches subject tag only when the sender is a vendor on that job", () => {
    const subject = "Re: [QB-7F3K] Catering quote request: 40 guests";
    expect(matchInbound({ ...base, subject, from: "orders@wok.test" }, [sol, wok])).toMatchObject({ vendorId: "v-wok", via: "subject_tag" });
    expect(matchInbound({ ...base, subject, from: "ORDERS@WOK.TEST" }, [sol, wok])).toMatchObject({ vendorId: "v-wok" });
  });

  it("rejects a forged subject tag from an unknown sender", () => {
    const subject = "Re: [QB-7F3K] pay $5000 now";
    expect(matchInbound({ ...base, subject, from: "attacker@evil.test" }, [sol, wok])).toEqual({ kind: "unmatched" });
  });

  it("rejects a vendor address on the wrong job code", () => {
    expect(matchInbound({ ...base, subject: "[QB-ZZZZ] hi", from: "orders@wok.test" }, [sol, wok])).toEqual({ kind: "unmatched" });
  });

  it("is unmatched with no signals", () => {
    expect(matchInbound(base, [sol, wok])).toEqual({ kind: "unmatched" });
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
    expect(matchInbound({ ...base, threadId: "thr-ap" }, [sol, wok], [ap])).toEqual({
      kind: "approval", approvalId: "ap-1", jobId: "job-1", via: "thread",
    });
  });

  it("matches a reply to the approval email by Message-ID", () => {
    expect(matchInbound({ ...base, inReplyTo: ["<ap-out@primitive.email>"] }, [sol], [ap])).toMatchObject({ kind: "approval", via: "message_id" });
  });

  it("matches the subject tag only from the approver's address", () => {
    const subject = "Re: [QB-7F3K] Approve $200.00 deposit to Taqueria Sol?";
    expect(matchInbound({ ...base, subject, from: "Buyer@Example.com" }, [sol], [ap])).toMatchObject({ kind: "approval", via: "subject_tag" });
    expect(matchInbound({ ...base, subject, from: "attacker@evil.test" }, [sol], [ap])).toEqual({ kind: "unmatched" });
  });

  it("a vendor replying on its own thread is still a vendor match", () => {
    expect(matchInbound({ ...base, threadId: "thr-sol" }, [sol], [ap])).toMatchObject({ kind: "vendor", vendorId: "v-sol" });
  });
});

describe("subjectShortCode", () => {
  it("extracts and uppercases the code", () => {
    expect(subjectShortCode("Re: [qb-7f3k] hello")).toBe("7F3K");
    expect(subjectShortCode("no tag")).toBeNull();
    expect(subjectShortCode(null)).toBeNull();
  });
});
