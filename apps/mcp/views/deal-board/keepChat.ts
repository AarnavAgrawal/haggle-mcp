/**
 * "Keep chat updated": when the board's own poll sees something the model should act on (a quote,
 * a business question, a finished call, quotes final, a state or payment step), the board sends ONE
 * short follow-up message so the chat continues instead of going quiet. Pure logic here (tested);
 * the view wires it to useSendFollowUp and localStorage.
 *
 * Business text is untrusted: the prompt is built from ids, names, totals, counts and states only;
 * question text and reply summaries are never echoed.
 */
import type { DealBoard } from "@haggle/core";

/** One wait_for_update update (see the engine's JobUpdate). */
export type WaitUpdate = { type: string; [key: string]: unknown };

export const MIN_GAP_MS = 45_000;
/** Updates the human just caused from this board (approve, pay, answer) don't wake the chat. */
export const OWN_ACTION_WINDOW_MS = 15_000;

// When this board last started or finished a human action (one board per iframe, so module scope).
let ownActionAt = 0;
export const markOwnAction = (now = Date.now()) => {
  ownActionAt = now;
};
export const actedRecently = (now = Date.now()) => now - ownActionAt < OWN_ACTION_WINDOW_MS;

const CALL_ENDED = /^Call with .+ ended/;
const WAKE_STATES = new Set(["awaiting_approval", "paying", "failed", "cancelled"]);

/** The updates worth waking the model for; `ownAction` drops the state/payment steps the human just took here. */
export function meaningful(updates: WaitUpdate[], ownAction = false): WaitUpdate[] {
  return updates.filter((u) => {
    if (u.type === "quote" || u.type === "question") return true;
    if (u.type === "reply") return CALL_ENDED.test(String(u.summary ?? ""));
    if (u.type === "state") return !ownAction && WAKE_STATES.has(String(u.to));
    if (u.type === "payment") return !ownAction && ["settled", "failed", "rejected"].includes(String(u.status));
    return false;
  });
}

/** Quotes are final (the engine's own hint; not business text). */
export const isReady = (board: Pick<DealBoard, "next" | "job">) => board.job.state === "awaiting_approval" || /^Quotes are final/.test(board.next);

const money = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : "a price");

/**
 * The follow-up prompt for a batch of meaningful updates, or null when there's nothing to say.
 * `ready` adds the "quotes are final" step once.
 */
export function summarize(board: Pick<DealBoard, "job" | "businesses" | "next">, updates: WaitUpdate[], ready = false): string | null {
  if (updates.length === 0 && !ready) return null;
  const name = (id: unknown) => board.businesses.find((b) => b.id === id)?.name ?? "A business";
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!seen.has(s)) (seen.add(s), parts.push(s));
  };
  let questions = 0;
  for (const u of updates) {
    if (u.type === "quote") add(`${name(u.business_id)} quoted ${money(u.total_usd)}${Number(u.round) > 1 ? ` (round ${u.round})` : ""}`);
    else if (u.type === "question") (questions++, add(`${name(u.business_id)} asked a question`));
    else if (u.type === "reply") add(`the call with ${name(u.business_id)} ended`);
    else if (u.type === "state" && u.to === "awaiting_approval") add("it's waiting for approval");
    else if (u.type === "state" && (u.to === "failed" || u.to === "cancelled")) add(`the deal ${u.to === "failed" ? "failed" : "was cancelled"}`);
    else if (u.type === "payment") add(u.status === "settled" ? "the deposit was paid" : "the payment didn't go through");
  }
  if (ready && !parts.includes("it's waiting for approval")) add("quotes are final");
  if (parts.length === 0) return null;

  const quoted = board.businesses.filter((b) => ["quoted", "negotiating", "won"].includes(b.status)).length;
  const head = `Haggle update on job ${board.job.id}: ${capitalize(parts.join("; "))} (${quoted} of ${board.businesses.length} businesses quoted).`;
  const next = questions
    ? "Answer with answer_business(job_id, question_id) from get_quotes, or ask me, then keep calling wait_for_update."
    : ready || parts.includes("it's waiting for approval")
      ? "Call get_quotes and tell me which quote to approve and why; I approve on the card."
      : "Continue the deal: call get_quotes, then keep calling wait_for_update (pass the cursor) until it's ready to approve.";
  return `${head} ${next}`;
}

/** Shared across boards for the same job (several iframes may show it): who notified what, when. */
export interface NotifyMark {
  cursor: number;
  at: number;
  ready?: boolean;
}

/** Another board for this job already notified this cursor (and the ready step, when that's what's new). */
export function covered(pendingCursor: number | null, newReady: boolean, mark: NotifyMark | null): boolean {
  if (!mark) return false;
  if (newReady && !mark.ready) return false;
  return pendingCursor === null || mark.cursor >= pendingCursor;
}

/**
 * Send now? Only with something pending (updates or quotes newly final), at most once per MIN_GAP_MS
 * across every board for this job, and not when another board already covered it.
 */
export function shouldSend(pendingCursor: number | null, newReady: boolean, mark: NotifyMark | null, now: number, minGapMs = MIN_GAP_MS): boolean {
  if (pendingCursor === null && !newReady) return false;
  if (covered(pendingCursor, newReady, mark)) return false;
  return !mark || now - mark.at >= minGapMs;
}

export const markKey = (jobId: string) => `haggle.keepChat.mark.${jobId}`;
export const toggleKey = (jobId: string) => `haggle.keepChat.on.${jobId}`;

export function readMark(jobId: string): NotifyMark | null {
  try {
    const raw = window.localStorage.getItem(markKey(jobId));
    const m = raw ? (JSON.parse(raw) as NotifyMark) : null;
    return m && typeof m.cursor === "number" && typeof m.at === "number" ? m : null;
  } catch {
    return null;
  }
}

export function writeMark(jobId: string, mark: NotifyMark) {
  try {
    window.localStorage.setItem(markKey(jobId), JSON.stringify(mark));
  } catch {
    // storage blocked (private window, sandbox): this board still rate-limits itself in memory
  }
}

export function readToggle(jobId: string): boolean {
  try {
    return window.localStorage.getItem(toggleKey(jobId)) !== "off";
  } catch {
    return true;
  }
}

export function writeToggle(jobId: string, on: boolean) {
  try {
    window.localStorage.setItem(toggleKey(jobId), on ? "on" : "off");
  } catch {
    // not persisted; the toggle still applies to this board
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
