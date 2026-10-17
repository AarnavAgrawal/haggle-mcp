import { describe, expect, it } from "vitest";
import {
  MoneyError,
  centsToUsdcBaseUnits,
  formatUsd,
  usdToCents,
  usdcBaseUnitsToCents,
} from "../src/index.ts";

describe("usdToCents", () => {
  it.each([
    [995, 99_500],
    [24.88, 2_488],
    [0.1 + 0.2, 30], // classic float drift is normalized, not propagated
    ["1,150.00", 115_000],
    ["$1,200", 120_000],
    ["0.5", 50],
  ])("%s → %d cents", (input, cents) => {
    expect(usdToCents(input)).toBe(cents);
  });

  it("rejects sub-cent precision rather than rounding a stated price", () => {
    expect(() => usdToCents("24.885")).toThrow(MoneyError);
    expect(() => usdToCents(24.885)).toThrow(MoneyError);
  });

  it("rejects non-numeric and non-finite input", () => {
    expect(() => usdToCents("about 900")).toThrow(MoneyError);
    expect(() => usdToCents(Number.NaN)).toThrow(MoneyError);
    expect(() => usdToCents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe("formatUsd", () => {
  it("formats with thousands separators and two decimals", () => {
    expect(formatUsd(99_500)).toBe("$995.00");
    expect(formatUsd(123_456_7)).toBe("$12,345.67");
    expect(formatUsd(-50)).toBe("-$0.50");
  });
});

describe("USDC base units", () => {
  it("converts cents to 6-decimal base units exactly", () => {
    expect(centsToUsdcBaseUnits(500)).toBe("5000000"); // $5.00 = 5 USDC
    expect(centsToUsdcBaseUnits(1)).toBe("10000");
  });

  it("round-trips and rejects fractional cents", () => {
    expect(usdcBaseUnitsToCents("5000000")).toBe(500);
    expect(() => usdcBaseUnitsToCents("5000001")).toThrow(MoneyError);
    expect(() => usdcBaseUnitsToCents("-1")).toThrow();
    expect(() => centsToUsdcBaseUnits(-1)).toThrow(MoneyError);
  });
});
