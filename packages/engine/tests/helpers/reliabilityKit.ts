// Shared kit for the sprint 4 reliability tests (lease fencing, ambiguous provider failures, the
// failure drill): the real engine with fake providers that behave like Inkbox (the same idempotency
// key replays the original send instead of delivering it twice; a call has no key), injectable
// faults (refused, 5xx before or after the provider accepted, timeout, idempotency conflict), a fake
// clock, lease loss on demand and a way to run a side effect inside an advance. No network.
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig, type ExtractorPort } from "../../src/index.ts";
import { ChannelSendError, type A2APort, type PhonePort, type SmsPort, type IMessagePort } from "../../src/workflow/ports.ts";
import type { TrustVerdict } from "../../src/inbound/primitive.ts";
import type { Repository } from "../../src/store/types.ts";
import { BUYER, FakeInkbox } from "./fakeInkbox.ts";

export const APPROVER = "+14155550101";
export const { budget_usd: BUDGET, ...REQUEST } = GOLDEN_REQUEST;
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
export const trusted = (expected: string): TrustVerdict => ({ trusted: true, address: expected, reason: "trusted", evidence: noEvidence });

/** Reads "$1,150 total" / "$345 deposit" from the reply text (no Claude). */
export const textExtractor: ExtractorPort = {
  async extract(i) {
    const t = i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText;
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*total/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true,
      tax_usd: null, tax_included: true, total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    } as never;
  },
};

export type Clock = { now: () => Date; advance: (ms: number) => void };
export const newClock = (start = Date.now()): Clock => {
  let t = start;
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
};

/**
 * One injected provider fault, consumed by the next send on that channel:
 *   refuse         a definite "not sent/placed" (retryable: capacity, rate limit);
 *   5xx_before     the provider failed before accepting (retryable; nothing delivered);
 *   5xx_after      the provider accepted (delivered) and then answered 5xx: the response is lost;
 *   timeout_after  delivered, then the connection timed out (response lost);
 *   conflict       an idempotency conflict (409): the original may have been accepted (ambiguous);
 *   hang           never answers until released (a hung request).
 */
export type Fault = "refuse" | "5xx_before" | "5xx_after" | "timeout_after" | "conflict" | "hang";
export type ChannelName = "email" | "text" | "imessage" | "call" | "a2a";

export interface Delivery { channel: ChannelName; to: string; key: string; text: string; at: number }

/** Fake Inkbox-like providers: deliveries are what reached a business or the human (deduped by key where the provider does). */
export class FakeProviders {
  readonly deliveries: Delivery[] = [];
  /** Every attempt that reached the provider, delivered or not (for "was it attempted at all"). */
  readonly attempts: { channel: ChannelName; key: string }[] = [];
  private readonly faults = new Map<ChannelName, Fault[]>();
  private readonly accepted = new Map<string, unknown>();
  private readonly hung: (() => void)[] = [];
  /** Called right after a delivery, before the response returns (e.g. lose the lease here). */
  afterDeliver: ((d: Delivery) => void) | null = null;
  private n = 0;
  private readonly clock: Clock;
  constructor(clock: Clock) { this.clock = clock; }

  fail(channel: ChannelName, ...f: Fault[]) { this.faults.set(channel, [...(this.faults.get(channel) ?? []), ...f]); }
  /** Faults for sends to one address or number only (any channel), consumed before the channel's. */
  failTo(to: string, ...f: Fault[]) { this.faultsTo.set(to, [...(this.faultsTo.get(to) ?? []), ...f]); }
  private readonly faultsTo = new Map<string, Fault[]>();
  releaseHung() { for (const r of this.hung.splice(0)) r(); }
  to(addr: string) { return this.deliveries.filter((d) => d.to === addr); }

