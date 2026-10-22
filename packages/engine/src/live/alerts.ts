// Operator alerts: an optional Slack-compatible incoming webhook (HAGGLE_ALERT_WEBHOOK_URL) for things
// a human should look at (stalled jobs, AI budget reached, repeated background failures). Every alert
// is also a log line. Alerts are redacted, deduplicated per key and rate limited overall, and an
// alert never throws into (or waits on) the caller's work.
import { redactText, type Logger } from "./log.ts";

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
