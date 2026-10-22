// The eval environment (WS-F): the REAL engine (live-mode config, shared Inkbox-style mailbox, coded
// out-of-band approvals) over an in-memory store, a fake clock and recording fake ports. No network:
// every outbound email, text, call and charge is captured, and fetch is trapped for the run so a
// followed vendor link would be recorded as an unsafe action.
import { HaggleEngine } from "../src/workflow/engine.ts";
import type { EngineConfig, ExtractorPort } from "../src/workflow/ports.ts";
import { InMemoryRepository } from "../src/store/memory.ts";
import { StubBrain } from "../src/brain/stubBrain.ts";
import { disabledPayer } from "../src/live/adapters.ts";
import { inlineAttachments } from "../src/workflow/ports.ts";
import { simulatedStripe } from "../src/payments/stripe.ts";
import type { InboundMessage, TrustVerdict } from "../src/inbound/primitive.ts";
import { EVAL_START } from "./corpus.ts";

export const BUYER_INBOX = "haggle@inkboxmail.test";
export const APPROVER_PHONE = "+14155550101";
const NO_EVIDENCE = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
/** An Inkbox-authenticated sender (the seller fleet case): the From is proven. */
export const trusted = (expected: string): TrustVerdict => ({ trusted: true, address: expected, reason: "trusted", evidence: NO_EVIDENCE });
/** Mail from outside Inkbox (Gmail, Outlook): Inkbox can't authenticate it. */
export const external = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: NO_EVIDENCE });

export interface SentEmail { to: string; subject: string; bodyText: string; idempotencyKey: string; messageId: string; at: number }

export interface EvalEnv {
  engine: HaggleEngine;
  repo: InMemoryRepository;
  clock: { now: () => Date; advance: (ms: number) => void; elapsed: () => number };
  emails: SentEmail[];
  texts: { to: string; text: string; at: number }[];
  calls: { toNumber: string; reason: string }[];
  stripe: ReturnType<typeof simulatedStripe>;
  /** Every fetch attempted while the env was active (should stay empty). */
  fetches: string[];
  ingest(msg: Partial<InboundMessage> & { from: string; bodyText: string }, trust?: (e: string) => TrustVerdict, files?: { filename: string; contentType: string; data: Uint8Array }[]): Promise<{ jobId: string | null; outcome: string }>;
  restore(): void;
}

let seq = 0;

export async function makeEnv(opts: { extractor: ExtractorPort; config?: Partial<EngineConfig>; workspaces?: { id: string; approver: string }[] }): Promise<EvalEnv> {
  let t = EVAL_START;
  const start = t;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; }, elapsed: () => t - start };
  const repo = new InMemoryRepository({ now: clock.now });
  const emails: SentEmail[] = [];
  const texts: EvalEnv["texts"] = [];
  const calls: EvalEnv["calls"] = [];
  const stripe = simulatedStripe();
  const fetches: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => { fetches.push(String((input as { url?: string })?.url ?? input)); throw new Error("eval: network is disabled"); }) as typeof fetch;
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: opts.extractor, attachments: inlineAttachments, brain: new StubBrain(), payer: disabledPayer("eval"), stripe,
    email: {
      async send(m) {
        const messageId = `<out_${++seq}@email.amazonses.test>`;
        emails.push({ to: m.to, subject: m.subject, bodyText: m.bodyText, idempotencyKey: m.idempotencyKey, messageId, at: t });
        return { providerId: `em_${seq}`, status: "sent", idempotentReplay: false, messageId };
      },
    },
    sms: { async send(r) { texts.push({ to: r.to, text: r.text, at: t }); return { messageId: `sms_${texts.length}` }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: BUYER_INBOX, collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 60 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 2, ...opts.config,
    },
  });
  for (const w of opts.workspaces ?? []) {
    await repo.insertWorkspace({ id: w.id, name: w.id, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
    await engine.updateSettings({ approver_phone: w.approver, spending_cap_cents: 150_000 }, w.id);
  }
  if (!opts.workspaces) await engine.updateSettings({ approver_phone: APPROVER_PHONE, spending_cap_cents: 150_000 });
  return {
    engine, repo, clock, emails, texts, calls, stripe, fetches,
    async ingest(m, trust = trusted, files = []) {
      const n = ++seq;
      return engine.ingest({
        providerEventId: `ev_${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: null, messageId: `<in_${n}@vendor.test>`,
        inReplyTo: [], references: [], to: [BUYER_INBOX], subject: "Re: Quote request", attachments: [], attachmentsDownloadUrl: null, ...m,
      }, trust, files.length ? { inlineAttachments: files } : {});
    },
    restore() { globalThis.fetch = realFetch; },
  };
}

/** The last email Haggle sent to `to`. */
export function lastTo(env: EvalEnv, to: string): SentEmail | undefined {
  return env.emails.filter((e) => e.to === to).at(-1);
}

/** A 4-digit approval code from the newest text to the approver (what the human reads on their phone). */
export function approvalCodeFromTexts(env: EvalEnv, approver = APPROVER_PHONE): string | null {
  for (const x of [...env.texts].reverse()) {
    if (x.to !== approver) continue;
    const m = x.text.match(/\b(?:YES|APPROVE)\s+(\d{4})\b/i) ?? x.text.match(/\b(\d{4})\b/);
    if (m) return m[1]!;
  }
  return null;
}
