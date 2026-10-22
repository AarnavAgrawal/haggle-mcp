/**
 * Business learning: fold one parsed reply (any channel) into a business profile.
 * Pure: (previous profile, reply) → next profile. Persistence lives in brain.ts.
 */
import {
  Channel,
  ParsedReply,
  Profile,
  ReplyMeta,
  Request,
  type ParsedReply as ParsedReplyInput,
  type ProfileHistoryEntry,
  type ReplyMeta as ReplyMetaInput,
} from "@haggle/core";
import { categoryOf, clamp, mean, median, normalizeArea, round2 } from "./normalize.ts";

const MAX_HISTORY = 200;
const MAX_MENU = 24;

export function applyReply(
  prev: Profile | null,
  businessId: string,
  parsedInput: ParsedReplyInput,
  metaInput: ReplyMetaInput,
  now: Date = new Date(),
): Profile {
  const parsed = ParsedReply.parse(parsedInput);
  const meta = ReplyMeta.parse(metaInput);
  const request = Request.parse(meta.request);

  const quantity = parsed.quantity ?? request.quantity;
  // The engine reports "no total stated" as 0: unknown, never a $0 price.
  const total = parsed.total_usd && parsed.total_usd > 0 ? parsed.total_usd : undefined;
  const perUnit =
    (parsed.per_unit_usd && parsed.per_unit_usd > 0 ? parsed.per_unit_usd : undefined) ??
    (total !== undefined && quantity ? round2(total / quantity) : undefined);
  const replyMinutes =
    meta.contacted_at !== undefined
      ? Math.max(0, (Date.parse(meta.received_at) - Date.parse(meta.contacted_at)) / 60_000)
      : undefined;

  const entry: ProfileHistoryEntry = compact({
    date: meta.received_at,
    job_id: meta.job_id,
    channel: meta.channel,
    kind: parsed.kind,
    total_usd: total,
    per_unit_usd: perUnit,
    quantity,
    round: meta.round,
    negotiated_from: meta.negotiated_from,
    reply_minutes: replyMinutes === undefined ? undefined : round2(replyMinutes),
  });

  // The engine may report the same reply twice (webhook retries): replace, don't double count.
  const sameReply = (h: ProfileHistoryEntry) =>
    h.job_id === entry.job_id && h.round === entry.round && h.kind === entry.kind && h.channel === entry.channel;
  const history = [...(prev?.history ?? []).filter((h) => !sameReply(h)), entry]
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .slice(-MAX_HISTORY);

  const quotes = history.filter((h) => h.kind === "quote");
  const perUnits = quotes.map((h) => h.per_unit_usd).filter((n): n is number => n !== undefined);
  const typical = median(perUnits);

  const discount = learnDiscount(prev, history, entry, meta);

  const profile = {
    business_id: businessId,
    name: meta.business_name,
    category: prev?.category ?? categoryOf(request),
    area: prev?.area ?? normalizeArea(request.area),
    best_channel: bestChannel(history, prev?.best_channel ?? meta.channel),
    channels_seen: unique([...(prev?.channels_seen ?? []), meta.channel]),
    menu: mergeMenu(prev?.menu ?? [], parsed.items),
    price_model: perUnits.length ? "per_unit" : quotes.some((h) => h.total_usd !== undefined) ? "flat" : (prev?.price_model ?? "unknown"),
    per_unit_usd:
      typical === undefined
        ? undefined
        : { low: round2(Math.min(...perUnits)), typical: round2(typical), high: round2(Math.max(...perUnits)) },
    minimum_order_usd: parsed.minimum_order_usd ?? prev?.minimum_order_usd,
    minimum_quantity: parsed.minimum_quantity ?? prev?.minimum_quantity,
    // A deposit above the total is a misread figure (e.g. per-person price taken as the total).
    deposit_pct:
      parsed.deposit_usd !== undefined && total !== undefined && parsed.deposit_usd <= total
        ? round2(parsed.deposit_usd / total)
        : prev?.deposit_pct,
    discount_pct: discount.pct,
    discount_needs_competing_quote: discount.needsCompetingQuote,
    median_reply_minutes: medianOrUndefined(history.map((h) => h.reply_minutes)),
    asks_questions: (prev?.asks_questions ?? false) || parsed.kind === "question",
    flags_seen: unique([...(prev?.flags_seen ?? []), ...parsed.flags]),
    n_quotes: quotes.length,
    history,
    confidence: round2(clamp(0.3 + 0.18 * quotes.length, 0.2, 0.95)),
    updated_at: now.toISOString(),
  };
  return Profile.parse(compact(profile));
}

/** Discount seen in negotiation rounds: 1 − revised / original. Averaged over all rounds seen. */
function learnDiscount(
  prev: Profile | null,
  history: ProfileHistoryEntry[],
  entry: ProfileHistoryEntry,
  meta: ReturnType<typeof ReplyMeta.parse>,
): { pct: number | undefined; needsCompetingQuote: boolean | undefined } {
  // From the deduped history (which already holds this reply), so a re-delivered reply counts once.
  const observed = negotiationDiscounts(history);
  let needs = prev?.discount_needs_competing_quote;
  const [current] = negotiationDiscounts([entry]);
  if (current !== undefined && current > 0.005 && meta.cited_competing_quote !== undefined) needs = meta.cited_competing_quote;
  const avg = mean(observed);
  return { pct: avg === undefined ? prev?.discount_pct : round2(avg), needsCompetingQuote: needs };
}

function negotiationDiscounts(history: ProfileHistoryEntry[]): number[] {
  return history
    .filter((h) => h.kind === "quote" && h.round >= 2 && h.negotiated_from && h.total_usd !== undefined)
    .map((h) => clamp(1 - h.total_usd! / h.negotiated_from!, 0, 1));
}

/** The channel that actually produces quotes: quotes count most, structured A2A wins ties, silence counts against. */
function bestChannel(history: ProfileHistoryEntry[], fallback: Channel): Channel {
  const score = new Map<Channel, number>();
  for (const h of history) {
    const s = h.kind === "quote" ? 3 : h.kind === "no_answer" ? -2 : h.kind === "decline" ? 0 : 1;
    score.set(h.channel, (score.get(h.channel) ?? 0) + s + (h.channel === "a2a" ? 0.5 : 0));
  }
  let best = fallback;
  let bestScore = -Infinity;
  for (const [channel, s] of score) {
    if (s > bestScore) [best, bestScore] = [channel, s];
  }
  return bestScore > 0 ? best : fallback;
}

function mergeMenu(menu: string[], items: string[]): string[] {
  const seen = new Set(menu.map((m) => m.toLowerCase()));
  const out = [...menu];
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out.slice(-MAX_MENU);
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

function medianOrUndefined(xs: (number | undefined)[]): number | undefined {
  const m = median(xs.filter((n): n is number => n !== undefined));
  return m === undefined ? undefined : round2(m);
}

/** Drop undefined keys so optional zod fields stay absent rather than `undefined`. */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
