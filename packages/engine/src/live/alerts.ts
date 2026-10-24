// Operator alerts: an optional Slack-compatible incoming webhook (HAGGLE_ALERT_WEBHOOK_URL) for things
// a human should look at (stalled jobs, AI budget reached, repeated background failures). Every alert
// is also a log line. Alerts are redacted, deduplicated per key and rate limited overall, and an
// alert never throws into (or waits on) the caller's work.
import { redactText, type EngineLog, type Logger } from "./log.ts";

export type AlertSeverity = "info" | "warn" | "critical";
export interface Alert {
  /** Dedupe key: the same key alerts at most once per `dedupeMs` (e.g. "stalled:job_x:contacting"). */
  key: string;
  severity: AlertSeverity;
  summary: string;
  details?: Record<string, string | number | boolean | null>;
}
export interface Alerter {
  /** Resolves true when the alert was posted (false: off, deduped, rate limited or failed). */
  alert(a: Alert): Promise<boolean>;
  readonly enabled: boolean;
  /** Counters for /ready (no URLs, no content). */
  stats(): { enabled: boolean; sent: number; suppressed: number; failed: number };
}

export interface AlerterOptions {
  url?: string | undefined;
  fetch?: typeof fetch;
  logger?: Logger;
  now?: () => number;
  /** Same key at most once per this window (default 30 min). */
  dedupeMs?: number;
  /** At most this many posts per `windowMs` across all keys (default 20 per 10 min). */
  maxPerWindow?: number;
  windowMs?: number;
  /** Prefix naming the server in every message (e.g. "haggle production"). */
  source?: string;
  timeoutMs?: number;
}

/** True for a URL the alerter may post to: https only (the webhook URL is itself a secret). */
export function validAlertUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function createAlerter(opts: AlerterOptions = {}): Alerter {
  const url = validAlertUrl(opts.url) ? opts.url! : null;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const dedupeMs = opts.dedupeMs ?? 30 * 60_000;
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const maxPerWindow = opts.maxPerWindow ?? 20;
  const lastByKey = new Map<string, number>();
  let sentTimes: number[] = [];
  const counts = { sent: 0, suppressed: 0, failed: 0 };
  return {
    enabled: url !== null,
    stats: () => ({ enabled: url !== null, ...counts }),
    async alert(a) {
      const summary = redactText(a.summary).slice(0, 300);
      const details = Object.fromEntries(Object.entries(a.details ?? {}).slice(0, 12).map(([k, v]) => [k, typeof v === "string" ? redactText(v).slice(0, 200) : v]));
      opts.logger?.[a.severity === "critical" ? "error" : "warn"]("alert", { key: a.key, severity: a.severity, summary, ...details });
      if (!url) return false;
      const t = now();
      const last = lastByKey.get(a.key);
      sentTimes = sentTimes.filter((s) => t - s < windowMs);
      if ((last !== undefined && t - last < dedupeMs) || sentTimes.length >= maxPerWindow) {
        counts.suppressed++;
        return false;
      }
      lastByKey.set(a.key, t);
      if (lastByKey.size > 5000) lastByKey.delete(lastByKey.keys().next().value!);
      sentTimes.push(t);
      const lines = Object.entries(details).map(([k, v]) => `• ${k}: ${v}`);
      const text = [`[${a.severity.toUpperCase()}]${opts.source ? ` ${redactText(opts.source).slice(0, 60)}` : ""}: ${summary}`, ...lines].join("\n");
      try {
        const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) });
        if (!res.ok) throw new Error(`alert webhook returned ${res.status}`);
        counts.sent++;
        return true;
      } catch (e) {
        counts.failed++;
        // Never log the URL (it is the credential); the error text is redacted too.
        opts.logger?.error("alert_failed", { key: a.key, error: redactText((e as Error).message.replace(/https?:\/\/\S+/g, "[url]")).slice(0, 200) });
        return false;
      }
    },
  };
}

