// Inbound reconciliation: the guarantee that a business's reply is never lost.
//
// Inkbox webhooks are delivered once (its delivery log shows one attempt per event and subscription,
// even after a 503; replays are manual), so a reply whose webhook failed (live 2026-10-18, HG-2QAM:
// Sunset Kitchen's $2,660 counter answer hit a full database pool and was never stored) is
// recovered here instead: the buyer identity's own mailbox, texts and calls are listed and anything
// not stored yet is ingested through the same code paths and trust checks as the webhook.
// Idempotent by provider id (the messages table's unique provider_email_id), so a sweep can never
// double-ingest, and bounded (a lookback window, a page of items, a per-job rate limit).
import type { HaggleEngine } from "../workflow/engine.ts";
import type { JobRow, MessageRow, ReconcileChannel, Repository } from "../store/types.ts";
import { addressedToBuyer, inkboxSenderTrust, inkboxToInbound, trustForSender, type InkboxMailApi, type InkboxTrustPolicy } from "./inkbox.ts";
import { CATCH_UP, catchUpRange, walkCatchUp, type CatchUpParams, type RangeSweep } from "./reconcileWindow.ts";
import { classifyFailure } from "./transient.ts";

/** A text as identity.listTexts returns it (the fields used here). */
export type ListedText = { id: string; direction: string; remotePhoneNumber: string | null; senderPhoneNumber?: string | null; text: string | null; createdAt: Date | string };
/** A call as identity.listCalls returns it (the fields used here). */
export type ListedCall = { id: string; direction: string; status: string; hangupReason: string | null; remotePhoneNumber: string | null; endedAt: Date | string | null; createdAt: Date | string };

export interface ReconcileSources {
  /** The buyer mailbox. `identityAddresses`: this org's Inkbox identity addresses (what a webhook's agent_identities says). */
  mail?: { api: InkboxMailApi; buyerMailbox: string; senderTrust: InkboxTrustPolicy; identityAddresses: () => Promise<string[]> };
  texts?: { list(o: { startDatetime?: string; endDatetime?: string; limit?: number }): Promise<ListedText[]> };
  calls?: { list(o: { startDatetime?: string; endDatetime?: string; limit?: number }): Promise<ListedCall[]>; transcript(callId: string): Promise<string> };
}

export type Recovered = { channel: "email" | "text" | "call"; providerId: string; jobId: string | null; outcome: string };
export type SweepResult = { recovered: Recovered[]; errors: number; skipped?: string };

type Deps = {
  engine: Pick<HaggleEngine, "ingest" | "ingestText" | "ingestCall" | "ingestDeliveryStatus">;
  repo: Pick<Repository, "getJob" | "listOpenJobs" | "listRecentJobs" | "listMessages" | "findMessageByProviderId"> & Partial<Pick<Repository, "getReconcileCursor" | "advanceReconcileCursor">>;
  sources: ReconcileSources;
  log?: (event: string, data: Record<string, unknown>) => void;
  now?: () => Date;
  /** Pre-close sweeps of one job at most this often (default 15 s). */
  jobMinIntervalMs?: number;
  /** Closed jobs stay in the sweep this long after their last change (default 15 min). */
  recentClosedMs?: number;
  /** A placed call with no call.ended this long after it was placed is looked up (default 3 min). */
  callGraceMs?: number;
  /** Items listed per channel per sweep (default 100). */
  maxItems?: number;
  /** Never look further back than this (default 6 h). */
  maxLookbackMs?: number;
  /** Give up on an item (this process) after this many failed attempts (default 5). */
  maxAttempts?: number;
  /**
   * Catch-up after restarts and outages (reconcileWindow.ts): on when the repository keeps
   * high-water marks (migration 117); false turns it off. Marks are per `cursorScope` (default: the buyer mailbox).
   */
  catchUp?: Partial<CatchUpParams> | false;
  cursorScope?: string;
};

