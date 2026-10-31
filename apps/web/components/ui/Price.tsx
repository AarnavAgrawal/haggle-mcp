// <Price amount>: money in the display face with tabular lining figures. A missing amount reads
// "not stated" (never $0). cents forces two decimals; sign="-" renders a saving as "−$140".
import { money } from "@/lib/dashboard/format";
import { cx } from "./cx";

export type PriceSize = "s" | "m" | "l" | "xl";

export interface PriceProps {
  amount: number | null | undefined;
  /** Always show cents ($1,240.00). Default: cents only when the amount has them. */
  cents?: boolean;
  /** s 14px, m 16px (default), l 24px, xl 36px. */
  size?: PriceSize;
  /** "-" prefixes a minus sign (savings), "+" a plus. */
  sign?: "-" | "+";
  className?: string;
}

/** The text <Price> shows: "$1,240", "$1,240.50", "$1,240.00" with cents, "not stated" when unknown. */
export function formatPrice(amount: number | null | undefined, cents = false): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return money(amount);
  return cents ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : money(amount);
}

export function Price({ amount, cents, size = "m", sign, className }: PriceProps) {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return <span className={cx("price-unknown", className)}>not stated</span>;
  return (
    <span className={cx("price", `price-${size}`, className)}>
      {sign === "-" ? "−" : sign === "+" ? "+" : ""}
      {formatPrice(sign ? Math.abs(amount) : amount, cents)}
    </span>
  );
}
