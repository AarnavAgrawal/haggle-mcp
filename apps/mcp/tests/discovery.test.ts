import { describe, expect, it } from "vitest";
import { DISCOVER_COUNT, fewerFound } from "../src/discovery.ts";

describe("fewerFound", () => {
  it("is silent when discovery found enough", () => {
    expect(fewerFound("mock", 6, DISCOVER_COUNT)).toBeNull();
    expect(fewerFound("live", 8, 6)).toBeNull();
  });
  it("live mode explains the configured fleet (the 2-of-6 Inspector chat case)", () => {
    expect(fewerFound("live", 2, DISCOVER_COUNT)).toBe(
      "Only 2 of the 6 requested businesses are available (live mode offers only HAGGLE_DEMO_FLEET and HAGGLE_ALLOWED_RECIPIENTS; the six-seller demo fleet runs in mock mode).",
    );
  });
  it("mock mode states the shortfall without the live explanation", () => {
    expect(fewerFound("mock", 6, 8)).toBe("Only 6 of the 8 requested businesses are available.");
  });
});
