// <StatusDot tone> and <Status tone>words</Status>: status is an 8px dot + words, never a pill.
// live: something is happening now (the dot breathes; still under reduced motion). ok: done well.
// hold: needs you, or waiting. risk: failed, declined. idle: finished or nothing happening.
import type { ReactNode } from "react";
import { cx } from "./cx";

export type StatusTone = "live" | "ok" | "hold" | "risk" | "idle";

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return <span className={cx("dot", `dot-${tone}`, className)} aria-hidden="true" />;
}

export function Status({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("status", `status-${tone}`, className)}>
      <StatusDot tone={tone} />
      <span className="status-words">{children}</span>
    </span>
  );
}
