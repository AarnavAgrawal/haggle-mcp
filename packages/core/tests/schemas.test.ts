import { describe, expect, it } from "vitest";
import {
  CounterPart,
  JobId,
  JobRequirements,
  PaymentNetwork,
  QuotePart,
  Requirement,
  evidenced,
  parseProtocolPart,
  Cents,
} from "../src/index.ts";

const offsiteRequirements = [
  { id: "req_headcount", kind: "quantity", label: "Lunch for 40 people", unit: "meals", min: 40 },
  { id: "req_veg", kind: "tagged_quantity", label: "At least 12 vegetarian meals", tag: "vegetarian", unit: "meals", min: 12 },
  { id: "req_delivery", kind: "delivery", label: "Delivery included", required: true, location: "San Francisco, CA" },
  { id: "req_date", kind: "fulfillment_date", label: "Thursday Oct 22", date: "2026-10-22", timezone: "America/Los_Angeles" },
] as const;

describe("requirements", () => {
  it("parses the offsite requirements and defaults mandatory to true", () => {
    const reqs = JobRequirements.parse(offsiteRequirements);
    expect(reqs).toHaveLength(4);
    expect(reqs.every((r) => r.mandatory)).toBe(true);
  });

  it("expresses a non-catering vertical with the same kinds", () => {
    const printing = JobRequirements.parse([
      { id: "req_qty", kind: "quantity", label: "500 business cards", unit: "cards", min: 500 },
      { id: "req_recycled", kind: "tagged_quantity", label: "100 on recycled stock", tag: "recycled", unit: "cards", min: 100 },
      { id: "req_finish", kind: "custom", label: "Matte finish", text: "matte finish", mandatory: false },
    ]);
    expect(printing[2]!.mandatory).toBe(false);
  });

  it("rejects duplicate requirement ids", () => {
    const dup = [offsiteRequirements[0], { ...offsiteRequirements[1], id: "req_headcount" }];
    expect(JobRequirements.safeParse(dup).success).toBe(false);
  });

  it("rejects unknown kinds", () => {
    expect(Requirement.safeParse({ id: "req_x", kind: "vibes", label: "good vibes" }).success).toBe(false);
  });
});

describe("evidenced fields", () => {
  const Field = evidenced(Cents);

  it("represents a missing value explicitly instead of zero", () => {
    expect(Field.parse({ status: "missing" })).toEqual({ status: "missing" });
    expect(Field.safeParse({ status: "stated", value: 0 }).success).toBe(false); // provenance required
  });

  it("requires provenance for stated values", () => {
    const ok = Field.safeParse({
      status: "stated",
      value: 50_000,
      provenance: { source: "pdf_attachment", page: 2, excerpt: "50% deposit", extraction_confidence: 0.9, extractor: "llm" },
    });
    expect(ok.success).toBe(true);
  });
});

describe("ids and networks", () => {
  it("validates prefixed ids", () => {
    expect(JobId.safeParse("job_abc123XYZ").success).toBe(true);
    expect(JobId.safeParse("q_abc123").success).toBe(false);
    expect(JobId.safeParse("job_../../etc").success).toBe(false);
  });

  it("only knows the Base Sepolia testnet", () => {
    expect(PaymentNetwork.safeParse("base-sepolia").success).toBe(true);
    expect(PaymentNetwork.safeParse("base").success).toBe(false);
  });
});

describe("protocol parts", () => {
  it("accepts a valid quote.json and tolerates unknown keys", () => {
    const raw = JSON.stringify({
      protocol: "haggle.v0",
      type: "quote",
      job_id: "job_abc123",
      total_usd: 995,
      per_head_usd: 24.88,
      deposit_usd: 5,
      items: [{ description: "12 veg mains", quantity: 12, tags: ["vegetarian"] }],
      x_seller_extension: { anything: true },
    });
    const r = parseProtocolPart(QuotePart, raw);
    expect(r.ok).toBe(true);
  });

  it("reports malformed JSON without throwing", () => {
    const r = parseProtocolPart(QuotePart, "{ total_usd: 995");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/invalid JSON/);
  });

  it("rejects a quote.json with the wrong type for a known field", () => {
    const raw = JSON.stringify({ protocol: "haggle.v0", type: "quote", job_id: "job_abc123", total_usd: "995" });
    expect(parseProtocolPart(QuotePart, raw).ok).toBe(false);
  });

  it("rejects negative prices", () => {
    const raw = JSON.stringify({ protocol: "haggle.v0", type: "quote", job_id: "job_abc123", total_usd: -1 });
    expect(parseProtocolPart(QuotePart, raw).ok).toBe(false);
  });

  it("requires an honest basis on counters", () => {
    expect(
      CounterPart.safeParse({
        protocol: "haggle.v0",
        type: "counter",
        job_id: "job_abc123",
        round: 1,
        target_total_usd: 1000,
        respond_by: "2026-10-20T17:00:00Z",
      }).success,
    ).toBe(false);
  });
});
