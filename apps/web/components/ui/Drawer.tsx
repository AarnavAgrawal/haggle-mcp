"use client";
// <Drawer open onClose label>: a slide-in panel on a modal <dialog>. showModal() makes the rest of the
// page inert (focus stays inside), Esc and a click on the backdrop close it, and focus returns to
// whatever opened it. Slides in over 200ms (none under reduced motion). Controlled: the parent owns
// `open` and sets it false in onClose.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog (and the visible heading when `title` isn't given). */
  label: string;
  /** Visible heading; omit for a drawer whose content brings its own (the app rail). */
  title?: ReactNode;
  /** Which edge it slides from. */
  side?: "left" | "right";
  /** Panel width (CSS length); default min(320px, 88vw) on the left, min(440px, 100vw) on the right. */
  width?: string;
  className?: string;
  children: ReactNode;
}

export function Drawer({ open, onClose, label, title, side = "left", width, className, children }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // One path for every way of closing (Esc, backdrop, the close button, the parent): the dialog's
  // close event tells the parent and puts focus back where it was.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const handle = () => {
      onCloseRef.current();
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus();
    };
    d.addEventListener("close", handle);
    return () => d.removeEventListener("close", handle);
  }, []);

  return (
    <dialog
      ref={ref}
      className={cx("drawer", `drawer-${side}`, className)}
      aria-label={title ? undefined : label}
      aria-labelledby={title ? titleId : undefined}
      style={width ? { width } : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget) ref.current?.close(); // the backdrop (the panel fills the dialog)
      }}
    >
      <div className="drawer-panel">
        <div className={cx("drawer-head", !title && "drawer-head-bare")}>
          {title ? (
            <h2 className="drawer-title" id={titleId}>
              {title}
            </h2>
          ) : null}
          <button type="button" className="btn btn-quiet btn-icon drawer-close" aria-label="Close" onClick={() => ref.current?.close()}>
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </dialog>
  );
}
