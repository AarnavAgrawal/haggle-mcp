// AI usage controls for the live Claude calls (quote extraction, answering a business's question,
// the negotiation strategist). A meter counts calls and tokens (from each response's `usage`) per
// job, per workspace and per UTC day, and enforces two operator limits:
//   HAGGLE_AI_MAX_CALLS_PER_JOB    Claude calls one job may make (a looping reply can't burn the budget);
//   HAGGLE_AI_DAILY_TOKEN_BUDGET   input + output tokens per UTC day across the process.
// Over a limit the call is refused before it reaches Anthropic with AiBudgetExceeded, which every
// caller turns into its safe path: an extraction fails the read (the reply is kept and shown as
// "couldn't read a price" for the human; never a heuristic or approvable quote), a question waits for
// the human, and the strategist falls back to the truthful rules. Nothing is ever auto-accepted.
// Counters are per process (in memory): with several replicas each enforces its own share.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtractorPort } from "../workflow/ports.ts";
import type { Logger } from "./log.ts";

export class AiBudgetExceeded extends Error {
  override name = "AiBudgetExceeded";
  readonly limit: "calls_per_job" | "daily_tokens";
  constructor(limit: "calls_per_job" | "daily_tokens", message: string) {
    super(message);
    this.limit = limit;
  }
}

export interface AiScope { jobId?: string | undefined; workspaceId?: string | undefined; purpose?: string | undefined }
export interface AiLimits { maxCallsPerJob?: number | undefined; dailyTokenBudget?: number | undefined }
interface Tally { calls: number; tokensIn: number; tokensOut: number; refused: number }
const empty = (): Tally => ({ calls: 0, tokensIn: 0, tokensOut: 0, refused: 0 });

export interface AiUsageSnapshot {
  day: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  refused: number;
  limits: { max_calls_per_job: number | null; daily_token_budget: number | null };
  daily_tokens_remaining: number | null;
  /** True once today's budget is spent (new Claude calls are refused until the UTC day rolls over). */
  daily_budget_reached: boolean;
  jobs_at_call_limit: number;
}

/** Reads HAGGLE_AI_MAX_CALLS_PER_JOB / HAGGLE_AI_DAILY_TOKEN_BUDGET (unset or invalid: that limit is off; config.ts rejects invalid values). */
export function aiLimitsFromEnv(env: Record<string, string | undefined>): AiLimits {
  const int = (v: string | undefined) => (v?.trim() && /^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : undefined);
  return { maxCallsPerJob: int(env.HAGGLE_AI_MAX_CALLS_PER_JOB), dailyTokenBudget: int(env.HAGGLE_AI_DAILY_TOKEN_BUDGET) };
}

export interface AiMeterOptions {
  limits?: AiLimits;
  now?: () => Date;
  logger?: Logger;
  /** Called once when a limit first refuses a call (per job, or per day): wire the alerter here. */
  onLimit?: (info: { limit: AiBudgetExceeded["limit"]; scope: AiScope }) => void;
  /** Resolves a job's workspace for the per-workspace tally (cached). */
  workspaceOf?: (jobId: string) => Promise<string | null>;
  /**
   * Persists each call's reported usage (migration 122, `aiUsageSink(repo)`), so per-job usage and cost
   * survive a restart. Best effort: a failed write is logged and never fails the Claude call.
   */
  sink?: (r: AiUsageRecord) => Promise<void>;
}

/** One Claude call's usage as persisted (ai_usage_events). */
export interface AiUsageRecord {
  job_id: string | null; workspace_id: string | null; purpose: string; model: string;
  input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number;
}

/** The meter's sink over a repository with migration 122 (a repository without it records nothing). */
export function aiUsageSink(repo: { recordAiUsage?: (u: AiUsageRecord) => Promise<void> }): (r: AiUsageRecord) => Promise<void> {
  return async (r) => { await repo.recordAiUsage?.(r); };
}

export class AiUsageMeter {
  private readonly scopeStore = new AsyncLocalStorage<AiScope>();
  private day = "";
  private total = empty();
  private readonly byJob = new Map<string, Tally>();
  private readonly byWorkspace = new Map<string, Tally>();
  private readonly workspaceCache = new Map<string, string>();
  private readonly opts: AiMeterOptions;
  private readonly pending = new Set<Promise<void>>();

  constructor(opts: AiMeterOptions = {}) {
    this.opts = opts;
  }

