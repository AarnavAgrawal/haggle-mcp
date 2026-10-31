// Pen marks (DESIGN.md "a marked-up quote"): hand-drawn SVG strokes around real text. Each mark means
// something; never use one as decoration.
//   <Struck>      a price superseded by negotiation (pen-blue strike; the text is a <del>)
//   <Circled>     Haggle's recommendation (a loose pen ellipse around the total)
//   <Highlighted> money saved (a highlighter swipe behind the text; the only use of --highlight)
//   <PenUnderline/> / <Underlined>  where you are (current nav item, active tab)
// The SVGs are aria-hidden and stretch to their content (preserveAspectRatio="none"; straight marks use
// a non-scaling stroke so the line weight stays constant). `animate` draws the mark once (~450ms, the
// circle ~650ms; `delay` in ms to orchestrate several); prefers-reduced-motion shows it already drawn.
import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

interface MarkProps {
  children: ReactNode;
  /** Draw the mark once when it mounts. */
  animate?: boolean;
  /** Milliseconds before the drawing starts (with animate). */
  delay?: number;
  className?: string;
}

const drawStyle = (animate?: boolean, delay?: number): CSSProperties | undefined => (animate && delay ? ({ "--pen-delay": `${delay}ms` } as CSSProperties) : undefined);

function MarkSvg({ d, viewBox, className, fill }: { d: string; viewBox: string; className: string; fill?: boolean }) {
  return (
    <svg className={cx("pen-svg", className)} viewBox={viewBox} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d={d} pathLength={1} className={fill ? "pen-fill" : "pen-stroke"} />
    </svg>
  );
}

// A ballpoint strike: rises slightly left to right, with a small wobble and a tail.
const STRIKE = "M1.5 13.2 C 14 12.4, 27 13.6, 41 12 S 66 10.4, 80 9.9 C 88 9.6, 94 9.1, 98.5 7.6";

export interface StruckProps extends MarkProps {
  /** Read before the struck text by screen readers (default "was"). Empty string to omit. */
  srPrefix?: string;
}

/** A superseded price: <Struck>$1,380</Struck> <Price amount={1240} />. */
export function Struck({ children, animate, delay, className, srPrefix = "was" }: StruckProps) {
  return (
    <span className={cx("pen", "pen-struck", className)} data-animate={animate || undefined} style={drawStyle(animate, delay)}>
      <del>
        {srPrefix ? <span className="sr-only">{srPrefix} </span> : null}
        {children}
      </del>
      <MarkSvg d={STRIKE} viewBox="0 0 100 20" className="pen-struck-svg" />
    </span>
  );
}

// A loose ellipse drawn in one go, starting top-right and overshooting its start.
const CIRCLE = "M62 4.2 C 38 1.6, 9 5.4, 4.4 17.6 C 1.4 27.8, 21 36.4, 50 36.2 C 78 36, 97.6 29.4, 96.2 18.2 C 95 8.2, 76 3, 50 3.8 C 41 4.2, 33 5.6, 27.5 8";

/** Haggle's recommendation: <Circled><Price amount={1150} size="l" /></Circled>. Say "Recommended" in words nearby. */
export function Circled({ children, animate, delay, className }: MarkProps) {
  return (
    <span className={cx("pen", "pen-circled", className)} data-animate={animate || undefined} style={drawStyle(animate, delay)}>
      {children}
      <MarkSvg d={CIRCLE} viewBox="0 0 100 40" className="pen-circled-svg" />
    </span>
  );
}

// A chisel-tip swipe: slightly uneven top and bottom edges, a touch taller at the start.
const SWIPE = "M1.2 4.6 C 18 3.2, 46 2.6, 72 3.1 C 84 3.3, 93 3.4, 99 4.4 L 98.2 15.8 C 80 17.2, 52 16.9, 30 17.4 C 18 17.6, 8 17.8, 1.8 17.2 Z";

/** Money saved: <Highlighted><Price amount={140} sign="-" size="s" /></Highlighted>. */
export function Highlighted({ children, animate, delay, className }: MarkProps) {
  return (
    <span className={cx("pen", "pen-hl", className)} data-animate={animate || undefined} style={drawStyle(animate, delay)}>
      <MarkSvg d={SWIPE} viewBox="0 0 100 20" className="pen-hl-svg" fill />
      <span className="pen-hl-text">{children}</span>
    </span>
  );
}

const UNDERLINE = "M1.5 5.4 C 20 3.6, 46 4.6, 66 3.9 S 92 3.2, 98.5 2.4";

/**
 * "You are here": an absolutely positioned pen underline along the bottom of its nearest positioned
 * ancestor (give the parent position: relative). Render it only when the item is current.
 */
export function PenUnderline({ animate, delay, className }: Omit<MarkProps, "children">) {
  return (
    <span className={cx("pen-underline", className)} data-animate={animate || undefined} style={drawStyle(animate, delay)} aria-hidden="true">
      <MarkSvg d={UNDERLINE} viewBox="0 0 100 8" className="pen-underline-svg" />
    </span>
  );
}

/** Inline text with the "you are here" underline: <Underlined>Vendors</Underlined>. */
export function Underlined({ children, animate, delay, className }: MarkProps) {
  return (
    <span className={cx("pen", "pen-under", className)}>
      {children}
      <PenUnderline animate={animate} delay={delay} />
    </span>
  );
}
