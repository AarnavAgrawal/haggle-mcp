// <Button>: the app's button. Renders the .btn class API (components/ui/ui.css), so a <Link> or <a> can
// look the same with className={buttonClass("primary")}. `pending` keeps the button in place, disables
// it and sets aria-busy="true", which draws a small progress stroke along its bottom edge.
import type { ButtonHTMLAttributes, Ref } from "react";
import { cx } from "./cx";

export type ButtonVariant = "default" | "primary" | "quiet" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** default: white with a rule; primary: pen blue; quiet: text only; danger: risk red. */
  variant?: ButtonVariant;
  /** m (40px, default) or s (32px, for rails, toolbars and table rows). */
  size?: "m" | "s";
  /** Full width. */
  block?: boolean;
  /** An action is in flight: disabled, aria-busy, progress stroke. Keep the label (or say what's happening). */
  pending?: boolean;
  /** Square icon-only button; give it an aria-label. */
  icon?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** buttonClass("primary", { block: true }) -> "btn btn-primary btn-block", for links styled as buttons. */
export function buttonClass(variant: ButtonVariant = "default", opts: { size?: "m" | "s"; block?: boolean; icon?: boolean; className?: string } = {}): string {
  return cx("btn", variant !== "default" && `btn-${variant}`, opts.size === "s" && "btn-s", opts.block && "btn-block", opts.icon && "btn-icon", opts.className);
}

export function Button({ variant = "default", size = "m", block, pending, icon, className, disabled, type = "button", children, ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} className={buttonClass(variant, { size, block, icon, className })} disabled={disabled || pending} aria-busy={pending || undefined}>
      {children}
    </button>
  );
}
