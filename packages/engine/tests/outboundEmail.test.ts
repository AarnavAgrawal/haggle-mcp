// Provider-neutral outbound email helpers (ported from the retired Primitive sender test).
import { describe, expect, it } from "vitest";
import { replySubject, sendKeys } from "../src/outbound/email.ts";

describe("outbound email helpers", () => {
  it("in-thread subjects get a single Re:", () => {
    expect(replySubject("[HG-7F3K] x")).toBe("Re: [HG-7F3K] x");
    expect(replySubject("  re: [HG-7F3K] x ")).toBe("re: [HG-7F3K] x");
    expect(replySubject("Re: Re: [HG-7F3K] x")).toBe("Re: Re: [HG-7F3K] x");
  });

  it("idempotency keys are deterministic per logical send", () => {
    expect(sendKeys.rfq("job-1", "b-bay")).toBe("rfq:job-1:b-bay");
    expect(sendKeys.counter("j", "b", 2)).toBe("counter:j:b:r2");
    expect(sendKeys.counter("j", "b", 2)).toBe(sendKeys.counter("j", "b", 2));
    expect(sendKeys.followUp("j", "b", 1)).not.toBe(sendKeys.followUp("j", "b", 2));
    expect(sendKeys.payment("step-1")).toBe("pay:step-1");
  });
});
