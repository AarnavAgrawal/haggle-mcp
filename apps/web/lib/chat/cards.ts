// What a deal tool call looks like in the chat (pure, presentation only; used by agent.ts for the live
// stream and by history.ts for a stored thread). A card is built only from real fields: the tool's
// input (what the model asked Haggle for) and a whitelisted part of the tool's data (who would be or
// was contacted, what Haggle still needs). Never `meta`, never contact details, never free-form
// business text. Every value is a plain string or number: the browser renders them as text.

export interface Contact {
  name: string;
  /** email | phone | imessage | a2a, when known. */
  channel: string | null;
}

/** What Haggle understood (the request as the model passed it to deal). */
export interface Brief {
  what: string;
  quantity?: string;
  when?: string;
  where?: string;
  budget_usd?: number;
  /** The budget in the user's words, when no number was given. */
  budget_text?: string;
  hard_limit?: boolean;
  /** Facts without their own field ({label, value}). */
  details: { label: string; value: string }[];
  must_haves: string[];
}

/**
 * A business Haggle found in a public listing for this request: contacted only once the user starts the
 * deal (which saves it to their businesses). Never its contact details.
 */
export interface FoundBusiness {
  name: string;
  /** Its listing ref ("aws:…" / "place:…"): what deal's confirm_discovered takes. */
  ref: string;
  /** "Google Places", "Amazon Location Service". */
  listing: string;
  /** Where its email was published: the listing itself or its own website. */
  email_from: "listing" | "website";
  hours_today?: string;
}

/**
 * The deal's spending limit (docs/state-and-next-fixes.md §5): from the budget, a limit the user stated,
 * a human's change or the operator; "default" = none set yet, decided at approval (default_usd).
 */
export interface SpendLimit {
  usd: number | null;
  source: "budget" | "stated" | "human" | "operator" | "default";
  default_usd?: number;
}

export type ToolCard =
  | { kind: "preview"; demo: boolean; brief: Brief | null; contact: Contact[]; found: FoundBusiness[]; blocked: { name: string; reason: string }[]; limit?: SpendLimit }
  | { kind: "needs_info"; demo: boolean; label: string; missing: string[]; optional: string[] }
  | { kind: "started"; demo: boolean; job_id: string; title: string; when?: string; where?: string; budget_usd?: number; limit?: SpendLimit; contacted: Contact[]; not_contacted: number };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const MAX = 200;
const str = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s;
};
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const CHANNELS = new Set(["email", "phone", "imessage", "a2a"]);
const channel = (v: unknown): string | null => (typeof v === "string" && CHANNELS.has(v) ? v : null);

