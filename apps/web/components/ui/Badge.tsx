// <Badge>: the one pill in the app, used only for the Demo marker (DESIGN.md). Anything else that
// looks like a badge is a <Status> (dot + words) instead.
import type { ReactNode } from "react";
import { cx } from "./cx";

export function Badge({ children = "Demo", className, title }: { children?: ReactNode; className?: string; title?: string }) {
  return (
    <span className={cx("badge", className)} title={title}>
      {children}
    </span>
  );
}
