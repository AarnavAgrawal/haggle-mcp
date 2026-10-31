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

export type ToolCard =
  | { kind: "preview"; demo: boolean; brief: Brief | null; contact: Contact[]; blocked: { name: string; reason: string }[] }
  | { kind: "needs_info"; demo: boolean; label: string; missing: string[]; optional: string[] }
  | { kind: "started"; demo: boolean; job_id: string; title: string; when?: string; where?: string; budget_usd?: number; contacted: Contact[]; not_contacted: number };

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
  if ((i.dry_run === true || d.dry_run === true) && Array.isArray(d.would_contact)) {
    const blocked = arr(d.blocked).flatMap((b) => {
      const n = str(obj(b)?.name);
      return n ? [{ name: n, reason: str(obj(b)?.reason) ?? "can't be contacted" }] : [];
    });
    return { kind: "preview", demo, brief: briefFromInput(input), contact: contacts(d.would_contact, "name"), blocked: blocked.slice(0, 12) };
  }
  if (jobId) {
    const rd = obj(d.request_details);
    const brief = briefFromInput(input);
    const what = str(rd?.what) ?? brief?.what;
    const r = obj(i.request);
    const title = what ? titleOf(what, rd?.headcount ?? r?.quantity) : "Your deal";
    const when = str(rd?.when) ?? brief?.when;
    const where = str(rd?.place) ?? brief?.where;
    const budget = num(rd?.budget_usd) ?? brief?.budget_usd;
    return {
      kind: "started", demo, job_id: jobId, title,
      ...(when && when !== "no date given" ? { when } : {}),
      ...(where ? { where } : {}),
      ...(budget !== undefined ? { budget_usd: budget } : {}),
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
  const dry = i.dry_run === true || d?.dry_run === true;
  const jobId = dry ? undefined : (typeof d?.job_id === "string" ? d.job_id : undefined) ?? /"job_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? /^Deal (job_[A-Za-z0-9_-]+) started/m.exec(text)?.[1];
  return toolCard(name, input, data, jobId);
}
