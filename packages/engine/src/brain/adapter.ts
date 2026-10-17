// The engine/brain seam. Wraps the real v5 brain (@haggle/core Brain, implemented by @haggle/brain)
// in the engine-internal Brain interface (../contract.ts), so the engine's workflow stays unchanged.
//
// - One engine reply can carry several items (quote + question); the v5 brain takes one flat
//   ParsedReply per call, so each item becomes its own learnFromReply call.
// - Business ids (decision D1): the brain is keyed by directory ids ("biz_bay_catering"). The engine
//   keeps its own row ids (sha256 of the contact) and this adapter translates at the seam by email,
//   phone or Agent Card URL, then by exact name for simulated fleet businesses only. A business the
//   directory doesn't know keeps the engine id in the brain too.
// - Only replies from trusted senders teach the brain (business text is untrusted data).
import type {
  Brain as CoreBrain, Business as CoreBusiness, Estimate as CoreEstimate, ParsedReply as CoreParsedReply,
  Profile as CoreProfile, Request as CoreRequest,
} from "@haggle/core/contracts";
import type { Brain, Business, Estimate, Hints, ParsedReply, PriceVerdict, Profile, QuoteLike, ReplyMeta, Request } from "../contract.ts";
import { businessIdForContact, slugify } from "../ids.ts";

/** A business the brain's directory knows (DirectoryEntry from @haggle/brain). */
export interface DirectoryContact {
  id: string;
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
  a2a_card_url?: string | undefined;
}

/** A business the engine knows (its configured fleet). */
export interface EngineContact {
  business_id: string;
  name: string;
  email?: string;
  phone?: string;
  simulated?: boolean;
}

export interface BrainAdapterOptions {
  brain: CoreBrain;
  directory?: DirectoryContact[];
  fleet?: EngineContact[];
  /** Mock mode: discover offers only these (the simulated fleet the mock email port can play). */
  discovery?: Business[];
}

const norm = (s: string | undefined | null) => (s ?? "").trim().toLowerCase();

export class BrainAdapter implements Brain {
  /** The real brain, for callers (MCP warm-path tools) that speak the v5 contract directly. */
  readonly core: CoreBrain;
  private readonly directory: DirectoryContact[];
  private readonly engine = new Map<string, EngineContact>();
  private readonly discovery: Business[] | undefined;

  constructor(opts: BrainAdapterOptions) {
    this.core = opts.brain;
    this.directory = opts.directory ?? [];
    for (const b of opts.fleet ?? []) this.engine.set(b.business_id, b);
    this.discovery = opts.discovery;
  }

  /** Brain (directory) id for an engine business id. */
  brainIdFor(engineId: string, hint: { email?: string; phone?: string; name?: string; simulated?: boolean } = {}): string {
    const known = this.engine.get(engineId);
    const email = norm(hint.email ?? known?.email);
    const phone = norm(hint.phone ?? known?.phone);
    const name = norm(hint.name ?? known?.name);
    const simulated = hint.simulated ?? known?.simulated ?? false;
    const hit =
      (email && this.directory.find((d) => norm(d.email) === email)) ||
      (phone && this.directory.find((d) => norm(d.phone) === phone)) ||
      (simulated && name && this.directory.find((d) => norm(d.name) === name)) ||
      undefined;
    return hit ? hit.id : engineId;
  }

  /** Engine id for a business the brain returned (deterministic from its contact). */
  engineIdFor(b: { id: string; email?: string | undefined; phone?: string | undefined; a2a_card_url?: string | undefined }): string {
    try {
      return businessIdForContact({ email: b.email ?? null, phone: b.phone ?? null, a2a_card_url: b.a2a_card_url ?? null });
    } catch {
      return b.id;
    }
  }

