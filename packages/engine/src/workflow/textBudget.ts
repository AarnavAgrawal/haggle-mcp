// Inkbox's SMS spam filter: after 10 texts to one number with no reply, sendText is refused
// (422 message_blocked_spam_filter, rule unanswered_limit) until that number texts back. Seen live
// on 2026-10-18: one text per quote used the allowance in five minutes and every later update to
// the human (questions, "quotes are in") was refused and only logged. Since then the human is texted
// only when they must act or money moved, and a text refused here is held and re-sent on their reply.
import { ChannelSendError, type SmsPort } from "./ports.ts";

/** Texts Inkbox lets through to a number that hasn't replied. */
export const INKBOX_UNANSWERED_LIMIT = 10;

/** True for Inkbox's "too many texts without a reply" refusal (raw SDK error or a mapped one). */
export function isUnansweredLimitError(err: unknown): boolean {
  const e = err as { message?: unknown; detail?: unknown } | null;
  const detail = typeof e?.detail === "string" ? e.detail : JSON.stringify(e?.detail ?? "");
  return /unanswered_limit|blocked_spam_filter/i.test(`${String(e?.message ?? "")} ${detail}`);
}

/**
 * Per-number count of texts not yet answered, shared by every text Haggle sends (updates to the
 * human and follow-ups to businesses: Inkbox counts per recipient). In memory; on first use of a
 * number it is seeded from Inkbox (SmsPort.unanswered) so a restart doesn't forget earlier texts.
 */
export class TextBudget {
  private readonly unansweredBy = new Map<string, number>();
  private readonly seeded = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly port: SmsPort;
  constructor(port: SmsPort) { this.port = port; }

  /** Texts sent to this number since it last replied (best effort). */
  async unanswered(to: string): Promise<number> {
    if (!this.seeded.has(to)) {
      this.seeded.add(to);
      try {
        const n = await this.port.unanswered?.(to);
        if (typeof n === "number" && n > (this.unansweredBy.get(to) ?? 0)) this.unansweredBy.set(to, n);
      } catch {
        // Unknown: count from zero; a refusal still marks the number blocked below.
      }
    }
    return this.unansweredBy.get(to) ?? 0;
  }

  isBlocked(to: string): boolean {
    return this.blocked.has(to);
  }

  /** The number texted back: Inkbox lifts the block. Returns true when it was blocked. */
  replied(from: string): boolean {
    this.unansweredBy.set(from, 0);
    this.seeded.add(from);
    return this.blocked.delete(from);
  }

  /** The SmsPort the engine uses: counts every text and stops calling Inkbox for a blocked number. */
  wrap(): SmsPort {
    return {
      send: async (req) => {
        if (this.blocked.has(req.to)) throw new ChannelSendError("rate_limited", false, 0, "unanswered_limit: texts to this number are paused until it texts back");
        await this.unanswered(req.to);
        try {
          const out = await this.port.send(req);
          this.unansweredBy.set(req.to, (this.unansweredBy.get(req.to) ?? 0) + 1);
          return out;
        } catch (err) {
          if (isUnansweredLimitError(err)) {
            this.blocked.add(req.to);
            this.unansweredBy.set(req.to, INKBOX_UNANSWERED_LIMIT);
          }
          throw err;
        }
      },
      ...(this.port.unanswered ? { unanswered: (to: string) => this.unanswered(to) } : {}),
    };
  }
}
