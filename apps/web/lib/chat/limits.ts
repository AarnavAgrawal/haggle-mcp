// Chat configuration and the chat limits' sizes (the limiters themselves are wired in lib/limiters.ts:
// shared by every server instance through the database, see lib/rateLimit.ts).
import { DEFAULT_CHAT_MODEL } from "./agent";
import { unlimited, type Limiter } from "../rateLimit.ts";

/** ANTHROPIC_API_KEY (null when unset: the route says so in the stream) and WEB_CHAT_MODEL. */
export function chatConfig(): { apiKey: string | null; model: string } {
  return { apiKey: process.env.ANTHROPIC_API_KEY?.trim() || null, model: process.env.WEB_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL };
}

/** Per user: 20 turns per 10-minute window. */
export const TURN_LIMIT = 20;
export const TURN_WINDOW_S = 10 * 60;
export const DAY_S = 86_400;

/**
 * A site-wide cap on chat turns per UTC day (WEB_CHAT_DAILY_CAP; 0 or unset = no cap), so a shared
 * demo link can't run up the Claude bill. Taken with the key "site"; `limiter` builds the counter.
 */
export function dailyCap(cap: number, limiter: (max: number, windowS: number) => Limiter): Limiter {
  const n = Math.floor(cap);
  return Number.isFinite(n) && n > 0 ? limiter(n, DAY_S) : unlimited;
}
