// PURE: which reply-parsing failures are worth another try on a later tick.
//
// Transient: the provider was busy or unreachable (HTTP 408/409/429, any 5xx incl. 529 "overloaded",
// connection reset / timeout). The Anthropic SDK already retries those twice inside one call; if they
// still fail, the message stays `pending` and is retried on later ticks, at most MAX_PARSE_RETRIES
// times with growing delays (each attempt is a `parse_retry` job event, so the count survives
// restarts and needs no new column). Permanent (400 invalid_request, 401/403 auth, a refusal, no
// structured output): the message is marked `failed` at once. A message already `failed` is never
// read again (getPendingMessages only returns `pending`).

export const MAX_PARSE_RETRIES = 3;

/** Delay before retry n (1-based): 30 s, 60 s, 120 s. */
export function parseRetryDelayMs(attempt: number): number {
  return 30_000 * 2 ** Math.max(0, attempt - 1);
}

export function isTransientParseError(err: unknown): boolean {
  const e = err as { status?: unknown; name?: unknown; message?: unknown; code?: unknown; cause?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  const status = typeof e.status === "number" ? e.status : null;
  if (status !== null) return status === 408 || status === 409 || status === 429 || status >= 500;
  const name = typeof e.name === "string" ? e.name : "";
  if (/APIConnection(Timeout)?Error|AbortError|TimeoutError|FetchError/.test(name)) return true;
  const text = `${typeof e.message === "string" ? e.message : ""} ${typeof e.code === "string" ? e.code : ""}`;
  if (/overloaded|rate.?limit|too many requests|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network error|timed? ?out|connection error/i.test(text)) return true;
  return e.cause ? isTransientParseError(e.cause) : false;
}

/** A short, safe label for the board/log (never the provider's raw message). */
export function parseErrorKind(err: unknown): string {
  const e = err as { status?: unknown; name?: unknown } | null;
  if (e && typeof e.status === "number") return e.status === 429 ? "rate_limited" : e.status === 529 || e.status === 503 ? "overloaded" : e.status >= 500 ? "provider_error" : `http_${e.status}`;
  return isTransientParseError(err) ? "network" : typeof e?.name === "string" && e.name ? e.name : "error";
}