const TERMINAL = new Set(["paid", "confirmed", "cancelled", "failed"]);
const IDENTITY_TTL_MS = 10 * 60_000;
const norm = (n: string | null | undefined) => (n ?? "").replace(/[\s().-]/g, "");
const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : NaN);
/** A Voice AI call Haggle placed (not a text): an outbound phone row with a call id. */
const isPlacedCall = (m: MessageRow) => m.direction === "out" && m.channel === "phone" && !!m.provider_email_id && !/^(sms|imsg):/.test(m.provider_email_id);

/** listCalls status -> the call.ended outcome; null while the call is still going. */
export function callOutcome(c: Pick<ListedCall, "status" | "hangupReason">): "completed" | "no_answer" | "declined" | "failed" | null {
  if (c.status === "failed") return "failed";
  if (c.status === "canceled") return "no_answer";
  if (c.status !== "completed") return null;
  if (c.hangupReason === "rejected") return "declined";
  if (c.hangupReason === "voicemail") return "no_answer";
  return "completed";
}

export class InboundReconciler {
  private readonly handled = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly lastJobSweep = new Map<string, number>();
  private readonly inJob = new Set<string>();
  private running: Promise<SweepResult> | null = null;
  private identities: { at: number; set: Set<string> } | null = null;

  private readonly d: Deps;
  constructor(d: Deps) { this.d = d; }

  private now() {
    return (this.d.now ?? (() => new Date()))().getTime();
  }
  private log(event: string, data: Record<string, unknown>) {
    this.d.log?.(event, data);
  }

  /** The webhook processed this item: no need to look at it again. Keys: mail:<id>, status:<id>, text:<id>, call:<id>. */
  noteHandled(key: string) {
    this.handled.add(key);
    if (this.handled.size > 5000) this.handled.delete(this.handled.values().next().value!);
  }

  /** The periodic sweep (live tick): open jobs plus jobs closed in the last recentClosedMs. One at a time. */
  sweepAll(): Promise<SweepResult> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const now = this.now();
        const open = await this.d.repo.listOpenJobs();
        const recent = (await this.d.repo.listRecentJobs(50)).filter((j) => TERMINAL.has(j.state) && now - ms(j.updated_at) < (this.d.recentClosedMs ?? 15 * 60_000));
        return await this.sweep([...open, ...recent.filter((r) => !open.some((o) => o.id === r.id))], true);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * Before a negotiation round closes or "all quotes are in" goes out: pick up a just-missed reply.
   * Rate-limited per job; never throws. Returns how many items were recovered for this job.
   */
  async sweepJob(jobId: string): Promise<number> {
    const now = this.now();
    if (this.inJob.has(jobId) || now - (this.lastJobSweep.get(jobId) ?? -Infinity) < (this.d.jobMinIntervalMs ?? 15_000)) return 0;
    this.lastJobSweep.set(jobId, now);
    this.inJob.add(jobId);
    try {
      const job = await this.d.repo.getJob(jobId);
      if (!job) return 0;
      const r = await this.sweep([job]);
      return r.recovered.filter((x) => x.jobId === jobId).length;
    } catch (e) {
      this.log("reconcile_failed", { job_id: jobId, error: (e as Error).message?.slice(0, 200) });
      return 0;
    } finally {
      this.inJob.delete(jobId);
    }
  }

