// Live deal updates as server-sent events: the stream route's logic, pure and testable with a fake
// Haggle client. It long-polls wait_for_update while the browser is connected and emits frames:
//   event: ready   { cursor, state? }            once, when the stream starts
//   event: update  { cursor, state, updates }    whenever something changed
//   event: end     { reason, cursor, state? }    terminal state, or the ~5 minute limit (reconnect with ?cursor=)
//   event: problem { code, message, fix }        the server refused or was unreachable (not "error":
//                                                 EventSource uses that name for its own connection errors)
// Heartbeat comments are the route's job (a timer), so this function stays deterministic.
import { HaggleError, type HaggleClient } from "../haggle";
import { isTerminal } from "./format";
import type { WaitResult } from "./types";

/** One SSE frame. JSON.stringify never emits raw newlines, so `data:` stays one line. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An SSE comment (ignored by EventSource; keeps proxies from closing an idle stream). */
export const sseComment = (text: string) => `: ${text.replace(/[\r\n]+/g, " ")}\n\n`;

/** A cursor from the query string: digits only, else null (start fresh). */
export function parseCursor(raw: string | null | undefined): string | null {
  return raw && /^\d{1,18}$/.test(raw) ? raw : null;
}

export type StreamEnd = "terminal" | "max_duration" | "aborted" | "error";

export interface StreamOptions {
  /** Seconds per wait_for_update long-poll (server max 60). */
  timeoutS?: number;
  /** Stop after this long; the client reconnects with the last cursor. */
  maxMs?: number;
  now?: () => number;
}

type Caller = Pick<HaggleClient, "callTool">;

export async function streamUpdates(
  haggle: Caller,
  jobId: string,
  cursor: string | null,
  signal: AbortSignal,
  emit: (frame: string) => void,
  opts: StreamOptions = {},
): Promise<{ reason: StreamEnd; cursor: string | null }> {
  const timeoutS = opts.timeoutS ?? 25;
  const maxMs = opts.maxMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const start = now();
  let cur: string | null = cursor;
  const wait = (c: string, t: number) => haggle.callTool<WaitResult>("wait_for_update", { job_id: jobId, cursor: c, timeout_s: t }, signal);

  try {
    if (cur === null) {
      // Fresh page: the page already rendered the current board, so only learn where "now" is.
      const first = (await wait("0", 0)).data;
      cur = first.cursor;
      emit(sseFrame("ready", { cursor: cur, state: first.state }));
      if (isTerminal(first.state)) {
        emit(sseFrame("end", { reason: "terminal", cursor: cur, state: first.state }));
        return { reason: "terminal", cursor: cur };
      }
    } else {
      emit(sseFrame("ready", { cursor: cur }));
    }

    let at: string = cur;
    while (!signal.aborted) {
      const left = maxMs - (now() - start);
      if (left <= 0) {
        emit(sseFrame("end", { reason: "max_duration", cursor: at }));
        return { reason: "max_duration", cursor: at };
      }
      const r: WaitResult = (await wait(at, Math.max(1, Math.min(timeoutS, Math.ceil(left / 1000))))).data;
      cur = at = r.cursor;
      if (r.updates.length) emit(sseFrame("update", { cursor: cur, state: r.state, updates: r.updates }));
      if (isTerminal(r.state)) {
        emit(sseFrame("end", { reason: "terminal", cursor: cur, state: r.state }));
        return { reason: "terminal", cursor: cur };
      }
    }
    return { reason: "aborted", cursor: cur };
  } catch (err) {
    if (signal.aborted) return { reason: "aborted", cursor: cur };
    const e = err instanceof HaggleError
      ? { code: err.code, message: err.message, fix: err.fix }
      : { code: "unreachable", message: "The Haggle server couldn't be reached.", fix: "Live updates will retry; reload the page if this persists." };
    emit(sseFrame("problem", e));
    return { reason: "error", cursor: cur };
  }
}
