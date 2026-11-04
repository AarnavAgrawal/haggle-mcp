/**
 * The seller fleet as a library, for a host that already serves HTTP (the Haggle MCP server mounts it
 * at POST /webhooks/sellers/<handle> when HAGGLE_SELLERS_JSON is set): the six demo sellers answer a
 * demo workspace's requests around the clock without a separate seller server. Each webhook is
 * verified with that seller identity's own signing key; replies go out through Inkbox like the
 * standalone server's (src/server.ts uses the same ports).
 */
import Anthropic from "@anthropic-ai/sdk";
import { Inkbox, type AgentIdentity } from "@inkbox/sdk";
import { createSellerApp, type SellerPorts } from "./app.ts";
import { createClaudeComposer, templateReply, type Composer } from "./compose.ts";
import { parseRfq } from "./logic.ts";
import { personaByHandle, type Persona } from "./personas.ts";
import { StateStore, type Registry } from "./store.ts";
import { isSignedWebhook } from "./webhook.ts";

/** Inkbox I/O for the seller identities (an org-level key that can act as each of them). */
export function sellerPorts(inkbox: Inkbox): SellerPorts {
  const identities = new Map<string, Promise<AgentIdentity>>();
  const identity = (handle: string) => {
    if (!identities.has(handle)) identities.set(handle, inkbox.getIdentity(handle).catch((e: unknown) => { identities.delete(handle); throw e; }));
    return identities.get(handle)!;
  };
  return {
    async replyEmail(handle, { messageId, bodyText, attachments }) {
      await (await identity(handle)).replyAllEmail(messageId, { bodyText, attachments, idempotencyKey: `seller-reply-${messageId}` });
    },
    async getEmailBody(handle, messageId) {
      return (await (await identity(handle)).getMessage(messageId)).bodyText ?? "";
    },
    async getA2ATask(handle, taskId) {
      const task = await (await identity(handle)).a2aTask(taskId);
      const last = [...task.messages].reverse().find((m) => m.role !== "agent") ?? task.messages.at(-1);
      const parts = last?.parts ?? [];
      const text = parts.flatMap((part) => (typeof part.text === "string" ? [part.text] : [])).join("\n");
      const data = parts.find((part) => part.data && typeof part.data === "object")?.data;
      return { contextId: task.contextId, text, data };
    },
    async replyA2A(handle, taskId, { text, data }) {
      // The SDK takes text or parts, not both: send the prose and quote.json as two parts.
      await (await identity(handle)).a2aReply(taskId, data ? { intent: "complete", parts: [{ text }, { data }] } : { intent: "complete", text });
    },
  };
}

/**
 * The registry as HAGGLE_SELLERS_JSON carries it: { "<handle>": { "email": "...", "signingKey": "whsec_..." } }.
 * Entries without a signing key are dropped (their webhooks could not be verified). Throws on bad JSON.
 */
export function parseSellerRegistry(json: string): Registry {
  const raw = JSON.parse(json) as Record<string, { identityId?: string; email?: string; signingKey?: string }>;
  const out: Registry = {};
  for (const [handle, r] of Object.entries(raw ?? {})) {
    if (!/^[a-z0-9-]+$/.test(handle) || !r?.signingKey) continue;
    out[handle] = { identityId: r.identityId ?? "", ...(r.email ? { email: r.email } : {}), signingKey: r.signingKey };
  }
  return out;
}

/**
 * What a call to the phone persona (Mission Eats) sounds like, for a demo workspace whose calls are
 * played instead of dialed: the call brief Haggle wrote (`reason`) decides the conversation (a quote,
 * a counteroffer or a confirmation), with the persona's real prices. Pure.
 */
