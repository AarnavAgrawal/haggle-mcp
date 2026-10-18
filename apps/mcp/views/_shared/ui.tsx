/** Shared pieces for Haggle's views: theme shell, channel badges, flags and money formatting. */
import { ThemeProvider, useViewTheme } from "mcp-use/react";
import type { ReactNode } from "react";
import "./theme.css";

export type Channel = "email" | "phone" | "a2a" | "imessage";

const CHANNEL_LABEL: Record<Channel, string> = { email: "Email", phone: "Phone", a2a: "A2A", imessage: "iMessage" };

export function Shell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const theme = useViewTheme();
  return (
    <ThemeProvider>
      <div className={`hg${wide ? " hg-wide" : ""}`} data-theme={theme}>
        {children}
      </div>
    </ThemeProvider>
  );
}

/** LIVE (real businesses, real messages) or DEMO (simulated businesses). Every view shows one. */
export function ModeBadge({ mode }: { mode?: "mock" | "live" }) {
  if (!mode) return null;
  return mode === "live" ? (
    <span className="hg-mode hg-mode-live" title="Real businesses, real messages over Inkbox">
      <span className="hg-mode-dot" aria-hidden="true" />
      Live
    </span>
  ) : (
    <span className="hg-mode hg-mode-demo" title="Simulated businesses: nothing here is real">
      Demo · simulated
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: string }) {
  const c = (channel in CHANNEL_LABEL ? channel : "email") as Channel;
  return (
    <span className={`hg-channel hg-ch-${c}`}>
      <ChannelGlyph channel={c} />
      {CHANNEL_LABEL[c]}
    </span>
  );
}

function ChannelGlyph({ channel }: { channel: Channel }) {
  const common = { width: 11, height: 11, viewBox: "0 0 16 16", "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: 1.6 };
  switch (channel) {
    case "email":
      return (
        <svg {...common}>
          <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
          <path d="M2 4l6 5 6-5" />
        </svg>
      );
    case "phone":
      return (
        <svg {...common}>
          <path d="M4 1.8h2.2l1.1 3.3-1.6 1.1a8 8 0 0 0 4.1 4.1l1.1-1.6 3.3 1.1V12a2 2 0 0 1-2 2A10.2 10.2 0 0 1 2 4a2 2 0 0 1 2-2.2z" />
        </svg>
      );
    case "a2a":
      return (
        <svg {...common}>
          <circle cx="4" cy="8" r="2.4" />
          <circle cx="12" cy="8" r="2.4" />
          <path d="M6.4 8h3.2" />
        </svg>
      );
    case "imessage":
      return (
        <svg {...common}>
          <path d="M8 2.5c3.6 0 6.3 2.2 6.3 5s-2.7 5-6.3 5c-.8 0-1.5-.1-2.2-.3L2.5 13.5l1-2.6C2.4 10 1.7 8.8 1.7 7.5c0-2.8 2.7-5 6.3-5z" />
        </svg>
      );
  }
}

const FLAG_INFO: Record<string, { label: string; tone: "risk" | "warn" | "info" }> = {
  requirement_unmet: { label: "Misses a requirement", tone: "risk" },
  hidden_deposit: { label: "Deposit in fine print", tone: "warn" },
  hidden_fee: { label: "Hidden fee", tone: "warn" },
  external_payment_link: { label: "Pay-now link blocked", tone: "risk" },
  prompt_injection: { label: "Tried to instruct the agent", tone: "risk" },
  // A budget is a target by default: over it is a caveat to weigh (and negotiate), not a disqualifier.
  over_budget: { label: "Over budget", tone: "warn" },
  fees_unclear: { label: "Fees unclear", tone: "warn" },
  requirement_unknown: { label: "Not confirmed yet", tone: "warn" },
  low_confidence: { label: "Low confidence", tone: "warn" },
  question_pending: { label: "Waiting on our answer", tone: "info" },
  expired: { label: "Expired", tone: "warn" },
  approximate_total: { label: "Approximate total", tone: "warn" },
};

export function FlagChip({ flag }: { flag: string }) {
  const info = FLAG_INFO[flag] ?? { label: flag.replace(/_/g, " "), tone: "info" as const };
  return <span className={`hg-flag hg-tone-${info.tone}`}>{info.label}</span>;
}

export const isRiskFlag = (flag: string) => FLAG_INFO[flag]?.tone === "risk";

const VERDICT_LABEL = { good: "Good price", typical: "Typical price", high: "High price" } as const;

export function VerdictChip({ verdict }: { verdict?: "good" | "typical" | "high" }) {
  if (!verdict) return null;
  return <span className={`hg-verdict hg-verdict-${verdict}`}>{VERDICT_LABEL[verdict]}</span>;
}

export function usd(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** A thin meter: value as a share of max, with an optional marker (budget, cap). */
export function Meter({ value, max, marker, tone, label }: { value: number; max: number; marker?: number; tone?: string; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const markerPct = marker !== undefined && max > 0 ? Math.min(100, (marker / max) * 100) : undefined;
  return (
    <div className={`hg-meter${tone ? ` hg-meter-${tone}` : ""}`} role="img" aria-label={label}>
      <div className="hg-meter-fill" style={{ width: `${pct}%` }} />
      {markerPct !== undefined && <div className="hg-meter-marker" style={{ left: `${markerPct}%` }} />}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="hg-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} />
      ))}
    </div>
  );
}

