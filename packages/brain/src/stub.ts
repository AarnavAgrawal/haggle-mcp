/**
 * Brain stub: fixed data for every brain function, so the engine and tools work before the
 * real brain does (CHECKLIST: "Brain stub"). Swap for createBrain() with no other changes.
 */
import type { Brain, Business, Estimate, Hints, PriceVerdict, Profile } from "@haggle/core";

const NOW = "2026-10-17T12:00:00-07:00";

const PROFILE: Profile = {
  business_id: "biz_harbor_table",
  name: "Harbor Table",
  category: "catering",
  area: "san francisco",
  best_channel: "email",
  channels_seen: ["email"],
  menu: ["Family-style lunch", "Grilled salmon", "Mushroom risotto (vegetarian)", "Seasonal salad (vegetarian)"],
  price_model: "per_unit",
  per_unit_usd: { low: 25.88, typical: 28.75, high: 29 },
  minimum_order_usd: 400,
  deposit_pct: 0.3,
  discount_pct: 0.1,
  discount_needs_competing_quote: true,
  median_reply_minutes: 25,
  asks_questions: false,
  flags_seen: ["hidden_deposit"],
  n_quotes: 3,
  history: [
    { date: "2026-10-09T10:20:00-07:00", job_id: "job_seed_1", channel: "email", kind: "quote", total_usd: 580, per_unit_usd: 29, quantity: 20, round: 1, reply_minutes: 22 },
    { date: "2026-10-17T13:25:00-07:00", job_id: "job_demo", channel: "email", kind: "quote", total_usd: 1150, per_unit_usd: 28.75, quantity: 40, round: 1, reply_minutes: 25 },
    { date: "2026-10-17T13:41:10-07:00", job_id: "job_demo", channel: "email", kind: "quote", total_usd: 1035, per_unit_usd: 25.88, quantity: 40, round: 2, negotiated_from: 1150, reply_minutes: 9 },
  ],
  confidence: 0.84,
  updated_at: NOW,
};

const ESTIMATES: Estimate[] = [
  { business_id: "biz_bay_catering", business: "Bay Catering", total_usd: 625, per_unit_usd: 25, confidence: 0.86, n_quotes: 3, best_channel: "a2a", basis: "based on 3 real quotes, $24–26 per person" },
  { business_id: "biz_harbor_table", business: "Harbor Table", total_usd: 650, per_unit_usd: 26, confidence: 0.78, n_quotes: 2, best_channel: "email", basis: "based on 2 real quotes, $26–29 per person; usually drops ~10% against a competing quote" },
  { business_id: "biz_mission_eats", business: "Mission Eats", total_usd: 675, per_unit_usd: 27, confidence: 0.64, n_quotes: 1, best_channel: "phone", basis: "based on 1 real quote, $27 per person" },
];

const BUSINESSES: Business[] = [
  { id: "biz_bay_catering", name: "Bay Catering", email: "bay-catering-sf@inkboxmail.com", a2a_card_url: "https://inkbox.ai/a2a/bay-catering-sf/card", best_channel: "a2a", source: "haggle-directory" },
  { id: "biz_harbor_table", name: "Harbor Table", email: "harbor-table-sf@inkboxmail.com", best_channel: "email", source: "haggle-directory" },
  { id: "biz_mission_eats", name: "Mission Eats", phone: "+14155550134", best_channel: "phone", source: "haggle-directory" },
  { id: "biz_golden_grill", name: "Golden Grill", email: "golden-grill-sf@inkboxmail.com", best_channel: "email", source: "haggle-directory" },
  { id: "biz_sunset_kitchen", name: "Sunset Kitchen", email: "sunset-kitchen-sf@inkboxmail.com", best_channel: "email", source: "haggle-directory" },
  { id: "biz_quickquote_deli", name: "QuickQuote Deli", email: "quickquote-deli-sf@inkboxmail.com", best_channel: "email", source: "haggle-directory" },
];

export function createStubBrain(): Brain {
  return {
    async learnFromReply(businessId, _parsed, meta) {
      return { ...PROFILE, business_id: businessId, name: meta.business_name };
    },
    async estimate() {
      return ESTIMATES.map((e) => ({ ...e }));
    },
    async checkPrice(q): Promise<PriceVerdict> {
      const perUnit = q.per_unit_usd ?? (q.quantity ? q.total_usd / q.quantity : 26);
      const delta = Math.round((perUnit / 26 - 1) * 100) / 100;
      return {
        verdict: delta <= -0.07 ? "good" : delta >= 0.12 ? "high" : "typical",
        typical_per_unit_usd: 26,
        range_per_unit_usd: { low: 22, high: 32 },
        delta_pct: delta,
        sample_size: 9,
        summary: `${Math.abs(Math.round(delta * 100))}% ${delta >= 0 ? "above" : "below"} typical for ${q.quantity ?? 40} people in SF (stub)`,
      };
    },
    async negotiationHints(businessId): Promise<Hints> {
      return {
        business_id: businessId,
        expected_discount_pct: 0.1,
        cite_competing_quote: true,
        floor_per_unit_usd: 25.88,
        tactics: ["Dropped ~10% before, only after seeing a real competing quote: cite one (never invent it)."],
        confidence: 0.84,
      };
    },
    async discover(_category, _area, count) {
      return BUSINESSES.slice(0, count).map((b) => ({ ...b }));
    },
    async getProfile(business) {
      return { ...PROFILE, business_id: business.startsWith("biz_") ? business : PROFILE.business_id };
    },
  };
}