  private async sweep(jobs: JobRow[], full = false): Promise<SweepResult> {
    const out: SweepResult = { recovered: [], errors: 0 };
    // Only the periodic full sweep keeps the high-water marks (a per-job sweep sees one job's window).
    const cursor = full ? this.cursor() : null;
    const now = this.now();
    if (!jobs.length) {
      // Nothing open or just closed: nothing to recover for, so the marks move on (no idle days re-listed later).
      if (cursor) for (const ch of this.channels()) await this.mark(cursor, ch, new Date(now).toISOString());
      return { ...out, skipped: "no_jobs" };
    }
    const oldest = Math.min(...jobs.map((j) => ms(j.created_at)).filter(Number.isFinite));
    const since = new Date(Math.max(Number.isFinite(oldest) ? oldest - 60_000 : now, now - (this.d.maxLookbackMs ?? 6 * 3600_000))).toISOString();
    for (const ch of this.channels()) {
      // After a restart or an outage longer than the window: catch up from the mark first, oldest first.
      const caughtUp = cursor && !this.cursorOff ? await this.catchUp(cursor, ch, jobs, Date.parse(since), now, out) : true;
      const r = await this.sweepChannel(ch, jobs, since, undefined, out);
      if (cursor && !this.cursorOff && caughtUp && r.clean) await this.mark(cursor, ch, new Date(now).toISOString());
    }
    if (out.recovered.length || out.errors) this.log("reconcile_sweep", { jobs: jobs.length, since, recovered: out.recovered.length, errors: out.errors });
    return out;
  }

  private channels(): ReconcileChannel[] {
    const s = this.d.sources;
    return [...(s.mail ? (["email", "email_status"] as const) : []), ...(s.texts ? (["text"] as const) : []), ...(s.calls ? (["call"] as const) : [])];
  }

  /** One channel over [since, until): clean when nothing failed, nothing waits for a retry and the listing wasn't cut at its limit. */
  private async sweepChannel(ch: ReconcileChannel, jobs: JobRow[], since: string, until: string | undefined, out: SweepResult): Promise<RangeSweep> {
    const errors = out.errors;
    const retries = this.retries;
    const truncated = ch === "email" ? await this.sweepMail(since, out, until)
      : ch === "email_status" ? await this.sweepDeliveryStatus(since, out, until)
      : ch === "text" ? await this.sweepTexts(since, out, until)
      : await this.sweepCalls(jobs, since, out, until);
    return { truncated, clean: !truncated && out.errors === errors && this.retries === retries };
  }

  private cursorOff = false;
  private readonly gapLogged = new Set<string>();

  /** The high-water marks, when the repository keeps them (migration 117) and catch-up isn't off. */
  private cursor(): { get(ch: ReconcileChannel): Promise<string | null>; advance(ch: ReconcileChannel, at: string): Promise<void> } | null {
    const r = this.d.repo;
    if (this.cursorOff || this.d.catchUp === false || !r.getReconcileCursor || !r.advanceReconcileCursor) return null;
    const scope = this.d.cursorScope ?? this.d.sources.mail?.buyerMailbox.toLowerCase() ?? "default";
    return { get: (ch) => r.getReconcileCursor!(scope, ch), advance: (ch, at) => r.advanceReconcileCursor!(scope, ch, at) };
  }

  private async mark(c: NonNullable<ReturnType<InboundReconciler["cursor"]>>, ch: ReconcileChannel, at: string) {
    try {
      await c.advance(ch, at);
    } catch (e) {
      this.log("reconcile_cursor_failed", { channel: ch, kind: classifyFailure(e), error: (e as Error).message?.slice(0, 200) });
    }
  }

  /** Catch one channel up from its mark to `recentSince` in bounded slices. True when nothing is left before the normal window. */
  private async catchUp(c: NonNullable<ReturnType<InboundReconciler["cursor"]>>, ch: ReconcileChannel, jobs: JobRow[], recentSince: number, now: number, out: SweepResult): Promise<boolean> {
    let hw: string | null;
    try {
      hw = await c.get(ch);
    } catch (e) {
      // No reconcile_cursors table (117 not applied) or the database is down: the plain window, as before.
      this.cursorOff = classifyFailure(e) !== "transient";
      this.log("reconcile_cursor_unavailable", { channel: ch, disabled: this.cursorOff, error: (e as Error).message?.slice(0, 200) });
      return false;
    }
    const p = { ...CATCH_UP, ...(this.d.catchUp || {}) };
    const range = catchUpRange({ highWater: hw, recentSince, nowMs: now }, p);
    if (!range) return true;
    const iso = (t: number) => new Date(t).toISOString();
    if (range.clamped && !this.gapLogged.has(`${ch}:${hw}`)) {
      this.gapLogged.add(`${ch}:${hw}`);
      this.log("reconcile_gap", { channel: ch, mark: hw, swept_from: iso(range.from), note: "items older than the catch-up limit are never listed automatically; check the Inkbox mailbox and logs by hand" });
    }
    const w = await walkCatchUp(range, (f, t) => this.sweepChannel(ch, jobs, iso(f), iso(t), out), (t) => this.mark(c, ch, iso(t)), p);
    if (w.stuck) this.log(w.stuck === "truncated" ? "reconcile_window_truncated" : "reconcile_catch_up_failed", { channel: ch, at: iso(w.reached), listings: w.listings });
    else if (w.listings) this.log("reconcile_catch_up", { channel: ch, reached: iso(w.reached), complete: w.complete, listings: w.listings });
    return w.complete;
  }

