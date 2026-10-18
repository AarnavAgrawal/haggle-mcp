// Call-transcript safety (ported from feat/live-demo), on transcript shapes from the live calls.
import { describe, expect, it } from "vitest";
import { answeredSomething, dropAgentOnlyAmounts, spokenAmounts } from "../src/index.ts";
import type { QuoteExtraction } from "../src/parsing/extraction.ts";

const x = (over: Partial<QuoteExtraction>): QuoteExtraction => ({
  available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
  total_usd: null, deposit_usd: null, menu_items: [], dietary_coverage: [], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
  sources: [], missing_fields: [], confidence: 0.9, ...over,
});

describe("answeredSomething", () => {
  it("call screening or voicemail alone is not an answer; the live call with a quote is", () => {
    expect(answeredSomething("remote: If you record your name and reason for calling\nhaggle (AI assistant): Hi, this is Haggle, an AI assistant. Please call us back.")).toBe(false);
    expect(answeredSomething("remote: Please leave a message after the tone.")).toBe(false);
    expect(answeredSomething("remote: If you record your name and reason for calling\nremote: Yes, for two hundred total meals it'll cost about six thousand dollars")).toBe(true);
  });
});

describe("dropAgentOnlyAmounts", () => {
  const callback = [
    "haggle (AI assistant): Hi, this is Haggle, the AI assistant who called earlier. We have a real quote of $6,883.57 total. Can you do better?",
    "remote: We can do six thousand eight hundred flat, delivery included.",
  ].join("\n");
  it("a figure only Haggle cited is never the business's price; the business's spoken figure is kept", () => {
    expect(dropAgentOnlyAmounts(x({ total_usd: 6883.57, sources: [{ field: "total", source: "call transcript", excerpt: "$6,883.57" }] }), callback)).toMatchObject({ total_usd: null, missing_fields: ["total"], sources: [] });
    expect(dropAgentOnlyAmounts(x({ total_usd: 6800, sources: [{ field: "total", source: "call transcript", excerpt: "six thousand eight hundred" }] }), callback)).toMatchObject({ total_usd: 6800 });
  });
  it("a read-back the business explicitly confirmed counts as its own figure", () => {
    const t = "remote: About six thousand two hundred all in.\nhaggle (AI assistant): Just to confirm, $6,200 total including delivery, is that right?\nremote: That is correct";
    expect(dropAgentOnlyAmounts(x({ total_usd: 6200, sources: [{ field: "total", source: "call transcript", excerpt: "$6,200" }] }), t)).toMatchObject({ total_usd: 6200 });
  });
  it("spoken prices are read as people say them", () => {
    expect(spokenAmounts("six thousand dollars and two hundred in delivery")).toEqual(expect.arrayContaining([6000, 200]));
    expect(spokenAmounts("two fifty")).toEqual(expect.arrayContaining([250]));
  });
});