export function ErrorNote({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="hg-error" role="alert">
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

/**
 * A tool error rendered as words, not a JSON blob. Haggle's errors are
 * `{"ok":false,"error":{"code","message","fix"}}` in the text content; anything else is shown as-is.
 */
export function ToolErrorNote({ title, error, content }: { title: string; error?: { message?: string }; content?: unknown }) {
  const texts = [error?.message, ...(Array.isArray(content) ? content.map((c) => (c as { text?: string }).text) : [])];
  const text = texts.find((t): t is string => typeof t === "string" && t.trim().length > 0) ?? "";
  let message = text;
  let fix: string | undefined;
  const brace = text.indexOf("{");
  if (brace >= 0) {
    try {
      const j = JSON.parse(text.slice(brace)) as { error?: { message?: string; fix?: string } | string; message?: string };
      const e = typeof j.error === "object" ? j.error : undefined;
      message = e?.message ?? (typeof j.error === "string" ? j.error : j.message) ?? text;
      fix = e?.fix;
    } catch {
      /* plain text */
    }
  }
  return (
    <div className="hg-error" role="alert">
      <strong>{title}</strong>
      {message && <span>{message}</span>}
      {fix && <span className="hg-error-fix">{fix}</span>}
    </div>
  );
}

/**
 * Words for a failed tool call: a thrown Error, or a result's content blocks. Haggle errors arrive as
 * `{"ok":false,"error":{"message","fix"}}` text; this returns "message fix" instead of the JSON.
 */
export function toolErrorText(e: unknown): string | undefined {
  const raw = Array.isArray(e)
    ? (e as { text?: string }[]).find((c) => typeof c?.text === "string")?.text
    : e instanceof Error ? e.message : typeof e === "string" ? e : undefined;
  if (!raw) return undefined;
  const brace = raw.indexOf("{");
  if (brace < 0) return raw;
  try {
    const j = JSON.parse(raw.slice(brace)) as { error?: { message?: string; fix?: string } | string; message?: string };
    const err = typeof j.error === "object" ? j.error : undefined;
    return [err?.message ?? (typeof j.error === "string" ? j.error : j.message), err?.fix].filter(Boolean).join(" ") || raw;
  } catch {
    return raw;
  }
}

/**
 * What Pay charges for a quote: the stated deposit, or the full total when no deposit was stated (a $0
 * deposit is never shown; decision 20). Only meaningful for a quote with a total (approvable quotes).
 */
export function payNow(q: { total_usd: number | null; deposit_usd?: number }): { amount: number; deposit: boolean } {
  return q.deposit_usd !== undefined && q.deposit_usd > 0 ? { amount: q.deposit_usd, deposit: true } : { amount: q.total_usd ?? 0, deposit: false };
}

/** "$50 deposit" or "$860 full total": the one wording used on every button and status line. */
export function payWords(p: { amount: number; deposit: boolean }): string {
  return `${usd(p.amount)} ${p.deposit ? "deposit" : "full total"}`;
}

/** The business gave a rough figure ("about $1,300"): shown as an estimate and never approvable. */
export const isApproximate = (q: { flags: string[] }) => q.flags.includes("approximate_total");

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  // Clock skew or sample data from later today: show the time rather than a wrong "just now".
  if (s < -60) return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The one-time approval code the server sends only to the view (`_meta["haggle/approval"]`), never to the model. */
export type ViewTicket = { approval_id: string; code: string };
export function viewTicket(meta: Record<string, unknown> | undefined): ViewTicket | undefined {
  const t = meta?.["haggle/approval"] as Partial<ViewTicket> | undefined;
  return t && typeof t.approval_id === "string" && typeof t.code === "string" ? { approval_id: t.approval_id, code: t.code } : undefined;
}

/** HAGGLE_MODE=mock: every view says the data is simulated. */
export function DemoTag({ mode }: { mode?: string }) {
  if (mode !== "mock") return null;
  return (
    <span className="hg-demo" title="Simulated data: nothing here was really sent or paid">
      DEMO
    </span>
  );
}

/** Copy text to the clipboard; resolves false when the host's sandbox blocks it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API refused (sandboxed iframe); fall back below.
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}
