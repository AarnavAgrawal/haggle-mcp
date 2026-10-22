// Shared kit for the sprint 5 A purchase tests (purchase*.test.ts): the real engine in live mode on the
// manual pilot rail, over the in-memory store (or any Repository, e.g. Postgres), with fake email /
// SMS / iMessage / phone ports that record what would be sent and a deterministic extractor standing
// in for Claude. Vendor replies and the approver's texts are injected where Inkbox webhooks would
// deliver them. Nothing here is real: no vendor, approver, provider, payment or network.
import { disabledPayer, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig, type ExtractorPort } from "../../src/index.ts";
import { vendorOwnWords } from "../../src/approvals/bookingReply.ts";
import type { Repository } from "../../src/store/types.ts";

export const T0 = Date.parse("2026-10-22T16:00:00Z");

/** Reads "$X total", "$Y deposit", "N vegetarian", "delivered by HH:MM", "valid until YYYY-MM-DD" and questions from the vendor's own words. */
export const purchaseExtractor: ExtractorPort = {
  async extract(i) {
    const t = vendorOwnWords(i.bodyText.split("[The business's reply]: ").at(-1)!);
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:all[- ]in\s*)?total/i) ?? money(/total[^$\d]{0,20}\$\s?([\d,]+(?:\.\d{2})?)/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    const veg = t.match(/(\d+)\s*(?:vegetarian|veg\b)/i);
    const by = /deliver\w*[^.\n]{0,40}\bby (\d{1,2}:\d{2})/i.exec(t);
    const questions = t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().endsWith("?")).map((text) => ({ text: text.trim(), needs_answer_to_quote: true }));
    const checks = (i.request.requirementList ?? []).map((r) => {
      if (r.kind === "dietary") return veg ? { requirement_id: r.id, met: Number(veg[1]) >= (r.min_count ?? 0), evidence: veg[0], note: `offered ${veg[1]}` } : { requirement_id: r.id, met: null, evidence: "", note: "not stated" };
      if (r.kind === "delivery") return by ? { requirement_id: r.id, met: by[1]!.padStart(5, "0") <= "11:30", evidence: by[0], note: `by ${by[1]}` } : { requirement_id: r.id, met: null, evidence: "", note: "not stated" };
      return { requirement_id: r.id, met: null, evidence: "", note: "not addressed" };
    });
    return {
      available: !/\b(can't|cannot|unable to)\b/i.test(t), price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: /deliver/i.test(t) ? true : null,
      tax_usd: null, tax_status: /tax incl|including tax|tax included/i.test(t) ? "included" : "not_mentioned", tax_rate_percent: null, tax_evidence: "", total_usd: total, deposit_usd: deposit, menu_items: [],
      dietary_coverage: veg ? [{ need: "vegetarian", covered: true, count_offered: Number(veg[1]) }] : [], valid_until: /valid until (\d{4}-\d{2}-\d{2})/i.exec(t)?.[1] ?? null, questions, payment_request: "none", instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])], missing_fields: total === null ? ["total"] : [], confidence: 0.9, requirement_checks: checks,
    } as never;
  },
};

/** The catering request every scenario uses: three weeks out, two must-haves. */
export const REQUEST = { what: "team lunch catering", quantity: 40, unit: "people", date: "2026-11-14", time: "11:30", area: "San Francisco, CA", venue: "500 Howard St", requirements: [
  { id: "veg", kind: "dietary" as const, text: "At least 12 vegetarian meals", hard: true, min_count: 12 },
  { id: "dlv", kind: "delivery" as const, text: "Deliver to 500 Howard St by 11:30", hard: true },
] };

const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };

export interface PurchaseEnvOptions {
  config?: Partial<EngineConfig>;
  /** A store (Postgres: rows stamped by the database), or a factory given the kit's clock so an in-memory store stamps rows on the same clock as the engine. */
  repo?: Repository | ((now: () => Date) => Repository);
  start?: number;
  phone?: boolean;
  imessage?: boolean;
  approver?: string;
  /** Distinct ids per Postgres run (the shared-line safety check sees every run's numbers). */
  instanceId?: string;
}

export type Sent = { to: string; subject: string; bodyText: string; idempotencyKey: string };

