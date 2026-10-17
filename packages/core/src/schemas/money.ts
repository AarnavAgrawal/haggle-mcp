import { z } from "zod";

/**
 * Money is always carried internally as an integer count of US cents.
 * Floating-point dollars only appear at the edges (protocol JSON, display).
 */
export const Cents = z.number().int().safe();
export type Cents = z.infer<typeof Cents>;

export const NonNegativeCents = Cents.nonnegative();

/** USDC has 6 decimals; amounts on the x402 rail are integer base units. */
export const USDC_DECIMALS = 6;
export const UsdcBaseUnits = z
  .string()
  .regex(/^\d+$/, "USDC base units must be a non-negative integer string");
export type UsdcBaseUnits = z.infer<typeof UsdcBaseUnits>;

/**
 * Convert a dollar amount (as found in JSON or text) to cents without
 * float drift. Rejects values with more than 2 fractional digits rather than
 * silently rounding a seller's stated price.
 */
export function usdToCents(usd: number | string): Cents {
  const text = typeof usd === "number" ? numberToPlainString(usd) : usd.trim().replace(/[$,\s]/g, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new MoneyError(`Not a valid USD amount with at most 2 decimals: ${String(usd)}`);
  const [, sign, whole, frac = ""] = match;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`USD amount out of range: ${String(usd)}`);
  return sign ? -cents : cents;
}

export function centsToUsd(cents: Cents): number {
  return cents / 100;
}

export function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** 1 cent = 10^4 USDC base units (USDC is pegged 1:1 to USD on test rails). */
export function centsToUsdcBaseUnits(cents: Cents): UsdcBaseUnits {
  if (cents < 0) throw new MoneyError("Negative amounts cannot be paid");
  return (BigInt(cents) * 10_000n).toString();
}

/** Exact conversion; throws if the base-unit amount is not a whole number of cents. */
export function usdcBaseUnitsToCents(units: UsdcBaseUnits): Cents {
  const value = BigInt(UsdcBaseUnits.parse(units));
  if (value % 10_000n !== 0n) throw new MoneyError(`USDC amount ${units} is not a whole number of cents`);
  const cents = value / 10_000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError(`USDC amount out of range: ${units}`);
  return Number(cents);
}

export class MoneyError extends Error {
  override name = "MoneyError";
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError(`Not a finite amount: ${n}`);
  // toFixed(6) then trim avoids exponent notation and exposes >2-decimal inputs.
  return n.toFixed(6).replace(/\.?0+$/, "");
}
