// <Sheet>: a white panel on the desk (8px radius, 1px rule, no shadow). <EmptyState>: an empty sheet
// that invites the next action.
import type { ReactNode } from "react";
import { cx } from "./cx";

type SheetTag = "div" | "section" | "article" | "aside" | "li" | "form";

export interface SheetProps {
  as?: SheetTag;
  /** m: 20px 24px (default); s: 12px 16px; none: content runs to the edge (tables, row lists). */
  pad?: "none" | "s" | "m";
  className?: string;
  children: ReactNode;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export function Sheet({ as: Tag = "div", pad = "m", className, children, ...rest }: SheetProps) {
  return (
    <Tag className={cx("ui-sheet", pad !== "m" && `ui-sheet-pad-${pad}`, className)} {...rest}>
      {children}
    </Tag>
  );
}

export interface EmptyStateProps {
  title: ReactNode;
  /** The next step, usually one primary button or link. */
  action?: ReactNode;
  /** One short sentence, if it genuinely helps. */
  children?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
}

export function EmptyState({ title, action, children, headingLevel = 2, className }: EmptyStateProps) {
  const H = headingLevel === 3 ? "h3" : "h2";
  return (
    <div className={cx("ui-sheet", "empty", className)}>
      <H className="empty-title">{title}</H>
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