export function purchaseEnv(o: PurchaseEnvOptions = {}) {
  let t = o.start ?? T0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: Sent[] = [];
  const texts: { to: string; text: string; idempotencyKey: string; via: "sms" | "imessage" }[] = [];
  const calls: { toNumber: string; reason: string }[] = [];
  const repo = typeof o.repo === "function" ? o.repo(clock.now) : (o.repo ?? new InMemoryRepository({ now: clock.now }));
  const approver = o.approver ?? "+14155550101";
  const ports = {
    email: { async send(m: Sent) { emails.push(m); return { providerId: `em_${emails.length}_${m.idempotencyKey}`, status: "sent" as const, idempotentReplay: false, messageId: `<out_${emails.length}_${Math.random().toString(36).slice(2, 8)}@ses.haggle.test>` }; } },
    sms: { async send(r: { to: string; text: string; idempotencyKey: string }) { texts.push({ ...r, via: "sms" }); return { messageId: `sms_${texts.length}_${Math.random().toString(36).slice(2, 8)}` }; } },
  };
  const make = (instanceId?: string) => new HaggleEngine({
    repo, now: clock.now, extractor: purchaseExtractor, brain: new StubBrain(), payer: disabledPayer("payments are manual on this server"), attachments: { load: async () => [] },
    email: ports.email as never, sms: ports.sms as never,
    ...(o.imessage ? { imessage: { async send(r: { to: string; text: string; idempotencyKey: string }) { texts.push({ ...r, via: "imessage" }); return { messageId: `im_${texts.length}` }; } } as never } : {}),
    ...(o.phone ? { phone: { async placeCall(r: { toNumber: string; reason: string }) { calls.push(r); return { callId: `call_${calls.length}_${Math.random().toString(36).slice(2, 8)}` }; } } as never } : {}),
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: approver, manualPaymentHandoff: true, callCooldownMs: 0, ...(instanceId ? { instanceId } : {}), ...o.config,
    },
  });
  const engine = make(o.instanceId);
  let n = 0;
  const uniq = Math.random().toString(36).slice(2, 8);
  const env = {
    engine, repo, clock, emails, texts, calls, approver,
    /** A second engine on the same store and clock: a server restart, or a second replica. */
    restart: (instanceId = `restart-${++n}`) => make(instanceId),
    toApprover: () => texts.filter((x) => x.to === approver),
    lastToApprover: () => texts.filter((x) => x.to === approver).at(-1)?.text ?? "",
    /** The approval code from the latest text that carried one (never from model-visible output). */
    code: () => { const m = [...texts].reverse().map((x) => (x.to === approver ? /\b(?:YES|PAID|BOOKED) (\d{4})/.exec(x.text) : null)).find(Boolean); return m ? m[1]! : ""; },
    to: (addr: string) => emails.filter((e) => e.to === addr),
    /**
     * A vendor's email reply in Haggle's thread. trust "verified": the sender is authenticated (binds
     * terms on its own); "thread": outside mail proven only by Haggle's reply token (continuity only).
     */
    mail: async (jobId: string, from: string, bodyText: string, trust: "verified" | "thread" = "verified", eng = engine) => {
      const ours = (await repo.listMessages(jobId)).filter((m) => m.direction === "out" && m.to_address === from).at(-1)!;
      const id = `${uniq}_${++n}`;
      return eng.ingest({
        providerEventId: `ev_${id}`, eventType: "message.received", providerEmailId: `in_${id}`, threadId: `th_${from}`, messageId: `<r${id}@mail.example>`,
        inReplyTo: [ours.rfc_message_id!], references: [ours.rfc_message_id!], from, to: ["haggle@inkboxmail.test"], subject: `Re: ${ours.subject}`, bodyText, attachments: [], attachmentsDownloadUrl: null,
      }, (address) => (trust === "verified"
        ? { trusted: true, address, reason: "inkbox-same-org", evidence: noEvidence }
        : { trusted: false, retryable: false, reason: "unverified-external-sender", evidence: noEvidence }) as never);
    },
    /** The approver texting Haggle from their own phone. */
    human: (text: string, eng = engine) => eng.ingestText({ messageId: `ht_${uniq}_${++n}`, from: approver, text, inbound: true }),
    vendorText: (from: string, text: string, eng = engine) => eng.ingestText({ messageId: `vt_${uniq}_${++n}`, from, text, inbound: true }),
    events: async (jobId: string, type?: string) => (await repo.listEvents(jobId)).filter((e) => !type || e.type === type),
  };
  return env;
}
export type PurchaseEnv = ReturnType<typeof purchaseEnv>;

/** Start a deal with these vendors and let each reply (email bodies by address); quotes close after the window. */
export async function quotedDeal(env: PurchaseEnv, vendors: { name: string; email?: string; phone?: string; channel?: "email" | "phone" | "imessage"; reply?: string; trust?: "verified" | "thread" }[], o: { budget?: number; request?: Partial<typeof REQUEST> & Record<string, unknown> } = {}) {
  const deal = await env.engine.deal({ request: { ...REQUEST, ...o.request } as never, budget_usd: o.budget ?? 2500, businesses: vendors.map((v) => ({ name: v.name, ...(v.email ? { email: v.email } : {}), ...(v.phone ? { phone: v.phone } : {}), ...(v.channel ? { channel: v.channel } : {}) })) });
  env.clock.advance(5 * 60_000);
  for (const v of vendors) {
    if (!v.reply) continue;
    if (v.channel === "phone") {
      await env.engine.advanceJob(deal.job_id);
      const callId = (await env.repo.listMessages(deal.job_id)).filter((m) => m.direction === "out" && m.channel === "phone" && m.to_address === v.phone).at(-1)!.provider_email_id!;
      await env.engine.ingestCall({ callId, outcome: "completed", transcript: `local: Hi, I'm an AI assistant calling on behalf of a customer.\nremote: ${v.reply}` });
    } else if (v.channel === "imessage") await env.vendorText(v.phone!, v.reply);
    else await env.mail(deal.job_id, v.email!, v.reply, v.trust ?? "verified");
  }
  env.clock.advance(31 * 60_000);
  await env.engine.advanceJob(deal.job_id);
  const board = await env.engine.getQuotes(deal.job_id);
  const quote = (name: string) => board.quotes.find((q) => q.business === name && q.status === "current")!;
  return { jobId: deal.job_id, board, quote };
}

/** Ask the human to approve this quote (text) and have them reply YES <code>; returns the approval row. */
export async function humanApproves(env: PurchaseEnv, jobId: string, quoteId: string, action: "pay" | "confirm" = "pay") {
  const a = await env.engine.requestApproval(jobId, quoteId, "imessage", action, { text: true });
  const r = await env.human(`YES ${a.code}`);
  return { a, outcome: r.outcome };
}
