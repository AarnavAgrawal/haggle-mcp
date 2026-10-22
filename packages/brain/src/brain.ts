/**
 * The real brain: learns business profiles from every reply and answers from them.
 * Implements the Brain contract in packages/core/contracts.ts.
 */
import {
  QuoteLike,
  Request,
  type Brain,
  type Business,
  type Estimate,
  type Hints,
  type ParsedReply,
  type PriceVerdict,
  type Profile,
  type ReplyMeta,
} from "@haggle/core";
import baselines from "../../../fixtures/brain/price-baselines.json" with { type: "json" };
import seedReplies from "../../../fixtures/brain/seed-replies.json" with { type: "json" };
import { loadDirectory, routeChannel, type DirectoryEntry } from "./directory.ts";
import { applyReply } from "./learn.ts";
import {
  SAFETY_FLAGS,
  areaLabel,
  categoryOf,
  clamp,
  median,
  moneyRange,
  normalizeArea,
  round2,
  slug,
  unitLabel,
} from "./normalize.ts";
import { MemoryStore, type ProfileStore } from "./store.ts";

export interface BrainOptions {
  store?: ProfileStore;
  directory?: DirectoryEntry[];
  /** Replay fixtures/brain/seed-replies.json into an empty store so warm asks work from minute one. */
  seed?: boolean;
  now?: () => Date;
}

type Baseline = { category: string; area?: string; low: number; typical: number; high: number };

/** Below this many real per-unit prices, price checks lean on the baseline table. */
const MIN_SAMPLES = 3;

