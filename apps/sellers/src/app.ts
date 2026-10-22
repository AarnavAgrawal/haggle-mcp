/**
 * The seller fleet's brain-free core: route one Inkbox webhook event to the right persona,
 * decide the reply, wait like a real business would, then answer on the same channel.
 * All I/O goes through `ports`, so tests run without Inkbox or Claude.
 */
import type { Composer } from "./compose.ts";
import { detectCancel, planReply, quoteJson, type Plan } from "./logic.ts";
import { quotePdfBase64 } from "./pdf.ts";
import { PERSONAS, type Persona } from "./personas.ts";
import type { StateStore } from "./store.ts";
import { drawTerms, type Terms } from "./variation.ts";

export interface Attachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

export interface SellerPorts {
  replyEmail(handle: string, args: { messageId: string; bodyText: string; attachments: Attachment[] }): Promise<void>;
  getEmailBody(handle: string, messageId: string): Promise<string>;
  getA2ATask(handle: string, taskId: string): Promise<{ contextId: string; text: string; data?: unknown }>;
  replyA2A(handle: string, taskId: string, args: { text: string; data?: Record<string, unknown> }): Promise<void>;
}

export interface SellerAppOptions {
  ports: SellerPorts;
  composer: Composer;
  state: StateStore;
  personas?: Persona[];
  /** Our own seller addresses: never answer mail from them (no reply loops). */
  ownAddresses?: Set<string>;
  /** Demo mode: replies within seconds instead of real business delays. */
  fast?: boolean;
  /** Override waiting (tests pass `() => 0`). */
  delayMs?: (p: Persona) => number;
  /** Terms for a new conversation (default: a fresh random draw; `baseTerms` = no variety). */
  drawTerms?: (p: Persona) => Terms;
  log?: (msg: string) => void;
  now?: () => Date;
}

export type HandleResult = { accepted: true; action: string } | { accepted: false; reason: string };

