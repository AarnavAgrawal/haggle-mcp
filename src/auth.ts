// Shared-secret checks for the MCP endpoint, the tick route, and the live page.
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a presented secret against the configured one.
 * Accepts a raw value or an "Authorization: Bearer <value>" header. An unset
 * expected secret never matches, so a route with no secret configured is closed.
 */
export function secretMatches(presented: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  const given = Buffer.from(presented?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}
