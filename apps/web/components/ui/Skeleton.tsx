// <Skeleton w h> and <SkeletonText lines>: placeholders shaped like the content that is coming. The
// shimmer stops under reduced motion. Decorative (aria-hidden): mark the loading region aria-busy="true".
import type { CSSProperties } from "react";
import { cx } from "./cx";

type Len = number | string;
const len = (v: Len | undefined) => (typeof v === "number" ? `${v}px` : v);

export function Skeleton({ w = "100%", h = 14, radius, className, style }: { w?: Len; h?: Len; radius?: Len; className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={cx("skeleton", className)} style={{ width: len(w), height: len(h), borderRadius: len(radius), ...style }} />;
}

const WIDTHS = ["100%", "92%", "84%", "96%", "88%"];

export function SkeletonText({ lines = 3, lineHeight = 12, gap = 10, className }: { lines?: number; lineHeight?: number; gap?: number; className?: string }) {
  return (
    <span aria-hidden="true" className={cx("skeleton-text", className)} style={{ gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} h={lineHeight} w={i === lines - 1 && lines > 1 ? "58%" : WIDTHS[i % WIDTHS.length]} />
      ))}
    </span>
  );
}
