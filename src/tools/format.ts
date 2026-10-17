// Compact output helpers (DESIGN.md §8.1): money as "22.50", masked emails,
// and the success/error MCP result envelopes.
import { ConfigError } from "../config.js";
import { ToolError, type ToolErrorBody } from "./errors.js";

/** 2250 -> "22.50". null stays null so missing values are visible, not zero. */
export function money(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return null;
  return (cents / 100).toFixed(2);
}

/** Dollars from tool input -> integer cents. */
export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

/** "aarnav@gmail.com" -> "a***@gmail.com". Never return the human's full address. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local[0]}***@${domain}`;
}

/** Successful tool result. `data` must match the tool's outputSchema. */
export function ok<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/** Expected failure: isError with the shared error body as JSON text. */
export function fail(body: ToolErrorBody) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: body }) }],
  };
}

/**
 * Wrap a tool body so known failures become clean error results.
 * Unexpected errors are logged (message only) and reported as INTERNAL.
 */
export async function runTool<R>(name: string, body: () => Promise<R>): Promise<R | ReturnType<typeof fail>> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof ToolError) return fail(err.body);
    if (err instanceof ConfigError) {
      return fail({
        code: "CONFIG_MISSING",
        message: "The server is not fully configured yet.",
        retryable: false,
        next_step: "Ask the server operator to set the missing environment variables.",
        details: { missing: err.missing },
      });
    }
    console.error(`[${name}] unexpected error:`, err instanceof Error ? err.message : err);
    return fail({
      code: "INTERNAL",
      message: "Unexpected server error.",
      retryable: true,
      next_step: "Retry once. If it fails again, call get_job to check the job state.",
    });
  }
}