  /** Items whose ingest asked to be tried again (e.g. sender verification unavailable): a range with any isn't clean. */
  private retries = 0;

  /** Try one item; a failure is counted (and the item skipped in this process after maxAttempts). */
  private async attempt(key: string, out: SweepResult, fn: () => Promise<Recovered | "skip" | "retry">) {
    if (this.handled.has(key)) return;
    const tries = this.failures.get(key) ?? 0;
    if (tries >= (this.d.maxAttempts ?? 5)) return;
    try {
      const r = await fn();
      if (r === "retry") {
        this.retries++;
        return; // e.g. sender verification temporarily unavailable: next sweep
      }
      this.failures.delete(key);
      this.noteHandled(key);
      if (r === "skip") return;
      out.recovered.push(r);
      this.log("reconciled_inbound", { channel: r.channel, provider_id: r.providerId, job_id: r.jobId, outcome: r.outcome });
    } catch (e) {
      out.errors++;
      this.failures.set(key, tries + 1);
      this.log(tries + 1 >= (this.d.maxAttempts ?? 5) ? "reconcile_gave_up" : "reconcile_item_failed", { key, kind: classifyFailure(e), error: (e as Error).message?.slice(0, 200) });
    }
  }

  private async identitySet(): Promise<Set<string>> {
    if (this.identities && this.now() - this.identities.at < IDENTITY_TTL_MS) return this.identities.set;
    const set = new Set((await this.d.sources.mail!.identityAddresses()).map((a) => a.trim().toLowerCase()).filter(Boolean));
    this.identities = { at: this.now(), set };
    return set;
  }