export function demoCallTranscript(reason: string, p: Persona = personaByHandle("mission-eats-sf")!): string {
  const r = parseRfq(reason);
  const people = r.quantity ?? 30;
  const veg = r.vegetarian;
  const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  const total = Math.round(p.perHead * people * 100) / 100;
  const floorHead = Math.round(p.perHead * (1 - p.negotiation.dropPct) * 100) / 100;
  const ai = (t: string) => `haggle (AI assistant): ${t}`;
  const biz = (t: string) => `${p.name}: ${t}`;
  if (/match or beat/i.test(reason)) {
    const lower = Math.round(floorHead * people * 100) / 100;
    return [
      biz(`${p.name}, hi!`),
      ai(`Hi, this is an AI assistant calling back about the catering quote for ${people}. We've received another quote for the same order that comes in lower. Is there any flexibility on your price?`),
      biz(`For you, okay. I can do ${money(floorHead)} a person, so ${money(lower)} total, delivery included, no deposit.`),
      ai(`Great. So that's ${money(lower)} all-in for ${people} people, delivered, no deposit?`),
      biz(`That's right. Good for seven days.`),
      ai(`Thank you, I'll pass that along.`),
    ].join("\n");
  }
  if (/go ahead with their quote|ask them to confirm/i.test(reason)) {
    return [
      biz(`${p.name}, hi!`),
      ai(`Hi, I'm an AI assistant calling for the customer about the catering order for ${people}. They'd like to go ahead with your quote.`),
      biz(`Perfect, we've got you down. We'll confirm the delivery time the day before.`),
      ai(`Thank you, that's confirmed then.`),
    ].join("\n");
  }
  return [
    biz(`${p.name}, hi, how can I help?`),
    ai(`Hi, I'm an AI assistant calling on behalf of a customer to request a catering quote: lunch for ${people} people${veg ? `, ${veg} of them vegetarian` : ""}, delivered.`),
    biz(`Sure. We do a ${p.menu.slice(0, 2).join(" or ").toLowerCase()} spread, and ${p.vegItem} for the vegetarians. It's ${money(p.perHead)} a person, delivery included.`),
    ai(`So for ${people} people that comes to...?`),
    biz(`${money(total)} total. No deposit, delivery's included.`),
    ai(`Got it: ${money(total)} all-in for ${people}, delivered, no deposit. How long is that price good for?`),
    biz(`Seven days.`),
    ai(`Thank you, I'll send this to the customer.`),
  ].join("\n");
}

export interface HostedSellersOptions {
  /** An Inkbox key that can act as every seller identity (org-level). */
  inkboxApiKey: string;
  registry: Registry;
  /** Claude writes the replies when set; otherwise the personas' templates. */
  anthropicApiKey?: string;
  /** Replies within about a minute instead of real business delays (default true: a demo). */
  fast?: boolean;
  log?: (msg: string) => void;
  /** Tests: the ports and composer to use instead of Inkbox and Claude. */
  ports?: SellerPorts;
  composer?: Composer;
  delayMs?: () => number;
}

export type SellerWebhookResult = { status: 202 | 400 | 401 | 404; body: string };

export function createHostedSellers(o: HostedSellersOptions) {
  const log = o.log ?? ((m: string) => console.log(m));
  const composer: Composer = o.composer ?? (o.anthropicApiKey ? createClaudeComposer({ client: new Anthropic({ apiKey: o.anthropicApiKey }), log }) : { write: async (p, plan) => templateReply(p, plan) });
  const app = createSellerApp({
    ports: o.ports ?? sellerPorts(new Inkbox({ apiKey: o.inkboxApiKey })),
    composer,
    // Conversation state lives in memory: a restart begins each conversation again, which a demo tolerates.
    state: new StateStore(),
    ownAddresses: new Set(Object.values(o.registry).flatMap((r) => (r.email ? [r.email.toLowerCase()] : []))),
    fast: o.fast ?? true,
    ...(o.delayMs ? { delayMs: o.delayMs } : {}),
    log,
  });
  return {
    handles: Object.keys(o.registry),
    /** One Inkbox webhook for a seller: verified with that seller's key, acknowledged at once, answered later. */
    webhook(handle: string, raw: Buffer, headers: Record<string, string>): SellerWebhookResult {
      const secret = o.registry[handle]?.signingKey;
      if (!secret) return { status: 404, body: "unknown seller" };
      if (!isSignedWebhook(raw, headers, secret)) return { status: 401, body: "bad or missing signature" };
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return { status: 400, body: "invalid JSON" };
      }
      app.handleEvent(handle, payload).then(
        (r) => log(`[sellers] ${handle}: ${r.accepted ? r.action : `rejected: ${r.reason}`}`),
        (e: unknown) => log(`[sellers] ${handle}: ${(e as Error).message}`),
      );
      return { status: 202, body: "" };
    },
    idle: () => app.idle(),
  };
}
