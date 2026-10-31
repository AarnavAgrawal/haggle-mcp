// <Field label hint error>: a labelled input, select or textarea with its hint and error wired up
// (id, aria-describedby, aria-invalid). Pass exactly one control as the child.
import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import { cx } from "./cx";

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" };

export interface FieldProps {
  label: ReactNode;
  /** One short line under the label. */
  hint?: ReactNode;
  /** What's wrong and how to fix it; marks the control invalid. */
  error?: ReactNode;
  /** The control's id (defaults to the child's id, else a generated one). */
  id?: string;
  /** Show "Optional" after the label. */
  optional?: boolean;
  className?: string;
  children: ReactElement<ControlProps>;
}

export function Field({ label, hint, error, id, optional, className, children }: FieldProps) {
  const auto = useId();
  const controlId = id ?? children.props.id ?? `f${auto.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [children.props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("field", error ? "field-invalid" : null, className)}>
      <label className="field-label" htmlFor={controlId}>
        {label}
        {optional ? <span className="field-optional">Optional</span> : null}
      </label>
      {hint ? (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {cloneElement(children, { id: controlId, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true } : {}) })}
      {error ? (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