  private async go<T>(channel: ChannelName, key: string | null, to: string, text: string, ok: () => T, opts: { idempotent: boolean; ambiguousAfter: boolean }): Promise<T> {
    this.attempts.push({ channel, key: key ?? "" });
    const fault = this.faultsTo.get(to)?.shift() ?? this.faults.get(channel)?.shift();
    if (fault === "hang") await new Promise<void>((r) => this.hung.push(r));
    if (fault === "refuse") throw new ChannelSendError("rate_limited", true, 1_000, "capacity: not placed");
    if (fault === "5xx_before") throw new ChannelSendError("provider_error", true, 1_000, "HTTP 503 before accept");
    if (fault === "conflict") throw new ChannelSendError("provider_error", false, 0, "409 idempotency key reused with different input", true);
    const cacheKey = `${channel}|${key}`;
    if (opts.idempotent && key && this.accepted.has(cacheKey)) return this.accepted.get(cacheKey) as T; // replay: not delivered again
    const d: Delivery = { channel, to, key: key ?? "", text, at: this.clock.now().getTime() };
    this.deliveries.push(d);
    const res = ok();
    if (opts.idempotent && key) this.accepted.set(cacheKey, res);
    this.afterDeliver?.(d);
    if (fault === "5xx_after" || fault === "timeout_after") {
      const msg = fault === "5xx_after" ? "HTTP 502 after accept" : "Inkbox unreachable (timeout)";
      throw opts.ambiguousAfter ? new ChannelSendError("provider_error", false, 0, msg, true) : channel === "a2a" ? new Error(msg) : new ChannelSendError("provider_error", true, 1_000, msg);
    }
    return res;
  }

  email = {
    send: (m: { to: string; idempotencyKey: string; bodyText: string; subject: string }) =>
      this.go("email", m.idempotencyKey, m.to, `${m.subject}\n${m.bodyText}`, () => ({ providerId: `em_${m.idempotencyKey}`, status: "sent", idempotentReplay: false, messageId: `<em_${++this.n}_${m.idempotencyKey.replace(/\W/g, "")}@haggle.test>` }), { idempotent: true, ambiguousAfter: false }),
  };
  sms: SmsPort = { send: (r) => this.go("text", r.idempotencyKey, r.to, r.text, () => ({ messageId: `sms_${++this.n}` }), { idempotent: true, ambiguousAfter: false }) };
  imessage: IMessagePort = { send: (r) => this.go("imessage", r.idempotencyKey, r.to, r.text, () => ({ messageId: `im_${++this.n}` }), { idempotent: true, ambiguousAfter: false }) };
  /** Inkbox calls take no idempotency key: a 5xx or timeout after dialing is ambiguous (it may be ringing). */
  phone: PhonePort = { placeCall: (r) => this.go("call", null, r.toNumber, r.reason, () => ({ callId: `call_${++this.n}` }), { idempotent: false, ambiguousAfter: true }) };
  a2a: A2APort = {
    send: (r) => this.go("a2a", r.messageId, r.cardUrl, r.text, () => ({ taskId: `task_${++this.n}`, contextId: r.contextId ?? `ctx_${this.n}`, state: "submitted" }), { idempotent: false, ambiguousAfter: false }),
    getTask: async () => ({ state: "working", agentMessages: [] }) as never,
  };
}

/** Lease loss on demand: `lose` makes every renewal fail (another instance took the job); `renewThrows` simulates a database stall. */
export function leaseControl(repo: Repository) {
  const ctl = { lose: false, renewThrows: false };
  const renew = repo.renewJobLease.bind(repo);
  repo.renewJobLease = async (...a) => {
    if (ctl.renewThrows) throw new Error("canceling statement due to statement timeout");
    return ctl.lose ? false : renew(...a);
  };
  return ctl;
}

export type Kit = ReturnType<typeof kit>;