export function createSellerApp(opts: SellerAppOptions) {
  const personas = opts.personas ?? PERSONAS;
  const seen = new Set<string>();
  const pending = new Set<Promise<void>>();
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = opts.now ?? (() => new Date());
  const delayMs = opts.delayMs ?? ((p: Persona) => defaultDelay(p, opts.fast ?? false));
  const draw = opts.drawTerms ?? ((p: Persona) => drawTerms(p));

  function later(p: Persona, label: string, work: () => Promise<void>) {
    const wait = delayMs(p);
    log(`[sellers] ${p.name}: ${label} in ${Math.round(wait / 1000)}s`);
    const job = new Promise<void>((resolve) => setTimeout(resolve, wait))
      .then(work)
      .catch((e: unknown) => log(`[sellers] ${p.name}: reply failed: ${(e as Error).message}`))
      .finally(() => pending.delete(job));
    pending.add(job);
  }

  async function handleEvent(handle: string, payload: unknown): Promise<HandleResult> {
    const p = personas.find((x) => x.handle === handle);
    if (!p) return { accepted: false, reason: `unknown seller handle '${handle}'` };
    const event = payload as { id?: string; event_type?: string; data?: Record<string, unknown> };
    if (!event?.event_type || !event.data) return { accepted: false, reason: "not an Inkbox event" };
    if (event.id) {
      if (seen.has(event.id)) return { accepted: true, action: "duplicate ignored" };
      seen.add(event.id);
    }

    if (event.event_type === "message.received") return onEmail(p, event.data);
    if (event.event_type === "a2a.task.created" || event.event_type === "a2a.task.message") return onA2A(p, event.data);
    return { accepted: true, action: `ignored ${event.event_type}` };
  }

  async function onEmail(p: Persona, data: Record<string, unknown>): Promise<HandleResult> {
    const msg = data.message as
      | { id: string; thread_id?: string | null; from_address?: string; direction?: string; subject?: string | null; body?: string | null; body_truncated?: boolean | null }
      | undefined;
    if (!msg?.id) return { accepted: false, reason: "message.received without a message" };
    if (msg.direction && msg.direction !== "inbound") return { accepted: true, action: "outbound ignored" };
    if (msg.from_address && opts.ownAddresses?.has(msg.from_address.toLowerCase())) return { accepted: true, action: "own mail ignored" };
    // Mission Eats only does business by phone (PLAN §8).
    if (p.channel === "phone") return { accepted: true, action: "phone-only business ignores email" };

    const body = !msg.body || msg.body_truncated ? await opts.ports.getEmailBody(p.handle, msg.id) : msg.body;
    const text = `${msg.subject ?? ""}\n${body}`;
    const key = `${p.handle}:mail:${msg.thread_id ?? msg.id}`;
    if (opts.state.get(key) && detectCancel(text)) return { accepted: true, action: "cancellation noted" };
    const { plan, state, persona } = planReply(p, opts.state.get(key), text, findJsonPart(text), draw);
    opts.state.set(key, state);

    later(p, describePlan(plan), async () => {
      const bodyText = await opts.composer.write(persona, plan, text);
      const attachments = await attachmentsFor(persona, plan, now());
      await opts.ports.replyEmail(p.handle, { messageId: msg.id, bodyText, attachments });
      log(`[sellers] ${p.name}: replied (${describePlan(plan)})`);
    });
    return { accepted: true, action: describePlan(plan) };
  }

  async function onA2A(p: Persona, data: Record<string, unknown>): Promise<HandleResult> {
    const taskId = data.task_id as string | undefined;
    if (!taskId) return { accepted: false, reason: "A2A event without task_id" };
    if (p.channel !== "a2a") return { accepted: true, action: "not an A2A business" };

    const task = await opts.ports.getA2ATask(p.handle, taskId);
    const key = `${p.handle}:a2a:${task.contextId}`;
    if (opts.state.get(key) && detectCancel(task.text)) return { accepted: true, action: "cancellation noted" };
    const { plan, state, persona } = planReply(p, opts.state.get(key), task.text, task.data, draw);
    opts.state.set(key, state);

    later(p, describePlan(plan), async () => {
      const text = await opts.composer.write(persona, plan, task.text, "a2a");
      const structured = plan.kind === "question" ? undefined : quoteJson(persona, plan.facts, now());
      await opts.ports.replyA2A(p.handle, taskId, { text, ...(structured ? { data: structured } : {}) });
      log(`[sellers] ${p.name}: A2A ${describePlan(plan)} sent`);
    });
    return { accepted: true, action: describePlan(plan) };
  }

  return {
    handleEvent,
    /** Resolves when every scheduled reply has been sent (tests, graceful shutdown). */
    async idle() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

async function attachmentsFor(p: Persona, plan: Plan, now: Date): Promise<Attachment[]> {
  if (plan.kind !== "quote") return [];
  const out: Attachment[] = [];
  if (p.pdfQuote) {
    out.push({ filename: `${p.handle}-quote.pdf`, contentType: "application/pdf", contentBase64: await quotePdfBase64(p, plan.facts, now) });
  }
  if (p.quoteJson) {
    const json = JSON.stringify(quoteJson(p, plan.facts, now), null, 2);
    out.push({ filename: "quote.json", contentType: "application/json", contentBase64: Buffer.from(json).toString("base64") });
  }
  return out;
}

/** An rfq.json the buyer pasted or attached inline as text, if any. */
function findJsonPart(text: string): unknown {
  const m = text.match(/\{[\s\S]*"(?:quantity|headcount)"[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}

function describePlan(plan: Plan): string {
  if (plan.kind === "question") return "question";
  if (plan.kind === "confirm") return "confirmation";
  if (plan.held) return `held at $${plan.facts.total}`;
  return plan.facts.negotiatedFrom !== undefined ? `revised quote $${plan.facts.total}` : `quote $${plan.facts.total}`;
}

/** Real businesses take minutes to hours; demo mode answers in seconds but keeps the order (A2A first, Sunset last). */
export function defaultDelay(p: Persona, fast: boolean): number {
  const [lo, hi] = p.replyDelaySec;
  const real = lo + Math.random() * (hi - lo);
  if (!fast) return real * 1000;
  if (p.channel === "a2a") return 1000 + Math.random() * 1000;
  return Math.min(45_000, 4000 + Math.sqrt(real) * 500);
}
