// One structured logger for the server: a JSON line per event, with personal data and secrets
// redacted before anything is written. Business messages, provider errors and request bodies can
// carry emails, phone numbers and keys; the operator's log stream (Manufact, a log drain) must not.
// Redaction is best effort on free text and exact on known secret-bearing field names.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
/** The engine's log port shape (`EngineDeps.log`). */
export type EngineLog = (event: string, data: Record<string, unknown>) => void;

export interface Logger {
  debug(event: string, data?: LogFields): void;
  info(event: string, data?: LogFields): void;
  warn(event: string, data?: LogFields): void;
  error(event: string, data?: LogFields): void;
  /** A logger whose every line also carries `fields` (redacted too). */
  child(fields: LogFields): Logger;
  /** Adapter for ports that take `(event, data)`: info level, or warn/error for *_failed / *_error events. */
  engine: EngineLog;
}

const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|authorization|cookie|signature|private[_-]?key|credential|connector[_-]?url|db[_-]?url|database[_-]?url|card[_-]?number|account[_-]?number|routing[_-]?number|iban|cvc|cvv)/i;
/** Field names whose values are contact details: always masked whatever they look like. */
const CONTACT_KEY = /^(email|phone|to|from|to_number|from_number|approver_(email|phone)|notify_phone|recipient|sender|contact)$/i;
/** Personal details by field name (a postal address, a person's name): always masked. */
const PERSONAL_KEY = /^(address|street|street_address|postal_address|home_address|full_name|first_name|last_name|customer_name|date_of_birth|dob|ssn)$/i;
/**
 * Field names that carry a message's content (an email body, a text, a call transcript, payment
 * instructions, an attachment): never written, only their length. Business messages and the
 * human's texts hold personal details and payment details that no pattern catches reliably.
 */
const BODY_KEY = /^(body|body_text|bodytext|body_html|bodyhtml|html|text|raw|raw_body|transcript|instructions|instructions_text|reply_text|message_body|content|content_base64|contentbase64|attachment|attachments)$/i;

/** Luhn check: a 13-19 digit run that passes is a payment card number. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

const PATTERNS: [RegExp, string | ((m: string, ...a: string[]) => string)][] = [
  // Payment details (a business's payment instructions, a human's text): card numbers (Luhn-valid
  // 13-19 digits, spaced or dashed), IBANs, and account / routing / sort-code numbers after their label.
  [/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? "[card]" : m)],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, "[iban]"],
  [/\b(account|acct|a\/c|routing|aba|sort[ -]?code|bsb|iban)(\s*(?:number|no\.?|num|#|code))?(\s*[:#=-]?\s*)(?=[A-Z0-9 -]{0,34}?(?:\d[ -]?){4})[A-Z0-9][A-Z0-9 -]{3,32}[A-Z0-9]\b/gi, "$1$2$3[redacted]"],
  // US social security numbers.
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  // Connection strings with credentials: keep the scheme and host, drop user and password.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[redacted]@"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]{8,}/g, "[stripe-key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[anthropic-key]"],
  [/\bwhsec_[A-Za-z0-9+/=_-]{8,}/g, "[webhook-secret]"],
  [/\bsb_(secret|publishable)_[A-Za-z0-9_-]{16,}/g, "[supabase-key]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[google-key]"],
  // A Slack incoming-webhook URL is itself the credential (HAGGLE_ALERT_WEBHOOK_URL).
  [/https:\/\/hooks\.slack\.com\/services\/\S+/g, "https://hooks.slack.com/services/[redacted]"],
  [/\b(hgw|hgc)_[A-Za-z0-9_-]{8,}/g, "[workspace-credential]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  // Connector URLs carry the workspace secret in the path.
  [/\/c\/[A-Za-z0-9_-]{12,}\/mcp/g, "/c/[redacted]/mcp"],
  // Long opaque tokens in key=value form (query strings, headers in messages).
  [/\b(key|token|secret|signature|sig|password)=([^\s&"']{6,})/gi, "$1=[redacted]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // Phone numbers: E.164 or formatted with at least 10 digits (dates, amounts and ids stay).
  [/\+\d{8,15}\b/g, "[phone]"],
  [/(?<![\w$.])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]"],
];

/** Redact emails, phone numbers, keys and tokens from free text. */
export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as never);
  return out;
}

