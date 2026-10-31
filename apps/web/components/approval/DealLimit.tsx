"use client";
// The deal's spending limit on the deal board, changed by the signed-in human (docs/state-and-next-fixes.md
// §5): raise it up to the server ceiling, or lower it. One POST to /api/deals/<id>/limit (the service
// route /internal/approvals/raise-limit); the model can never reach it. A refusal shows its fix.
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { postAction, usd, type ApiError } from "./post";
import "./approval.css";

export interface DealLimitProps {
  jobId: string;
  limitUsd: number;
  /** "default": no limit set yet, the workspace default applies at approval. */
  source?: string;
  /** False once the deal is closed. */
  editable: boolean;
}

const SOURCE_WORDS: Record<string, string> = { budget: "from your budget", stated: "as you stated", human: "set by you", operator: "set by the operator", default: "default for new deals" };

export function DealLimit({ jobId, limitUsd, source, editable }: DealLimitProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(limitUsd));
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [, startRefresh] = useTransition();

  async function save() {
    const n = Number(value.replace(/[$,\s]/g, ""));
    if (!(n > 0)) {
      setError({ code: "bad_limit", message: "The limit must be a positive amount.", fix: "Enter a dollar amount, e.g. 1200." });
      return;
    }
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    const r = await postAction<{ limit_usd: number }>(`/api/deals/${encodeURIComponent(jobId)}/limit`, { limit_usd: Math.round(n * 100) / 100 });
    busy.current = false;
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setEditing(false);
    startRefresh(() => router.refresh());
  }

  return (
    <span className="deal-limit">
      {editing ? (
        <span className="deal-limit-edit">
          <label className="sr-only" htmlFor={`limit-${jobId}`}>
            Spending limit for this deal (USD)
          </label>
          <input id={`limit-${jobId}`} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} disabled={saving} size={8} />
          <Button size="s" variant="primary" onClick={save} pending={saving}>
            Save
          </Button>
          <Button size="s" variant="quiet" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Button>
        </span>
      ) : (
        <>
          {usd(limitUsd)}
          {source && SOURCE_WORDS[source] ? <span className="hint"> ({SOURCE_WORDS[source]})</span> : null}
          {editable ? (
            <>
              {" "}
              <Button size="s" variant="quiet" onClick={() => setEditing(true)}>
                Change
              </Button>
            </>
          ) : null}
        </>
      )}
      {error && (
        <span className="note note-risk" role="alert">
          {error.message}
          {error.fix && <span className="ap-sub"> {error.fix}</span>}
        </span>
      )}
    </span>
  );
}
