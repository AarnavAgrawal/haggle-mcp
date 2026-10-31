"use client";
// A rail link that knows whether it is the current page (aria-current + the pen underline under its
// label). match="prefix" also marks sub-pages (a deal's business pages).
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PenUnderline } from "@/components/ui/PenMarks";
import { cx } from "@/components/ui/cx";

export function RailLink({ href, match = "exact", className, label, children }: { href: string; match?: "exact" | "prefix"; className?: string; label: ReactNode; children?: ReactNode }) {
  const pathname = usePathname() ?? "";
  const current = pathname === href || (match === "prefix" && pathname.startsWith(`${href}/`));
  return (
    <Link href={href} className={cx("rail-link", className)} aria-current={current ? "page" : undefined}>
      <span className="rail-link-label">
        {label}
        {current ? <PenUnderline animate /> : null}
      </span>
      {children}
    </Link>
  );
}