  get limits(): AiLimits { return this.opts.limits ?? {}; }

  /** Runs `fn` with this attribution; nested scopes inherit unset fields from the outer one. */
  run<T>(scope: AiScope, fn: () => Promise<T>): Promise<T> {
    const outer = this.scopeStore.getStore();
    const merged: AiScope = { ...outer, ...Object.fromEntries(Object.entries(scope).filter(([, v]) => v !== undefined)) };
    return this.scopeStore.run(merged, fn);
  }

  current(): AiScope { return this.scopeStore.getStore() ?? {}; }

  private roll() {
    const d = (this.opts.now?.() ?? new Date()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.total = empty();
      this.byJob.clear();
      this.byWorkspace.clear();
    }
  }

  /** Throws AiBudgetExceeded when the next call in this scope would break a limit; otherwise counts the call. */
  admit(scope: AiScope = this.current()): void {
    this.roll();
    const { maxCallsPerJob, dailyTokenBudget } = this.limits;
    const job = scope.jobId ? this.byJob.get(scope.jobId) ?? empty() : null;
    let refusal: AiBudgetExceeded | null = null;
    if (dailyTokenBudget !== undefined && this.total.tokensIn + this.total.tokensOut >= dailyTokenBudget) {
      refusal = new AiBudgetExceeded("daily_tokens", "AI daily token budget reached; this message is held for human review");
    } else if (maxCallsPerJob !== undefined && job && job.calls >= maxCallsPerJob) {
      refusal = new AiBudgetExceeded("calls_per_job", "AI call limit for this job reached; this message is held for human review");
    }
    if (refusal) {
      const first = refusal.limit === "daily_tokens" ? this.total.refused === 0 : job!.refused === 0;
      this.total.refused++;
      if (job && scope.jobId) { job.refused++; this.byJob.set(scope.jobId, job); }
      this.opts.logger?.warn("ai_limit", { limit: refusal.limit, job_id: scope.jobId ?? null, workspace_id: scope.workspaceId ?? null, purpose: scope.purpose ?? null });
      if (first) this.opts.onLimit?.({ limit: refusal.limit, scope });
      throw refusal;
    }
    this.total.calls++;
    if (scope.jobId) {
      const j = job ?? empty();
      j.calls++;
      this.byJob.set(scope.jobId, j);
    }
    void this.tallyWorkspace(scope, (t) => { t.calls++; });
  }

  /** Records a response's token usage (missing usage counts as zero, never guessed); persisted through `sink` when the model is known. */
  record(scope: AiScope, usage: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null | undefined, model?: string): void {
    this.roll();
    const tin = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
    const tout = usage?.output_tokens ?? 0;
    this.total.tokensIn += tin;
    this.total.tokensOut += tout;
    if (scope.jobId) {
      const j = this.byJob.get(scope.jobId) ?? empty();
      j.tokensIn += tin;
      j.tokensOut += tout;
      this.byJob.set(scope.jobId, j);
    }
    void this.tallyWorkspace(scope, (t) => { t.tokensIn += tin; t.tokensOut += tout; });
    this.opts.logger?.info("ai_call", { purpose: scope.purpose ?? null, job_id: scope.jobId ?? null, workspace_id: scope.workspaceId ?? null, tokens_in: tin, tokens_out: tout, day_tokens: this.total.tokensIn + this.total.tokensOut });
    if (this.opts.sink && model) {
      const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
      const p = this.persist(scope, { model, input_tokens: n(usage?.input_tokens), output_tokens: n(usage?.output_tokens), cache_creation_input_tokens: n(usage?.cache_creation_input_tokens), cache_read_input_tokens: n(usage?.cache_read_input_tokens) });
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    }
  }

  private async persist(scope: AiScope, u: Omit<AiUsageRecord, "job_id" | "workspace_id" | "purpose">): Promise<void> {
    try {
      let ws = scope.workspaceId ?? (scope.jobId ? this.workspaceCache.get(scope.jobId) : undefined);
      if (!ws && scope.jobId && this.opts.workspaceOf) ws = (await this.opts.workspaceOf(scope.jobId).catch(() => null)) ?? undefined;
      await this.opts.sink!({ job_id: scope.jobId ?? null, workspace_id: ws ?? null, purpose: (scope.purpose ?? "unknown").slice(0, 40), ...u, model: u.model.slice(0, 80) });
    } catch (e) {
      this.opts.logger?.warn("ai_usage_persist_failed", { job_id: scope.jobId ?? null, error: (e as Error).message.slice(0, 200) });
    }
  }