  async learnFromReply(businessId: string, parsed: ParsedReply, meta: ReplyMeta): Promise<Profile> {
    const phone = meta.business_email.startsWith("tel:") ? meta.business_email.slice(4) : undefined;
    const email = phone ? undefined : meta.business_email;
    const known = this.engine.get(businessId);
    const brainId = this.brainIdFor(businessId, { ...(email ? { email } : {}), ...(phone ? { phone } : {}), simulated: meta.simulated });
    const name = known?.name ?? this.directory.find((d) => d.id === brainId)?.name ?? brainId;
    let last: CoreProfile | null = null;
    if (meta.sender_trusted) {
      const request = toCoreRequest(meta.request);
      for (const reply of toCoreReplies(parsed, meta)) {
        last = await this.core.learnFromReply(brainId, reply, {
          job_id: meta.job_id, business_name: name, channel: meta.reply_channel ?? (phone ? "phone" : "email"), received_at: meta.received_at,
          contacted_at: meta.rfq_sent_at, round: reply.kind === "quote" ? roundOf(parsed) : 1, request,
          business_id: brainId, message_id: meta.message_id, format: meta.channel, sender_trusted: true, simulated: meta.simulated,
        });
      }
    }
    return toEngineProfile(last, businessId, name, meta.simulated);
  }

  async estimate(req: Request): Promise<Estimate[]> {
    return (await this.core.estimate(toCoreRequest(req))).map((e) => toEngineEstimate(e, this.engineIdForBrainId(e.business_id)));
  }

  async checkPrice(q: QuoteLike): Promise<PriceVerdict> {
    const v = await this.core.checkPrice({
      total_usd: q.total_usd, quantity: q.request.quantity, area: q.request.area,
      ...(q.business_id ? { business_id: this.brainIdFor(q.business_id) } : {}),
    });
    const qty = q.request.quantity;
    return {
      verdict: v.verdict, sample_size: v.sample_size, basis: v.summary,
      ...(v.delta_pct !== undefined ? { delta_pct: Math.round(v.delta_pct * 100) } : {}), // fraction → percent
      ...(v.range_per_unit_usd && qty ? { typical_low_usd: round2(v.range_per_unit_usd.low * qty), typical_high_usd: round2(v.range_per_unit_usd.high * qty) } : {}),
    };
  }

  async negotiationHints(businessId: string, req: Request): Promise<Hints> {
    const h = await this.core.negotiationHints(this.brainIdFor(businessId), toCoreRequest(req));
    return {
      business_id: businessId, responds_to_competing_quote: h.cite_competing_quote, usual_concession_pct: Math.round(h.expected_discount_pct * 100),
      ...(h.floor_per_unit_usd !== undefined && req.quantity ? { floor_hint_usd: round2(h.floor_per_unit_usd * req.quantity) } : {}),
      max_rounds_suggested: 1, sample_size: 0, confidence: h.confidence,
    };
  }

  async discover(category: string, area: string, count: number): Promise<Business[]> {
    if (this.discovery) return this.discovery.slice(0, count);
    return (await this.core.discover(category, area, count)).map((b) => this.toEngineBusiness(b));
  }

  /** Engine businessProfile() reads this when present. */
  async getProfile(business: string): Promise<Profile | null> {
    const p = (await this.core.getProfile(this.brainIdFor(business))) ?? (await this.core.getProfile(business));
    return p ? toEngineProfile(p, this.engineIdForBrainId(p.business_id), p.name, false) : null;
  }

  private engineIdForBrainId(brainId: string): string {
    const d = this.directory.find((x) => x.id === brainId);
    return d ? this.engineIdFor(d) : brainId;
  }

  private toEngineBusiness(b: CoreBusiness): Business & { phone?: string; a2a_card_url?: string } {
    const id = this.engineIdFor(b);
    const simulated = b.simulated ?? b.source === "haggle-directory";
    this.engine.set(id, { business_id: id, name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), simulated });
    return {
      business_id: id, slug: slugify(b.name), name: b.name, email: b.email ?? "", source: "agent", simulated,
      ...(b.found_at ? { found_at: b.found_at } : { found_at: b.source }), ...(b.phone ? { phone: b.phone } : {}),
      ...(b.a2a_card_url ? { a2a_card_url: b.a2a_card_url } : {}),
    };
  }
}

// ───────────────────────────── mapping helpers ─────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