type Fields = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const pick = (d: Fields, ...keys: string[]) => Object.fromEntries(keys.filter((k) => d[k] !== undefined).map((k) => [k, typeof d[k] === "number" || typeof d[k] === "boolean" ? d[k] as number | boolean : str(d[k]).slice(0, 200)]));

/**
 * Engine and reconciler log events a person must see, mapped to alerts. The dedupe key decides how
 * often the same thing pages: once per review, per job and reason, or per kind of failure.
 */
export const ALERT_EVENTS: Record<string, (d: Fields) => Alert> = {
  operator_review: (d) => ({ key: `review:${str(d.review_id)}`, severity: d.kind === "payment" || d.kind === "confirmation" ? "critical" : "warn", summary: `Operator review opened (${str(d.kind)}): ${str(d.reason)}`, details: pick(d, "review_id", "kind", "job_id") }),
  operator_attention: (d) => ({ key: `attention:${str(d.job_id)}:${str(d.reason)}`, severity: "warn", summary: `Job ${str(d.job_id)} needs a person: ${str(d.reason).replace(/_/g, " ")}`, details: pick(d, "job_id", "reason") }),
  lease_lost: (d) => ({ key: `lease_lost:${str(d.job_id)}`, severity: "warn", summary: `An advance lost job ${str(d.job_id)}'s lease mid-run (a slow advance or a database stall); it was fenced, nothing sent twice`, details: pick(d, "job_id") }),
  send_record_failed: (d) => ({ key: "send_record_failed", severity: "warn", summary: "A message was sent but couldn't be recorded (database unavailable); it is re-recorded under the same provider key", details: pick(d, "job_id") }),
  recovery_failed: (d) => ({ key: "recovery_failed", severity: "warn", summary: "The stuck-job sweep failed for a job", details: pick(d, "job_id", "error") }),
  reconcile_gave_up: (d) => ({ key: `reconcile_gave_up:${str(d.key)}`, severity: "warn", summary: "An inbound item couldn't be ingested after repeated tries; it is in operator review", details: pick(d, "key", "kind") }),
  reconcile_gap: (d) => ({ key: `reconcile_gap:${str(d.channel)}`, severity: "critical", summary: `The ${str(d.channel)} reconciler was down longer than it catches up; older items must be checked by hand`, details: pick(d, "channel", "mark", "swept_from") }),
  reconcile_window_truncated: (d) => ({ key: `reconcile_truncated:${str(d.channel)}`, severity: "warn", summary: `The ${str(d.channel)} catch-up can't page past a burst of items; check the reconciler`, details: pick(d, "channel", "at") }),
  reconcile_catch_up_failed: (d) => ({ key: `reconcile_catch_up:${str(d.channel)}`, severity: "warn", summary: `The ${str(d.channel)} catch-up after an outage keeps failing`, details: pick(d, "channel", "at") }),
  webhook_failed: (d) => ({ key: `webhook_failed:${str(d.status)}`, severity: "warn", summary: `Inkbox webhook deliveries are failing (HTTP ${str(d.status)}); the reconciler recovers them`, details: pick(d, "status", "path") }),
  operator_closed: (d) => ({ key: `closed:${str(d.job_id)}`, severity: "info", summary: `Job ${str(d.job_id)} was closed by an operator (fail-safe close)`, details: pick(d, "job_id") }),
};

/**
 * The engine's log port, also alerting on the events in ALERT_EVENTS (deduped and rate limited by
 * the alerter). Live wiring: `log: alertingLog(logger.engine, alerts)`. Never throws, never waits.
 */
export function alertingLog(log: EngineLog, alerter: Pick<Alerter, "alert">, events: Record<string, (d: Fields) => Alert> = ALERT_EVENTS): EngineLog {
  return (event, data) => {
    log(event, data);
    const make = events[event];
    if (!make) return;
    try {
      void alerter.alert(make(data ?? {})).catch(() => false);
    } catch {
      /* an alert never breaks the caller */
    }
  };
}