export function kit(config: Partial<EngineConfig> = {}, o: { repo?: Repository; clock?: Clock; providers?: FakeProviders; channels?: ChannelName[]; extractor?: ExtractorPort; instanceId?: string } = {}) {
  const clock = o.clock ?? newClock();
  const p = o.providers ?? new FakeProviders(clock);
  const repo = (o.repo ?? new InMemoryRepository({ now: clock.now })) as InMemoryRepository;
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const on = new Set(o.channels ?? ["email", "text", "call", "a2a"]);
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: o.extractor ?? textExtractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: p.email as never,
    ...(on.has("text") ? { sms: p.sms } : {}), ...(on.has("imessage") ? { imessage: p.imessage } : {}), ...(on.has("call") ? { phone: p.phone } : {}), ...(on.has("a2a") ? { a2a: p.a2a } : {}),
    log: (event, data) => logs.push({ event, data }),
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, leaseTtlMs: 60_000, ...(o.instanceId ? { instanceId: o.instanceId } : {}), ...config,
    },
  });
  /** Run `fn` as if inside an advance of `jobId` holding its lease (owner `owner`), the way advanceLeased sets it up. */
  const inAdvance = async <T>(jobId: string, fn: () => Promise<T>, owner = `${o.instanceId ?? "kit"}#lease`): Promise<T> => {
    if (!(await repo.acquireJobLease(jobId, owner, clock.now().toISOString(), 60_000))) throw new Error("lease held elsewhere");
    const ctx = (globalThis as { __haggleAdvanceCtx?: { run<R>(s: ReadonlySet<string>, f: () => R): R } }).__haggleAdvanceCtx!;
    const leases = (engine as unknown as { leases: Map<string, { owner: string; lost: boolean }> }).leases;
    leases.set(jobId, { owner, lost: false });
    try {
      return await ctx.run(new Set([jobId]), fn);
    } finally {
      leases.delete(jobId);
      await repo.releaseJobLease(jobId, owner);
    }
  };
  /** A private engine method (the side effects under test). */
  const priv = <F extends (...a: never[]) => unknown>(name: string) => ((engine as unknown as Record<string, F>)[name]!).bind(engine) as F;
  return { engine, repo, clock, p, logs, inAdvance, priv };
}

let mailN = 0;
/** An inbound email from a business, in the RFQ's thread. */
export function mail(k: Pick<Kit, "engine">, b: { rfq_message_id: string | null; email: string | null }, bodyText: string, id?: string) {
  const n = ++mailN;
  const rfq = b.rfq_message_id!;
  return k.engine.ingest({ providerEventId: `ev_k${n}`, eventType: "message.received", providerEmailId: id ?? `in_k${n}_${Math.random().toString(36).slice(2, 8)}`, threadId: `th_k${n}`, messageId: `<in_k${n}@vendor.example>`, inReplyTo: [rfq], references: [rfq], from: b.email!, to: ["haggle@inkboxmail.test"], subject: "Re: Quote request", bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
}

/** FakeInkbox whose messages carry createdAt and whose listing honours startDatetime / endDatetime (newest first). */
export class TimedInkbox extends FakeInkbox {
  readonly listed: { start?: string; end?: string }[] = [];
  private readonly clock: { now: () => Date };
  constructor(clock: { now: () => Date }) {
    super();
    this.clock = clock;
  }
  stamp<T extends object>(m: T): T {
    (m as { createdAt?: string }).createdAt = this.clock.now().toISOString();
    return m;
  }
  override reply(...a: Parameters<FakeInkbox["reply"]>) {
    return this.stamp(super.reply(...a));
  }
  /** Mail to the buyer from no business (newsletters, noise): listed, never ingested. */
  noise(n: number, spreadMs: number) {
    const t0 = this.clock.now().getTime();
    for (let i = 0; i < n; i++) {
      const id = `noise_${t0}_${i}`;
      this.messages.set(id, { id, mailbox: BUYER, direction: "inbound", threadId: null, messageId: `<${id}@news.test>`, fromAddress: "news@news.test", toAddresses: ["list@news.test"], subject: "news", bodyText: "x", inReplyTo: null, references: null, attachmentMetadata: null, createdAt: new Date(t0 - Math.floor((i * spreadMs) / n)).toISOString() } as never);
    }
  }
  override async *list(mailbox: string, o?: { direction?: string; startDatetime?: string; endDatetime?: string }) {
    if (this.listError) throw this.listError;
    this.listed.push({ ...(o?.startDatetime ? { start: o.startDatetime } : {}), ...(o?.endDatetime ? { end: o.endDatetime } : {}) });
    const at = (m: { createdAt?: string }) => Date.parse(m.createdAt ?? "1970-01-01T00:00:00Z");
    const items = [...this.messages.values()].filter((m) => m.mailbox === mailbox && (!o?.direction || m.direction === o.direction)
      && (!o?.startDatetime || at(m as never) >= Date.parse(o.startDatetime)) && (!o?.endDatetime || at(m as never) < Date.parse(o.endDatetime)));
    for (const m of items.sort((a, b) => at(b as never) - at(a as never))) yield m;
  }
}