function roundOf(parsed: ParsedReply): number {
  for (const it of parsed.items) if (it.kind === "quote") return Math.max(1, it.quote.round);
  return 1;
}

export function toCoreRequest(r: Request): CoreRequest {
  return {
    what: r.what, quantity: r.quantity, date: r.date, area: r.area,
    ...(r.unit ? { unit: r.unit } : {}), ...(r.budget_usd !== undefined ? { budget_usd: r.budget_usd } : {}),
    requirements: r.requirements.map((q) => ({ id: q.id, kind: q.kind, text: q.text, hard: q.hard, ...(q.min_count !== undefined ? { min_count: q.min_count } : {}) })),
  };
}

/** One flat v5 ParsedReply per learnable item (quote, question, decline). */
export function toCoreReplies(parsed: ParsedReply, meta: ReplyMeta): CoreParsedReply[] {
  const injection = parsed.injection_detected;
  const out: CoreParsedReply[] = [];
  for (const it of parsed.items) {
    if (it.kind === "quote") {
      const q = it.quote;
      out.push({
        kind: "quote", total_usd: q.total_usd, quantity: meta.request.quantity, items: q.items, confidence: q.confidence,
        flags: [...new Set([...q.flags, ...(injection ? ["prompt_injection"] : [])])],
        ...(q.per_unit_usd !== undefined ? { per_unit_usd: q.per_unit_usd } : {}),
        ...(q.deposit_usd !== undefined ? { deposit_usd: q.deposit_usd } : {}),
        ...(q.delivery_usd !== undefined ? { delivery_usd: q.delivery_usd } : {}),
        ...(injection ? { injection_detected: true } : {}),
      });
    } else if (it.kind === "question") {
      out.push({ kind: "question", question: it.text, question_id: it.question_id, items: [], flags: injection ? ["prompt_injection"] : [] });
    } else if (it.kind === "decline") {
      out.push({ kind: "decline", items: [], flags: [] });
    } else if (it.kind === "payment_request" && it.rail === "external_link") {
      // A pay-now link is never followed; the brain learns the business does this.
      out.push({ kind: "other", items: [], flags: ["external_payment_link", ...(injection ? ["prompt_injection"] : [])] });
    }
  }
  return out;
}

function toEngineEstimate(e: CoreEstimate, engineId: string): Estimate {
  return {
    kind: "estimate", business_id: engineId, business: e.business, estimate_usd: e.total_usd,
    low_usd: e.low_usd ?? e.total_usd, high_usd: e.high_usd ?? e.total_usd, confidence: e.confidence,
    quote_count: e.n_quotes, simulated: e.simulated ?? true, basis: e.basis,
    ...(e.per_unit_usd !== undefined ? { per_unit_usd: e.per_unit_usd } : {}),
  };
}

function toEngineProfile(p: CoreProfile | null, engineId: string, name: string, simulated: boolean): Profile {
  if (!p) {
    return {
      business_id: engineId, slug: slugify(name), name, simulated, menu: [], price_model: {},
      discount_behavior: { responds_to_competing_quote: null }, quote_count: 0, confidence: 0, updated_at: new Date().toISOString(),
    };
  }
  return {
    business_id: engineId, slug: slugify(p.name), name: p.name, simulated, menu: p.menu,
    price_model: {
      ...(p.per_unit_usd ? { typical_per_unit_usd: p.per_unit_usd.typical } : {}),
      ...(p.minimum_order_usd !== undefined ? { minimum_order_usd: p.minimum_order_usd } : {}),
    },
    ...(p.deposit_pct !== undefined ? { deposit_rule: { kind: "percent" as const, value: Math.round(p.deposit_pct * 100) } } : {}),
    discount_behavior: {
      responds_to_competing_quote: p.discount_needs_competing_quote ?? null,
      ...(p.discount_pct !== undefined ? { usual_concession_pct: Math.round(p.discount_pct * 100) } : {}),
    },
    ...(p.median_reply_minutes !== undefined ? { median_reply_s: Math.round(p.median_reply_minutes * 60) } : {}),
    quote_count: p.n_quotes, confidence: p.confidence, updated_at: p.updated_at,
  };
}
