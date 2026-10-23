// Browser-safe helpers for the live stream client (components/dashboard/LiveRefresh.tsx).

/** The stream URL, resuming from a cursor when the client has one. */
export function streamUrl(jobId: string, cursor: string | null): string {
  return `/api/deals/${encodeURIComponent(jobId)}/stream${cursor && /^\d+$/.test(cursor) ? `?cursor=${cursor}` : ""}`;
}

/** Reconnect delay after the n-th consecutive failure (1-based): 1s, 2s, 4s ... capped at 30s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** The cursor from an SSE frame's JSON data, or null. */
export function cursorOf(data: string): string | null {
  try {
    const c = (JSON.parse(data) as { cursor?: unknown }).cursor;
    return typeof c === "string" && /^\d+$/.test(c) ? c : null;
  } catch {
    return null;
  }
}