/** Deep redaction of a value: strings scrubbed, secret-named fields masked, depth and size bounded. */
export function redact(value: unknown, depth = 0, key = ""): unknown {
  if (key && SECRET_KEY.test(key)) return value === undefined || value === null || value === "" ? value : "[redacted]";
  if (key && PERSONAL_KEY.test(key) && value !== undefined && value !== null && value !== "") return "[redacted]";
  if (key && BODY_KEY.test(key) && value !== undefined && value !== null && value !== "") {
    const n = typeof value === "string" ? value.length : Array.isArray(value) ? value.length : null;
    return n === null ? "[omitted]" : `[omitted: ${n} ${typeof value === "string" ? "chars" : "items"}]`;
  }
  if (key && CONTACT_KEY.test(key) && typeof value === "string" && value) return /@/.test(value) ? "[email]" : /\d{6}/.test(value) ? "[phone]" : redactText(value);
  if (typeof value === "string") return redactText(value.length > 2000 ? `${value.slice(0, 2000)}…` : value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "[depth]";
  if (value instanceof Error) return { name: value.name, message: redactText(value.message.slice(0, 500)) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 80)) out[k] = redact(v, depth + 1, k);
  return out;
}

export interface LoggerOptions {
  /** Where lines go (default: stdout for debug/info, stderr for warn/error). */
  sink?: (level: LogLevel, line: string) => void;
  now?: () => Date;
  fields?: LogFields;
  /** Lowest level written (default "info"; HAGGLE_LOG_LEVEL in the server). */
  level?: LogLevel;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const defaultSink = (level: LogLevel, line: string) => (level === "warn" || level === "error" ? console.error(line) : console.log(line));

export function createLogger(opts: LoggerOptions = {}): Logger {
  const sink = opts.sink ?? defaultSink;
  const now = opts.now ?? (() => new Date());
  const min = RANK[opts.level ?? "info"] ?? RANK.info;
  const base = opts.fields ? (redact(opts.fields) as LogFields) : {};
  const write = (level: LogLevel, event: string, data?: LogFields) => {
    if (RANK[level] < min) return;
    let line: string;
    try {
      line = JSON.stringify({ ts: now().toISOString(), level, event: redactText(String(event)).slice(0, 100), ...base, ...(data ? (redact(data) as LogFields) : {}) });
    } catch {
      line = JSON.stringify({ ts: now().toISOString(), level, event: "log_unserializable", original_event: redactText(String(event)).slice(0, 100) });
    }
    try { sink(level, line); } catch { /* logging never throws into the caller */ }
  };
  const logger: Logger = {
    debug: (e, d) => write("debug", e, d),
    info: (e, d) => write("info", e, d),
    warn: (e, d) => write("warn", e, d),
    error: (e, d) => write("error", e, d),
    child: (fields) => createLogger({ ...opts, fields: { ...(opts.fields ?? {}), ...fields } }),
    engine: (event, data) => {
      const level: LogLevel = /(_failed|_error|failure)$/.test(event) ? "error" : /(_retry|_fallback|_rejected|_ignored|_unavailable|_limit|_stalled)/.test(event) || data?.level === "warn" ? "warn" : "info";
      write(level, event, data);
    },
  };
  return logger;
}

/** The process-wide logger (level from HAGGLE_LOG_LEVEL). Others import this rather than console.*. */
export const log: Logger = createLogger({ level: (["debug", "info", "warn", "error"] as const).find((l) => l === process.env.HAGGLE_LOG_LEVEL) ?? "info" });