export function createBrain(options: BrainOptions = {}): Brain & { ready: Promise<void> } {
  const store = options.store ?? new MemoryStore();
  const directory = options.directory ?? loadDirectory();
  const now = options.now ?? (() => new Date());
  const locks = new Map<string, Promise<unknown>>();

  /** Serialize read-modify-write per business so concurrent replies don't lose updates. */
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    locks.set(key, run.catch(() => undefined));
    return run;
  }

  async function learnFromReply(businessId: string, parsed: ParsedReply, meta: ReplyMeta): Promise<Profile> {
    return withLock(businessId, async () => {
      const next = applyReply(await store.get(businessId), businessId, parsed, meta, now());
      await store.put(next);
      return next;
    });
  }

  const seed = async () => {
    if (!options.seed) return;
    if ((await store.list()).length > 0) return;
    for (const r of seedReplies as { business_id: string; parsed: ParsedReply; meta: ReplyMeta }[]) {
      await learnFromReply(r.business_id, r.parsed, r.meta);
    }
  };
  const ready = seed();
  // A failed start-up (e.g. a store blip) is retried on the next call, not kept until restart.
  let seeding = ready;
  async function seeded(): Promise<void> {
    try {
      await seeding;
    } catch {
      seeding = seed();
      await seeding;
    }
  }

  async function profiles(): Promise<Profile[]> {
    await seeded();
    return store.list();
  }

  async function getProfile(business: string): Promise<Profile | null> {
    await seeded();
    const direct = await store.get(business);
    if (direct) return direct;
    const key = slug(business);
    return (await store.list()).find((p) => slug(p.name) === key || slug(p.business_id) === key) ?? null;
  }

  async function estimate(input: Request): Promise<Estimate[]> {
    const req = Request.parse(input);
    const category = categoryOf(req);
    const area = normalizeArea(req.area);
    const unit = unitLabel(category);

    const out: Estimate[] = [];
    for (const p of await profiles()) {
      // per_unit_usd.typical <= 0: a profile learned before $0 totals were treated as unknown.
      if (p.category !== category || !p.per_unit_usd || p.per_unit_usd.typical <= 0 || p.n_quotes === 0) continue;
      if (area && p.area && p.area !== area) continue;
      if (p.flags_seen.some((f) => SAFETY_FLAGS.has(f))) continue;

      const quantity = req.quantity ?? median(p.history.flatMap((h) => (h.quantity ? [h.quantity] : []))) ?? 1;
      const perUnit = p.per_unit_usd.typical;
      // Estimates are rough by nature: whole dollars, never below the business's minimum order.
      const total = Math.max(Math.round(perUnit * quantity), p.minimum_order_usd ?? 0);
      const spread = (p.per_unit_usd.high - p.per_unit_usd.low) / perUnit;

      const basis = [`based on ${p.n_quotes} real quote${p.n_quotes === 1 ? "" : "s"}`];
      basis.push(`${moneyRange(p.per_unit_usd.low, p.per_unit_usd.high)} per ${unit}`);
      if (p.discount_pct && p.discount_pct >= 0.03) {
        basis.push(
          `usually drops ~${Math.round(p.discount_pct * 100)}%${p.discount_needs_competing_quote ? " against a competing quote" : " when asked"}`,
        );
      }
      if (p.flags_seen.includes("requirement_unmet")) basis.push("missed a requirement last time");

      out.push({
        business_id: p.business_id,
        business: p.name,
        total_usd: round2(total),
        per_unit_usd: round2(perUnit),
        confidence: round2(clamp(p.confidence * (1 - Math.min(0.3, spread / 2)), 0.05, 0.95)),
        n_quotes: p.n_quotes,
        best_channel: p.best_channel,
        basis: `${basis[0]}, ${basis.slice(1).join("; ")}`,
      });
    }
    return out.sort((a, b) => a.total_usd - b.total_usd);
  }

  async function checkPrice(input: QuoteLike): Promise<PriceVerdict> {
    const q = QuoteLike.parse(input);
    const owner = q.business_id ? await getProfile(q.business_id) : null;
    const category = q.category ? categoryOf({ what: q.category }) : (owner?.category ?? "catering");
    const area = normalizeArea(q.area) ?? owner?.area;
    const quantity = q.quantity;
    const perUnit = q.per_unit_usd ?? (quantity ? q.total_usd / quantity : undefined);
    const unit = unitLabel(category);

    const all = await profiles();
    const samplesIn = (filterArea: boolean) =>
      all
        .filter((p) => p.category === category && !p.flags_seen.some((f) => SAFETY_FLAGS.has(f)))
        .filter((p) => !filterArea || !area || !p.area || p.area === area)
        .flatMap((p) => p.history.flatMap((h) => (h.kind === "quote" && h.per_unit_usd ? [h.per_unit_usd] : [])));
    let samples = samplesIn(true);
    if (samples.length < MIN_SAMPLES) samples = samplesIn(false);

    const baseline = findBaseline(category, area);
    let typical: number | undefined;
    let low: number | undefined;
    let high: number | undefined;
    if (samples.length >= MIN_SAMPLES) {
      typical = median(samples)!;
      low = Math.min(...samples);
      high = Math.max(...samples);
    } else if (baseline) {
      typical = baseline.typical;
      low = baseline.low;
      high = baseline.high;
    }

    const where = `${quantity ? `${quantity} ${unit === "person" ? "people" : "units"}` : category} in ${areaLabel(area)}`;
    if (perUnit === undefined || typical === undefined) {
      return {
        verdict: "unknown",
        sample_size: samples.length,
        summary:
          typical === undefined
            ? `No price data yet for ${category} in ${areaLabel(area)}; can't judge this price.`
            : `Pass quantity (or per_unit_usd) to check this price against ${where}.`,
        ...(typical !== undefined ? { typical_per_unit_usd: round2(typical) } : {}),
      };
    }

    const delta = perUnit / typical - 1;
    const verdict = delta <= -0.07 ? "good" : delta >= 0.12 ? "high" : "typical";
    const pct = Math.round(Math.abs(delta) * 100);
    const summary =
      pct < 3
        ? `About typical for ${where} (~$${Math.round(typical)}/${unit})`
        : `${pct}% ${delta > 0 ? "above" : "below"} typical for ${where}`;

    return {
      verdict,
      typical_per_unit_usd: round2(typical),
      range_per_unit_usd: { low: round2(low!), high: round2(high!) },
      delta_pct: round2(delta),
      sample_size: samples.length >= MIN_SAMPLES ? samples.length : 0,
      summary,
    };
  }

  async function negotiationHints(businessId: string, input: Request): Promise<Hints> {
    const req = Request.parse(input);
    const p = await getProfile(businessId);
    const negotiated = p?.history.some((h) => h.round >= 2) ?? false;
    if (!p || !negotiated) {
      return {
        business_id: businessId,
        expected_discount_pct: 0.05,
        cite_competing_quote: true,
        tactics: [
          "No negotiation history yet: cite the best real competing quote (total and what it includes).",
          "Ask for a specific target total, not 'your best price'.",
          ...(p?.asks_questions ? ["This business asks questions before quoting; answer them up front."] : []),
        ],
        confidence: 0.3,
      };
    }

    const discount = p.discount_pct ?? 0;
    const needsQuote = p.discount_needs_competing_quote ?? true;
    const perUnits = p.history.flatMap((h) => (h.kind === "quote" && h.per_unit_usd ? [h.per_unit_usd] : []));
    const tactics: string[] = [];
    if (discount < 0.01) {
      tactics.push("Has never moved on price; negotiate extras instead (delivery, setup, plates) or move on.");
    } else if (needsQuote) {
      tactics.push(
        `Dropped ~${Math.round(discount * 100)}% before, only after seeing a real competing quote: cite one (never invent it).`,
      );
    } else {
      tactics.push(`Dropped ~${Math.round(discount * 100)}% before when simply asked; ask for a specific target.`);
    }
    if (p.deposit_pct && p.deposit_pct >= 0.25) {
      tactics.push(`Asks for a ${Math.round(p.deposit_pct * 100)}% deposit; ask to lower it or pay on delivery.`);
    }
    if (req.quantity && p.minimum_quantity && req.quantity < p.minimum_quantity) {
      tactics.push(`Request is below its ${p.minimum_quantity}-${unitLabel(p.category)} minimum; expect a surcharge.`);
    }
    return {
      business_id: p.business_id,
      expected_discount_pct: round2(discount),
      cite_competing_quote: needsQuote,
      ...(perUnits.length ? { floor_per_unit_usd: round2(Math.min(...perUnits)) } : {}),
      tactics,
      confidence: p.confidence,
    };
  }

  async function discover(categoryIn: string, areaIn: string, count: number): Promise<Business[]> {
    const category = categoryOf({ what: categoryIn });
    const area = normalizeArea(areaIn);
    const learned = new Map((await profiles()).map((p) => [p.business_id, p]));

    const matches = directory.filter((e) => e.category === category && (!area || e.area === area));
    // Learned and safe businesses first (most confident first); never-seen next; flagged last.
    const rank = (e: DirectoryEntry) => {
      const p = learned.get(e.id);
      if (!p) return 0;
      if (p.flags_seen.some((f) => SAFETY_FLAGS.has(f))) return -1;
      return 1 + p.confidence;
    };
    return [...matches]
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, Math.max(0, count))
      .map((e) => {
        const learnedChannel = learned.get(e.id)?.best_channel;
        // An operator's channel override wins; a texted or called business is offered without its email.
        const preferred = e.prefer_channel && hasContact(e, e.prefer_channel) ? e.prefer_channel : undefined;
        const reachable = preferred ?? (learnedChannel && hasContact(e, learnedChannel) ? learnedChannel : routeChannel(e));
        const byPhone = preferred === "imessage" || preferred === "phone";
        return {
          id: e.id,
          name: e.name,
          ...(e.email && !byPhone ? { email: e.email } : {}),
          ...(e.phone ? { phone: e.phone } : {}),
          ...(e.a2a_card_url ? { a2a_card_url: e.a2a_card_url } : {}),
          best_channel: reachable,
          source: e.source,
        };
      });
  }

  return { learnFromReply, estimate, checkPrice, negotiationHints, discover, getProfile, ready };
}

function hasContact(e: DirectoryEntry, channel: string): boolean {
  if (channel === "a2a") return !!e.a2a_card_url;
  if (channel === "email") return !!e.email;
  if (channel === "phone" || channel === "imessage") return !!e.phone;
  return false;
}

function findBaseline(category: string, area: string | undefined): Baseline | undefined {
  const table = baselines as Baseline[];
  return (
    table.find((b) => b.category === category && b.area === area) ?? table.find((b) => b.category === category && !b.area)
  );
}
