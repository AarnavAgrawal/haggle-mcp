/**
 * Turn brain data into view payloads (packages/core/views.ts), so the `ask` and
 * `business_profile` tools can return them as structuredContent unchanged.
 */
import {
  BusinessProfile,
  Estimates,
  Request,
  type Estimate,
  type Profile,
  type ProfileHistoryEntry,
} from "@haggle/core";
import { money, moneyRange, unitLabel } from "./normalize.ts";

const ESTIMATE_NOTE =
  "Estimates from what these businesses quoted before, not quotes. Nothing is ordered until a business confirms.";

export function toEstimatesView(input: Request, estimates: Estimate[]): Estimates {
  const req = Request.parse(input);
  const request = {
    what: req.what,
    ...(req.quantity ? { quantity: req.quantity } : {}),
    ...(req.date ? { date: req.date } : {}),
    ...(req.area ? { area: req.area } : {}),
  };
  const args = [
    `what:'${req.what}'`,
    req.quantity ? `quantity:${req.quantity}` : "",
    req.date ? `date:'${req.date}'` : "",
    req.area ? `area:'${req.area}'` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const next = estimates.length
    ? `To get confirmed prices, call deal(request={${args}}, businesses=[${estimates.map((e) => `'${e.business_id}'`).join(",")}]).`
    : `No learned business matches yet. Start a cold deal: deal(request={${args}}, discover=true).`;
  return Estimates.parse({ request, estimates, note: ESTIMATE_NOTE, next });
}

export function toBusinessProfileView(p: Profile): BusinessProfile {
  const unit = unitLabel(p.category);
  const price_model = p.per_unit_usd
    ? `${moneyRange(p.per_unit_usd.low, p.per_unit_usd.high)} per ${unit}`
    : p.price_model === "flat"
      ? "Flat quotes per order"
      : "Not quoted yet";

  const minimum = [
    p.minimum_order_usd ? `${money(p.minimum_order_usd)} minimum order` : "",
    p.minimum_quantity ? `${p.minimum_quantity} ${unit === "person" ? "people" : "units"} minimum` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const deposit_rule =
    p.deposit_pct !== undefined
      ? `${Math.round(p.deposit_pct * 100)}% deposit${p.flags_seen.includes("hidden_deposit") ? ", stated only in the fine print" : ""}`
      : undefined;

  return BusinessProfile.parse({
    business_id: p.business_id,
    name: p.name,
    category: p.category,
    ...(p.area ? { area: titleCase(p.area) } : {}),
    best_channel: p.best_channel,
    channels: p.channels_seen,
    menu: p.menu,
    price_model,
    ...(minimum ? { minimum } : {}),
    ...(deposit_rule ? { deposit_rule } : {}),
    discount_behavior: discountBehavior(p),
    reply_speed: replySpeed(p),
    history: [...p.history]
      .reverse()
      .slice(0, 10)
      .map((h) => ({
        date: h.date.slice(0, 10),
        channel: h.channel,
        ...(h.total_usd !== undefined ? { total_usd: h.total_usd } : {}),
        note: historyNote(h, unit),
      })),
    n_quotes: p.n_quotes,
    confidence: p.confidence,
    next: `Get a real quote with deal(request=..., businesses=['${p.business_id}']), or an instant estimate with ask(what, quantity, date, area).`,
  });
}

function discountBehavior(p: Profile): string {
  if (p.discount_pct === undefined) return "Not negotiated with yet";
  if (p.discount_pct < 0.01) return "Hasn't moved on price when asked";
  const pct = `Drops ~${Math.round(p.discount_pct * 100)}%`;
  return p.discount_needs_competing_quote
    ? `${pct} when shown a real competing quote; doesn't move otherwise`
    : `${pct} when asked`;
}

function replySpeed(p: Profile): string {
  const extras: string[] = [];
  if (p.asks_questions) extras.push("asks questions before quoting");
  const suffix = extras.length ? `; ${extras.join(", ")}` : "";
  if (p.best_channel === "phone") return `Quotes on the phone${suffix}`;
  const m = p.median_reply_minutes;
  if (m === undefined) return `Reply speed unknown${suffix}`;
  if (p.best_channel === "a2a" && m < 1) return `Replies instantly over A2A${suffix}`;
  const via = p.best_channel === "email" ? " by email" : p.best_channel === "imessage" ? " by iMessage" : "";
  return `Usually replies in ~${formatMinutes(m)}${via}${suffix}`;
}

function formatMinutes(m: number): string {
  if (m < 1) return "a minute";
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 60 * 36) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
}

function historyNote(h: ProfileHistoryEntry, unit: string): string {
  const people = h.quantity ? ` for ${h.quantity} ${unit === "person" ? "people" : "units"}` : "";
  switch (h.kind) {
    case "quote":
      if (h.round >= 2 && h.negotiated_from && h.total_usd !== undefined) {
        const pct = Math.round((1 - h.total_usd / h.negotiated_from) * 100);
        return pct > 0 ? `Dropped ${pct}% from ${money(h.negotiated_from)} in negotiation` : `Held at ${money(h.negotiated_from)} in negotiation`;
      }
      return `Quote${people}`;
    case "question":
      return "Asked a question before quoting";
    case "decline":
      return "Declined";
    case "no_answer":
      return "No answer";
    default:
      return "Replied";
  }
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
