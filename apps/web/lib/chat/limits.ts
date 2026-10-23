// Chat configuration and the per-user turn limit (in memory, per server instance).
import { DEFAULT_CHAT_MODEL } from "./agent";

/** ANTHROPIC_API_KEY (null when unset: the route says so in the stream) and WEB_CHAT_MODEL. */
export function chatConfig(): { apiKey: string | null; model: string } {
  return { apiKey: process.env.ANTHROPIC_API_KEY?.trim() || null, model: process.env.WEB_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL };
}

export const TURN_LIMIT = 20;
export const TURN_WINDOW_MS = 10 * 60 * 1000;

/** A sliding-window limiter: at most `limit` turns per user in `windowMs`. */
export function turnLimiter(limit = TURN_LIMIT, windowMs = TURN_WINDOW_MS) {
  const seen = new Map<string, number[]>();
  return function takeTurn(userId: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
    const recent = (seen.get(userId) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      seen.set(userId, recent);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000)) };
    }
    recent.push(now);
    seen.set(userId, recent);
    // Keep the map small: drop users with no recent turns now and then.
    if (seen.size > 5000) for (const [k, v] of seen) if (!v.some((t) => now - t < windowMs)) seen.delete(k);
    return { ok: true };
  };
}

/** The process-wide limiter the chat route uses. */
export const takeTurn = turnLimiter();

/**
 * A site-wide cap on chat turns per UTC day (WEB_CHAT_DAILY_CAP; 0 or unset = no cap), so a shared
 * demo link can't run up the Claude bill. In memory, per server instance.
 */
export function dailyCap(cap: number) {
  let day = "";
  let used = 0;
  return function take(now = Date.now()): { ok: true } | { ok: false } {
    if (!(cap > 0)) return { ok: true };
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
    if (used >= cap) return { ok: false };
    used++;
    return { ok: true };
  };
}
export const takeDailyTurn = dailyCap(Number(process.env.WEB_CHAT_DAILY_CAP ?? "0"));
