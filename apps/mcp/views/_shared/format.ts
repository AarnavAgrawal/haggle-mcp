/** Pure display helpers shared by the views (no React, no CSS), so tests can run them without a DOM. */

export type ToolErrorInfo = { code?: string; message: string; fix?: string; next?: string };

/**
 * A failed tool call as one readable line. Haggle tools fail with isError and JSON text
 * `{ ok:false, error:{ code, message, fix }, next }`; mcp-use surfaces that text as the error's message.
 */
export function parseToolError(e: unknown): ToolErrorInfo {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  try {
    const j = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown; fix?: unknown }; next?: unknown };
    if (j && typeof j.error?.message === "string") {
      return {
        message: j.error.message,
        ...(typeof j.error.code === "string" ? { code: j.error.code } : {}),
        ...(typeof j.error.fix === "string" && j.error.fix ? { fix: j.error.fix } : {}),
        ...(typeof j.next === "string" && j.next && j.next !== "none" ? { next: j.next } : {}),
      };
    }
  } catch {
    // Not JSON: a transport or host error; show it as is.
  }
  return { message: raw || "Something went wrong. Try again." };
}

/** parseToolError as one line: "message fix". */
export function toolErrorText(e: unknown): string {
  const t = parseToolError(e);
  return t.fix ? `${t.message} ${t.fix}` : t.message;
}

export type AskFieldType = "money" | "number" | "date" | "time" | "text" | "boolean";

/** A custom-ask answer for a cell: money as USD, booleans yes/no, null (not stated) as "—". */
export function formatField(value: number | string | boolean | null | undefined, type: AskFieldType): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (type === "money" && typeof value === "number") return formatUsd(value);
  if (type === "number" && typeof value === "number") return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (type === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T12:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  }
  return String(value);
}

function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const KIND_LABEL: Record<string, string> = {
  rfq: "Request for quote",
  reply: "Reply",
  followup: "Follow-up",
  follow_up: "Follow-up",
  answer: "Answer",
  counter: "Counteroffer",
  message: "Message",
  confirmation: "Confirmation",
  call: "Call",
  quarantine: "Quarantined (unverified sender)",
  quarantined: "Quarantined (unverified sender)",
};

/** Conversation entry kind as a label; unknown kinds read as words ("approval_reply" → "Approval reply"). */
export function kindLabel(kind: string): string {
  const k = kind.toLowerCase();
  if (KIND_LABEL[k]) return KIND_LABEL[k];
  const words = k.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Message";
}

/** Call hours (local hours, e.g. { start: 9, end: 18 }) as "9 AM – 6 PM". */
export function callHoursText(h: { start: number; end: number }): string {
  return `${hourText(h.start)} – ${hourText(h.end)}`;
}

function hourText(hour: number): string {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  const m = Math.round((hour - Math.floor(hour)) * 60);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${suffix}`;
}

/** Long enough to collapse behind "Show more" (characters or lines). */
export function isLongText(text: string, maxChars = 320, maxLines = 6): boolean {
  return text.length > maxChars || text.split("\n").length > maxLines;
}