/** "2026-11-05" -> "Thu, Nov 5" (the calendar day as written, no time zone shift); anything else as given. */
export function formatDay(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "12:00" -> "12 pm", "08:30" -> "8:30 am"; anything else as given. */
export function formatTime(s: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return s;
  const h = Number(m[1]);
  const ap = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m[2] === "00" ? `${h12} ${ap}` : `${h12}:${m[2]} ${ap}`;
}

function whenOf(r: Obj): string | undefined {
  const said = str(r.when);
  if (said) return said;
  const date = str(r.date);
  if (!date) return undefined;
  const until = str(r.date_until);
  const time = str(r.time);
  return `${formatDay(date)}${until ? ` to ${formatDay(until)}` : ""}${time ? `, ${formatTime(time)}` : ""}`;
}

function requirementText(v: unknown): string | undefined {
  return str(v) ?? str(obj(v)?.text);
}

/** The brief from deal's input, or null when there is no request to show. */
export function briefFromInput(input: unknown): Brief | null {
  const i = obj(input);
  const r = obj(i?.request);
  const what = str(r?.what);
  if (!i || !r || !what) return null;
  const q = r.quantity;
  const unit = str(r.unit);
  const quantity = typeof q === "number" && Number.isFinite(q) ? `${q.toLocaleString("en-US")}${unit ? ` ${unit}` : ""}` : str(q);
  const where = [str(r.venue), str(r.area) ?? str(r.where)].filter(Boolean).join(", ") || undefined;
  const must: string[] = [];
  const add = (s: string | undefined) => {
    if (s && !must.some((m) => m.toLowerCase() === s.toLowerCase())) must.push(sentence(s));
  };
  for (const x of arr(r.requirements)) add(requirementText(x));
  for (const x of arr(i.requirements)) add(requirementText(x));
  if (typeof r.dietary === "string") add(str(r.dietary));
  for (const x of arr(r.dietary)) add(str(x));
  const delivery = str(r.delivery);
  if (delivery) add(delivery);
  const details = arr(r.details).flatMap((d) => {
    const label = str(obj(d)?.label);
    const value = str(obj(d)?.value);
    return label && value ? [{ label: sentence(label), value }] : [];
  });
  const budget = num(i.budget_usd);
  const budgetText = budget === undefined ? str(i.budget) : undefined;
  return {
    what: sentence(what),
    ...(quantity ? { quantity } : {}),
    ...(whenOf(r) ? { when: whenOf(r)! } : {}),
    ...(where ? { where } : {}),
    ...(budget !== undefined ? { budget_usd: budget } : {}),
    ...(budgetText ? { budget_text: budgetText } : {}),
    ...(i.budget_is_hard_limit === true ? { hard_limit: true } : {}),
    details: details.slice(0, 12),
    must_haves: must.slice(0, 20),
  };
}

const LISTING_REF = /^(aws|place):[A-Za-z0-9_=+/-]{3,515}$/;
const isFound = (c: unknown) => obj(c)?.contact_state === "will_authorize_on_start";

/** Found businesses from deal's would_contact (contact_state will_authorize_on_start), whitelisted fields only. */
function foundOf(v: unknown): FoundBusiness[] {
  return arr(v).filter(isFound).flatMap((c) => {
    const o = obj(c)!;
    const via = obj(o.found_via);
    const name = str(o.name);
    const ref = typeof o.business_ref === "string" && LISTING_REF.test(o.business_ref) ? o.business_ref : undefined;
    if (!name || !ref) return [];
    const hours = str(o.hours_today);
    return [{ name, ref, listing: str(via?.listing) ?? "a public listing", email_from: via?.email_from === "listing" ? "listing" as const : "website" as const, ...(hours ? { hours_today: hours } : {}) }];
  }).slice(0, 12);
}

/**
 * What "Start the deal" says on the user's behalf: with found businesses, exactly the ones the user kept
 * (by name and ref, so the assistant passes them as confirm_discovered), or that they removed them all.
 */
export function startMessage(found: FoundBusiness[], removed: ReadonlySet<string> = new Set()): string {
  if (!found.length) return "Yes, start the deal.";
  const kept = found.filter((f) => !removed.has(f.ref));
  if (!kept.length) return "Yes, start the deal, but without the businesses Haggle found (confirm_discovered: []).";
  return `Yes, start the deal. Include these businesses Haggle found (confirm_discovered): ${kept.map((f) => `${f.name} (${f.ref})`).join(", ")}.`;
}

const LIMIT_SOURCES = new Set(["budget", "stated", "human", "operator", "default"]);
/** A limit from the server's fields ({usd, source, default_usd} or the board's deal_limit_*), else undefined. */
function limitFrom(usd: unknown, source: unknown, defaultUsd?: unknown): SpendLimit | undefined {
  if (typeof source !== "string" || !LIMIT_SOURCES.has(source)) return undefined;
  const n = usd === null ? null : num(usd);
  if (n === undefined) return undefined;
  const d = num(defaultUsd);
  return { usd: n, source: source as SpendLimit["source"], ...(d !== undefined ? { default_usd: d } : {}) };
}
/** The limit the model proposed in deal's input, when the server's answer has none (it never raises one). */
function limitFromInput(i: Obj): SpendLimit | undefined {
  const stated = num(i.spend_limit_usd);
  if (stated !== undefined) return { usd: stated, source: "stated" };
  const budget = num(i.budget_usd);
  return budget !== undefined ? { usd: budget, source: "budget" } : undefined;
}

/** "Spending limit $1,200 (from your budget)"; "Spending limit set at approval ($1,500 default)". */
export function limitText(l: SpendLimit): string {
  const d = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (l.usd === null || l.source === "default") return l.usd !== null ? `Spending limit ${d(l.usd)} (default for new deals)` : `Spending limit set at approval${l.default_usd !== undefined ? ` (${d(l.default_usd)} default)` : ""}`;
  const why = { budget: "from your budget", stated: "as you stated", human: "set by you", operator: "set by the operator" }[l.source];
  return `Spending limit ${d(l.usd)} (${why})`;
}

const contacts = (v: unknown, nameKey: "name" | "business"): Contact[] =>
  arr(v).flatMap((c) => {
    const name = str(obj(c)?.[nameKey]);
    return name ? [{ name, channel: channel(obj(c)?.channel) }] : [];
  }).slice(0, 12);

/** "Lunch catering for 40" from what + headcount. */
function titleOf(what: string, headcount: unknown): string {
  const n = typeof headcount === "number" && Number.isFinite(headcount) ? headcount.toLocaleString("en-US") : str(headcount);
  return `${sentence(what)}${n ? ` for ${n}` : ""}`;
}

/**
 * The card for one finished tool call, or undefined (only deal has cards). `jobId` is the job a real
 * deal started (agent.ts startedJobId); without it a non-preview deal result has no card.
 */
export function toolCard(name: string, input: unknown, data: unknown, jobId?: string): ToolCard | undefined {
  if (name !== "deal") return undefined;
  const i = obj(input) ?? {};
  const d = obj(data) ?? {};
  const demo = d.mode === "mock";
  const needs = obj(d.needs_info);
  if (needs) {
    const qs = (v: unknown) => arr(v).flatMap((q) => (str(obj(q)?.question) ? [str(obj(q)?.question)!] : [])).slice(0, 10);
    return { kind: "needs_info", demo, label: str(needs.label) ?? "This request", missing: qs(needs.missing), optional: qs(needs.helpful) };
  }
  if ((i.dry_run === true || d.dry_run === true || d.needs_confirmation === true) && Array.isArray(d.would_contact)) {
    const blocked = arr(d.blocked).flatMap((b) => {
      const n = str(obj(b)?.name);
      return n ? [{ name: n, reason: str(obj(b)?.reason) ?? "can't be contacted" }] : [];
    });
    const sl = obj(d.spending_limit);
    const limit = (sl ? limitFrom(sl.usd, sl.source, sl.default_usd) : undefined) ?? limitFromInput(i);
    return { kind: "preview", demo, brief: briefFromInput(input), contact: contacts(arr(d.would_contact).filter((c) => !isFound(c)), "name"), found: foundOf(d.would_contact), blocked: blocked.slice(0, 12), ...(limit ? { limit } : {}) };
  }
  if (jobId) {
    const rd = obj(d.request_details);
    const brief = briefFromInput(input);
    const what = str(rd?.what) ?? brief?.what;
    const r = obj(i.request);
    const title = what ? titleOf(what, rd?.headcount ?? r?.quantity) : "Your deal";
    // The same words as the preview card; the server's own summary when there was no input.
    const when = brief?.when ?? str(rd?.when);
    const where = brief?.where ?? str(rd?.place);
    const budget = num(rd?.budget_usd) ?? brief?.budget_usd;
    const job = obj(d.job);
    const limit = limitFrom(job?.deal_limit_usd, job?.deal_limit_source);
    return {
      kind: "started", demo, job_id: jobId, title,
      ...(when && when !== "no date given" ? { when } : {}),
      ...(where ? { where } : {}),
      ...(budget !== undefined ? { budget_usd: budget } : {}),
      ...(limit ? { limit } : {}),
      contacted: contacts(d.contacted, "business"),
      not_contacted: arr(d.not_contacted).length,
    };
  }
  return undefined;
}

/** A stored tool_result's text: the tool's text, then "\n\ndata: <json>" (agent.ts runTool; may be capped). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content).map((b) => (typeof obj(b)?.text === "string" ? (obj(b)!.text as string) : "")).join("\n");
}

/** The card for a stored deal call: its input and the stored tool_result (data parsed when it wasn't capped). */
export function storedToolCard(name: string, input: unknown, result: { content?: unknown; is_error?: boolean } | undefined): ToolCard | undefined {
  if (name !== "deal" || !result || result.is_error) return undefined;
  const text = typeof result.content === "string" ? result.content : resultText(result.content);
  const at = text.indexOf("\n\ndata: ");
  let data: unknown;
  if (at >= 0) {
    try {
      data = JSON.parse(text.slice(at + 8));
    } catch {
      data = undefined; // capped: fall back to the input and the job id in the text
    }
  }
  const i = obj(input) ?? {};
  const d = obj(data);
  const dry = i.dry_run === true || d?.dry_run === true || d?.needs_confirmation === true;
  const jobId = dry ? undefined : (typeof d?.job_id === "string" ? d.job_id : undefined) ?? /"job_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? /^Deal (job_[A-Za-z0-9_-]+) started/m.exec(text)?.[1];
  return toolCard(name, input, data, jobId);
}