  /** Waits for usage rows still being written (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async tallyWorkspace(scope: AiScope, f: (t: Tally) => void) {
    let ws = scope.workspaceId ?? (scope.jobId ? this.workspaceCache.get(scope.jobId) : undefined);
    if (!ws && scope.jobId && this.opts.workspaceOf) {
      ws = (await this.opts.workspaceOf(scope.jobId).catch(() => null)) ?? undefined;
      if (ws) {
        if (this.workspaceCache.size > 10_000) this.workspaceCache.clear();
        this.workspaceCache.set(scope.jobId, ws);
      }
    }
    if (!ws) return;
    const t = this.byWorkspace.get(ws) ?? empty();
    f(t);
    this.byWorkspace.set(ws, t);
  }

  /** Per job / workspace tallies for operators (logs, scripts); /ready shows only the totals. */
  usage(): { day: string; total: Tally; jobs: Record<string, Tally>; workspaces: Record<string, Tally> } {
    this.roll();
    return { day: this.day, total: { ...this.total }, jobs: Object.fromEntries(this.byJob), workspaces: Object.fromEntries(this.byWorkspace) };
  }

  snapshot(): AiUsageSnapshot {
    this.roll();
    const { maxCallsPerJob, dailyTokenBudget } = this.limits;
    const used = this.total.tokensIn + this.total.tokensOut;
    return {
      day: this.day, calls: this.total.calls, tokens_in: this.total.tokensIn, tokens_out: this.total.tokensOut, refused: this.total.refused,
      limits: { max_calls_per_job: maxCallsPerJob ?? null, daily_token_budget: dailyTokenBudget ?? null },
      daily_tokens_remaining: dailyTokenBudget === undefined ? null : Math.max(0, dailyTokenBudget - used),
      daily_budget_reached: dailyTokenBudget !== undefined && used >= dailyTokenBudget,
      jobs_at_call_limit: maxCallsPerJob === undefined ? 0 : [...this.byJob.values()].filter((t) => t.calls >= maxCallsPerJob).length,
    };
  }
}

/** The slice of the Anthropic client the extractor, answerer and strategist use. */
export interface ParseClient { messages: { parse: (...args: never[]) => Promise<unknown> } }

/**
 * Wraps an Anthropic client: every `messages.parse` is admitted by the meter first (refused calls
 * never reach Anthropic) and its `usage` recorded. The scope comes from the surrounding `meter.run`.
 */
export function meteredClient<C extends ParseClient>(client: C, meter: AiUsageMeter, purpose?: string): C {
  const parse = client.messages.parse.bind(client.messages) as (...args: unknown[]) => Promise<unknown>;
  const messages = new Proxy(client.messages, {
    get(target, prop, receiver) {
      if (prop !== "parse") return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]) => {
        const scope = { ...meter.current(), ...(purpose && !meter.current().purpose ? { purpose } : {}) };
        meter.admit(scope);
        const res = await parse(...args);
        const model = (res as { model?: unknown } | null)?.model ?? (args[0] as { model?: unknown } | undefined)?.model;
        meter.record(scope, (res as { usage?: Parameters<AiUsageMeter["record"]>[1] } | null)?.usage, typeof model === "string" ? model : undefined);
        return res;
      };
    },
  });
  return new Proxy(client, { get: (target, prop, receiver) => (prop === "messages" ? messages : Reflect.get(target, prop, receiver)) });
}

/**
 * Attributes extractor calls to the message's job (the metered client does the admitting). A
 * budget refusal must reach the engine as a failed read, never become a keyword quote:
 * withHeuristicFallback rethrows AiBudgetExceeded.
 */
export function meteredExtractor(port: ExtractorPort, meter: AiUsageMeter): ExtractorPort {
  return {
    extract: (input) => meter.run({ jobId: input.message.job_id ?? undefined, purpose: "extract" }, () => port.extract(input)),
    ...(port.answerQuestion ? { answerQuestion: (input: Parameters<NonNullable<ExtractorPort["answerQuestion"]>>[0]) => meter.run({ purpose: "answer_question" }, () => port.answerQuestion!(input)) } : {}),
  };
}