  /** Returns true when the listing was cut at maxItems (older items in the range weren't seen). */
  private async sweepMail(since: string, out: SweepResult, until?: string): Promise<boolean> {
    const { api, buyerMailbox, senderTrust } = this.d.sources.mail!;
    const buyer = buyerMailbox.toLowerCase();
    const candidates: string[] = [];
    let truncated = false;
    try {
      let n = 0;
      const opts = { direction: "inbound" as const, startDatetime: since, pageSize: 50, ...(until ? { endDatetime: until } : {}) };
      for await (const m of api.list(buyerMailbox, opts)) {
        if (++n > (this.d.maxItems ?? 100)) { truncated = true; break; }
        if (Number.isFinite(ms(m.createdAt)) && ms(m.createdAt) < Date.parse(since)) break; // newest first
        if (until && ms(m.createdAt) >= Date.parse(until)) continue;
        if (m.direction && m.direction !== "inbound") continue;
        if (!m.id || this.handled.has(`mail:${m.id}`)) continue;
        if (m.toAddresses && !addressedToBuyer({ toAddresses: m.toAddresses, ccAddresses: m.ccAddresses ?? null }, buyer)) continue;
        candidates.push(m.id);
      }
    } catch (e) {
      out.errors++;
      this.log("reconcile_list_failed", { channel: "email", kind: classifyFailure(e), error: (e as Error).message?.slice(0, 200) });
      return false;
    }
    if (!candidates.length) return truncated;
    const fresh: string[] = [];
    for (const id of candidates) {
      if (await this.d.repo.findMessageByProviderId(id)) this.noteHandled(`mail:${id}`);
      else fresh.push(id);
    }
    if (!fresh.length) return truncated;
    // Who is an Inkbox identity of this org (what the webhook's agent_identities carries). Without it
    // trust can't be decided: leave the mail unstored (never stored as untrusted) and retry later.
    let identities: Set<string>;
    try {
      identities = await this.identitySet();
    } catch (e) {
      out.errors++;
      this.log("reconcile_skipped", { channel: "email", reason: "identity directory unavailable", pending: fresh.length, error: (e as Error).message?.slice(0, 200) });
      return truncated;
    }
    for (const id of fresh.reverse()) {
      await this.attempt(`mail:${id}`, out, async () => {
        const detail = await api.get(buyerMailbox, id);
        if (!addressedToBuyer(detail, buyer)) return "skip";
        const from = (detail.fromAddress ?? "").trim().toLowerCase();
        // An agent-scoped buyer key lists only the buyer itself, so under "pinned-org-identity" the
        // operator's pinned roster addresses stand in for the org directory (same address check as the webhook path).
        const pinned = senderTrust.policy === "pinned-org-identity" && senderTrust.allowedSenders.some((a) => a.trim().toLowerCase() === from);
        const payload = { id: `reconcile:${id}`, event_type: "message.received", data: { agent_identities: from && (identities.has(from) || pinned) ? [{ bucket: "from", address: from }] : [] } };
        const msg = inkboxToInbound(payload, detail);
        const trust = await inkboxSenderTrust(api, payload as never, detail, senderTrust);
        if (!trust.trusted && trust.retryable) return "retry";
        const r = await this.d.engine.ingest(msg, trustForSender(trust, msg.from));
        return r.outcome === "duplicate" ? "skip" : { channel: "email", providerId: id, jobId: r.jobId, outcome: r.outcome };
      });
    }
    return truncated;
  }

  /**
   * Our outbound mail that bounced or failed (a lost message.bounced / message.failed webhook, or a
   * subscription without those event types). Only messages from the buyer mailbox; the engine
   * matches each to its own outbound row and is idempotent.
   */
  private async sweepDeliveryStatus(since: string, out: SweepResult, until?: string): Promise<boolean> {
    const { api, buyerMailbox } = this.d.sources.mail!;
    const buyer = buyerMailbox.toLowerCase();
    const hits: { id: string; messageId: string; status: "bounced" | "failed" }[] = [];
    let truncated = false;
    try {
      let n = 0;
      const opts = { direction: "outbound" as const, startDatetime: since, pageSize: 50, ...(until ? { endDatetime: until } : {}) };
      for await (const m of api.list(buyerMailbox, opts)) {
        if (++n > (this.d.maxItems ?? 100)) { truncated = true; break; }
        if (Number.isFinite(ms(m.createdAt)) && ms(m.createdAt) < Date.parse(since)) break; // newest first
        if (until && ms(m.createdAt) >= Date.parse(until)) continue;
        if (!m.id || (m.direction && m.direction !== "outbound") || (m.status !== "bounced" && m.status !== "failed")) continue;
        if (m.fromAddress && m.fromAddress.trim().toLowerCase() !== buyer) continue;
        if (this.handled.has(`status:${m.id}`)) continue;
        hits.push({ id: m.id, messageId: m.messageId, status: m.status });
      }
    } catch (e) {
      out.errors++;
      this.log("reconcile_list_failed", { channel: "email_status", kind: classifyFailure(e), error: (e as Error).message?.slice(0, 200) });
      return false;
    }
    for (const h of hits.reverse()) {
      await this.attempt(`status:${h.id}`, out, async () => {
        const r = await this.d.engine.ingestDeliveryStatus({ providerMessageId: h.id, rfcMessageId: h.messageId || null, status: h.status, source: "reconcile" });
        return r.outcome === "duplicate" || r.outcome === "unmatched" ? "skip" : { channel: "email", providerId: h.id, jobId: r.jobId, outcome: r.outcome };
      });
    }
    return truncated;
  }

