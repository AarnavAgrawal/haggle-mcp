"use client";
// One settings group (a heading and a definition list). For the owner it has Edit, which turns the rows
// into Fields with Save and Cancel. Save sends only the fields that changed to /api/settings, keeps the
// button pending until the refreshed page has arrived (useTransition + router.refresh()), and shows the
// server's refusal next to the field or under the form.
import { useId, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { validateSettingsForm, type SettingsField } from "@/lib/settings/form";
import type { SettingsSaved } from "@/lib/settings/types";
import { settingsApi, type SettingsApiError } from "./api";

export interface EditableRow {
  label: string;
  /** What the row shows when not editing. */
  view: ReactNode;
  /** Present when the row is editable: the field it changes and its current value as typed. */
  edit?: { field: SettingsField; value: string; hint?: ReactNode; placeholder?: string; inputMode?: "text" | "email" | "tel" | "decimal"; autoComplete?: string; optional?: boolean; list?: string };
}

export function EditableGroup({ id, title, rows, canEdit, note, children, onSaved }: {
  id: string;
  title: string;
  rows: EditableRow[];
  canEdit: boolean;
  note?: ReactNode;
  /** Shown under the rows (pending approver changes). */
  children?: ReactNode;
  onSaved?: (r: SettingsSaved) => void;
}) {
  const router = useRouter();
  const formId = useId();
  const editable = rows.filter((r) => r.edit);
  const initial = () => Object.fromEntries(editable.map((r) => [r.edit!.field, r.edit!.value])) as Record<string, string>;
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [errors, setErrors] = useState<Partial<Record<SettingsField, string>>>({});
  const [failure, setFailure] = useState<SettingsApiError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = () => {
    setValues(initial());
    setErrors({});
    setFailure(null);
    setSaved(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setErrors({});
    setFailure(null);
  };
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const before = initial();
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v.trim() !== (before[k] ?? "").trim()));
    if (!Object.keys(changed).length) {
      setEditing(false);
      return;
    }
    const checked = validateSettingsForm(changed);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setFailure(null);
    start(async () => {
      const r = await settingsApi<SettingsSaved>("/api/settings", changed);
      if (!r.ok) {
        if (r.fields) setErrors(r.fields as Partial<Record<SettingsField, string>>);
        setFailure(r.error);
        return;
      }
      onSaved?.(r);
      setSaved(r.pending_verification.length ? "Saved. The new approver takes effect once confirmed." : "Saved.");
      setEditing(false);
      router.refresh();
    });
  };

  return (
    <section className="set-group" aria-labelledby={id}>
      <div className="set-group-head">
        <h2 id={id}>{title}</h2>
        {canEdit && !editing ? (
          <Button size="s" variant="quiet" onClick={open} aria-label={`Edit ${title.toLowerCase()}`}>
            Edit
          </Button>
        ) : null}
      </div>
      {editing ? (
        <form className="set-form" id={formId} onSubmit={save} noValidate>
          {rows.map((r) =>
            r.edit ? (
              <Field key={r.label} label={r.label} hint={r.edit.hint} error={errors[r.edit.field]} optional={r.edit.optional}>
                <input
                  name={r.edit.field}
                  value={values[r.edit.field] ?? ""}
                  onChange={(ev) => setValues((v) => ({ ...v, [r.edit!.field]: ev.target.value }))}
                  placeholder={r.edit.placeholder}
                  inputMode={r.edit.inputMode}
                  type={r.edit.inputMode === "email" ? "email" : r.edit.inputMode === "tel" ? "tel" : "text"}
                  autoComplete={r.edit.autoComplete ?? "off"}
                  list={r.edit.list}
                  disabled={pending}
                />
              </Field>
            ) : null,
          )}
          {failure ? (
            <p className="set-fail" role="alert">
              {failure.message} {failure.fix}
            </p>
          ) : null}
          <div className="set-actions">
            <Button type="submit" variant="primary" size="s" pending={pending}>
              {pending ? "Saving" : "Save"}
            </Button>
            <Button size="s" variant="quiet" onClick={cancel} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="set-body">
          <dl className="set-dl">
            {rows.map((r) => (
              <div key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.view}</dd>
              </div>
            ))}
          </dl>
          {saved ? (
            <p className="set-saved" role="status">
              {saved}
            </p>
          ) : null}
        </div>
      )}
      {children}
      {note ? <p className="set-note">{note}</p> : null}
    </section>
  );
}
