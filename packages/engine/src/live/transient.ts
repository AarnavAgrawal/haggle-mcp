// Is a failure worth retrying (the same input may well succeed in a moment)? Used by the Inkbox
// webhook (503 + Retry-After vs a permanent 4xx) and by the Postgres store (one retry of a read).
// "unknown" is neither: most likely a bug, retrying won't fix it, but nothing must be dropped.
import { InkboxAPIError, InkboxConnectionError } from "@inkbox/sdk";

export type FailureKind = "transient" | "permanent" | "unknown";

// Node/undici socket errors and postgres.js connection errors.
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "EMAXCONNSESSION",
]);
// Postgres SQLSTATEs: connection exceptions (08xxx), too many connections / out of resources (53xxx),
// server shutting down (57P01-57P03), statement timeout (57014), serialization failure, deadlock, lock timeout.
const TRANSIENT_SQLSTATE = /^(08...|53...|57P0[123]|57014|40001|40P01|55P03)$/;
// Supabase's pooler reports a full session pool as a plain error message.
const TRANSIENT_MESSAGE = /EMAXCONNSESSION|max clients reached|too many (connections|clients)|remaining connection slots|connection terminated|socket hang up|fetch failed|timed? ?out|ECONNRESET|ETIMEDOUT|overloaded/i;
// Anthropic SDK error classes worth retrying (also matched by HTTP status below).
const TRANSIENT_NAMES = new Set(["RetryLater", "AbortError", "TimeoutError", "APIConnectionError", "APIConnectionTimeoutError", "RateLimitError", "InternalServerError", "OverloadedError"]);

const status = (e: unknown) => {
  const s = (e as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
};

export function classifyFailure(e: unknown): FailureKind {
  if (!e || typeof e !== "object") return "unknown";
  if (e instanceof InkboxConnectionError) return "transient";
  const err = e as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (typeof err.name === "string" && TRANSIENT_NAMES.has(err.name)) return "transient";
  if (typeof err.code === "string" && (TRANSIENT_CODES.has(err.code) || TRANSIENT_SQLSTATE.test(err.code))) return "transient";
  const s = status(e);
  if (s !== undefined && (s === 408 || s === 425 || s === 429 || s >= 500)) return "transient";
  if (typeof err.message === "string" && TRANSIENT_MESSAGE.test(err.message)) return "transient";
  // fetch() wraps the socket error: TypeError("fetch failed", { cause: ECONNRESET }).
  if (err.cause && err.cause !== e && classifyFailure(err.cause) === "transient") return "transient";
  // A definite answer from an API that won't change on retry (a 404 message, a 403 key scope, a 422).
  if (e instanceof InkboxAPIError || (s !== undefined && s >= 400 && s < 500)) return "permanent";
  return "unknown";
}

export const isTransient = (e: unknown) => classifyFailure(e) === "transient";