  private async sweepTexts(since: string, out: SweepResult, until?: string): Promise<boolean> {
    let texts: ListedText[];
    const limit = this.d.maxItems ?? 100;
    try {
      texts = await this.d.sources.texts!.list({ startDatetime: since, ...(until ? { endDatetime: until } : {}), limit });
    } catch (e) {
      out.errors++;
      this.log("reconcile_list_failed", { channel: "text", kind: classifyFailure(e), error: (e as Error).message?.slice(0, 200) });
      return false;
    }
    const inbound = texts.filter((t) => t.direction === "inbound" && ms(t.createdAt) >= Date.parse(since) && (!until || ms(t.createdAt) < Date.parse(until))).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    for (const t of inbound) {
      await this.attempt(`text:${t.id}`, out, async () => {
        if (await this.d.repo.findMessageByProviderId(`sms-in:${t.id}`)) return "skip";
        const r = await this.d.engine.ingestText({ messageId: t.id, from: norm(t.remotePhoneNumber ?? t.senderPhoneNumber), text: t.text ?? "", inbound: true });
        return r.outcome === "duplicate" ? "skip" : { channel: "text", providerId: t.id, jobId: r.jobId, outcome: r.outcome };
      });
    }
    return texts.length >= limit;
  }

  private async sweepCalls(jobs: JobRow[], since: string, out: SweepResult, until?: string): Promise<boolean> {
    const now = this.now();
    // Calls Haggle placed on these jobs that have no call.ended yet, past the grace period.
    const pending = new Set<string>();
    for (const job of jobs) {
      const msgs = await this.d.repo.listMessages(job.id);
      const ended = new Set(msgs.filter((m) => m.direction === "in" && m.provider_email_id?.startsWith("call-ended:")).map((m) => m.provider_email_id!.slice("call-ended:".length)));
      for (const m of msgs) if (isPlacedCall(m) && !ended.has(m.provider_email_id!) && now - ms(m.created_at) >= (this.d.callGraceMs ?? 3 * 60_000)) pending.add(m.provider_email_id!);
    }
    let calls: ListedCall[];
    const limit = this.d.maxItems ?? 100;
    try {
      calls = await this.d.sources.calls!.list({ startDatetime: since, ...(until ? { endDatetime: until } : {}), limit });
    } catch (e) {
      out.errors++;
      this.log("reconcile_list_failed", { channel: "call", kind: classifyFailure(e), error: (e as Error).message?.slice(0, 200) });
      return false;
    }
    for (const c of calls) {
      if (until && ms(c.createdAt) >= Date.parse(until)) continue;
      const outcome = callOutcome(c);
      if (!outcome) continue; // still ringing or on the line
      const ours = c.direction === "outbound" && pending.has(c.id);
      // A business that called Haggle back: its call.ended may have been lost too.
      const callback = c.direction === "inbound" && outcome === "completed" && now - ms(c.endedAt ?? c.createdAt) >= 60_000;
      if (!ours && !callback) continue;
      await this.attempt(`call:${c.id}`, out, async () => {
        if (await this.d.repo.findMessageByProviderId(`call-ended:${c.id}`)) return "skip";
        const transcript = outcome === "completed" ? await this.d.sources.calls!.transcript(c.id) : "";
        const r = await this.d.engine.ingestCall({
          callId: c.id, outcome, transcript, direction: c.direction === "inbound" ? "inbound" : "outbound",
          ...(c.endedAt ? { endedAt: new Date(c.endedAt).toISOString() } : {}), ...(c.remotePhoneNumber ? { remoteNumber: norm(c.remotePhoneNumber) } : {}),
        });
        return r.outcome === "duplicate" ? "skip" : { channel: "call", providerId: c.id, jobId: r.jobId, outcome: r.outcome };
      });
    }
    return calls.length >= limit;
  }
}
