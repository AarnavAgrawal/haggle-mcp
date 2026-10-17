// Restaurant simulators (DESIGN.md §15). Each persona owns a Primitive inbox,
// long-polls it, waits its reply delay, and replies in its own voice. No real
// business is contacted.
//
// Numbers are decided here in code (price range, deposit rule, negotiation
// drop); Claude only phrases the reply in the persona's style. That keeps the
// demo predictable and the parser test honest.
//
// Runs two ways with the same code: `npm run sim` on a laptop (state in a
// file, see runSim.ts) or inside the server with SIM_ON_SERVER=true (state in
// the database, see src/sim/hosted.ts).
import Anthropic from "@anthropic-ai/sdk";
import primitive from "@primitivedotdev/sdk";
import { getEmail } from "@primitivedotdev/sdk/api";
import { makeMenuPdf } from "./menuPdf.ts";
import { PERSONAS, type Persona } from "./personas.ts";

export interface SimState {
  /** Inbox stream position per persona, so a restart never double-replies. */
  cursors: Record<string, string>;
  /** Last per-head price quoted, keyed "<persona>:<thread>", for counteroffers. */
  lastPrice: Record<string, number>;
}

export interface SimStore {
  load(): Promise<SimState>;
  /** Called after each handled email with the full state; persist this persona's part. */
  save(personaId: string, state: SimState): Promise<void>;
}

interface SimSettings {
  model: string;
  /** Every persona quotes the middle of its price range (repeatable eval runs). */
  deterministic: boolean;
  /** Shrinks reply delays so slow personas land inside DEMO_MODE's 60 s window (try 0.3). */
  delayScale: number;
}

function settingsFromEnv(): SimSettings {
  return {
    model: process.env.SIM_MODEL ?? "claude-haiku-5-5",
    deterministic: process.env.SIM_DETERMINISTIC === "true",
    delayScale: Number(process.env.SIM_DELAY_SCALE ?? "1"),
  };
}

// Created on first use so a run with no persona keys set needs no Anthropic key.
let anthropicClient: Anthropic | undefined;
const anthropic = () => (anthropicClient ??= new Anthropic());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);
const roundToHalf = (n: number) => Math.round(n * 2) / 2;

function headcountFrom(body: string): number {
  const m = body.match(/Guests:\s*(\d+)/i) ?? body.match(/(\d+)\s*(guests|people|ppl)/i);
  return m ? Number(m[1]) : 40;
}

/** "another quote of $21.00/person" -> 21 */
function citedCompetitorPrice(body: string): number | null {
  const m = body.match(/another quote of \$(\d+(?:\.\d+)?)\/person/i);
  return m ? Number(m[1]) : null;
}

function decideNumbers(p: Persona, body: string, previous: number | undefined, s: SimSettings) {
  const headcount = headcountFrom(body);
  const competitor = citedCompetitorPrice(body);
  const isCounter = competitor !== null && previous !== undefined;

  const [lo, hi] = p.pricePerHead!;
  let perHead = roundToHalf(s.deterministic ? (lo + hi) / 2 : between(p.pricePerHead!));
  if (isCounter) {
    const drop = p.negotiation?.dropPercent ?? 0;
    perHead = drop > 0 ? roundToHalf(previous * (1 - drop / 100)) : previous;
  }
  const subtotal = perHead * headcount;
  const delivery = p.deliveryFee ?? 0;
  const total = subtotal + delivery;
  const deposit = p.deposit!.type === "flat" ? p.deposit!.amount : Math.round((total * p.deposit!.amount) / 100);

  return { headcount, perHead, delivery, total, deposit, isCounter, previous };
}

async function writeReply(p: Persona, inbound: string, n: ReturnType<typeof decideNumbers>, s: SimSettings): Promise<string> {
  const facts = n.isCounter
    ? n.perHead < n.previous!
      ? `You are lowering your price from $${n.previous!.toFixed(2)} to $${n.perHead.toFixed(2)} per person. New total $${n.total.toFixed(2)} including $${n.delivery} delivery. Deposit $${n.deposit}.`
      : `You cannot lower your price; it stays $${n.perHead.toFixed(2)} per person. Politely decline to match.`
    : `Quote $${n.perHead.toFixed(2)} per person for ${n.headcount} guests. Delivery fee $${n.delivery}. Total $${n.total.toFixed(2)}. Deposit $${n.deposit}. ${p.coversDietary ? "You can cover the dietary needs listed." : "You cannot accommodate special diets."}`;

  const res = await anthropic().messages.create({
    model: s.model,
    max_tokens: 1024,
    output_config: { effort: "low" },
    system: `You are ${p.name}, a restaurant replying to a catering inquiry by email. Style: ${p.style}\nUse exactly the numbers given in FACTS; do not invent other prices. Reply with the email body only.`,
    messages: [{ role: "user", content: `FACTS: ${facts}\n\nThe email you are replying to:\n${inbound}` }],
  });
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
  if (!text) throw new Error(`empty reply (stop_reason=${res.stop_reason})`);
  return text;
}

async function runPersona(p: Persona, state: SimState, store: SimStore, s: SimSettings): Promise<void> {
  const client = primitive.client({ apiKey: process.env[p.apiKeyEnv]! });
  console.log(`[sim:${p.id}] listening`);

  for await (const email of client.inbox.stream({ since: state.cursors[p.id], automated: false })) {
    try {
      const full = await getEmail({ client: client.client, path: { id: email.id } });
      const body = full.data?.data?.body_text ?? "";
      const threadKey = `${p.id}:${email.threadId ?? email.id}`;
      const numbers = decideNumbers(p, body, state.lastPrice[threadKey], s);

      const delay = between(p.replyDelaySeconds!) * 1000 * s.delayScale;
      console.log(`[sim:${p.id}] got "${email.subject}"; replying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);

      const text = await writeReply(p, body, numbers, s);
      // The formal persona attaches a PDF menu on its first quote, to exercise PDF parsing.
      const attachments =
        p.attachMenuPdf && !numbers.isCounter
          ? [{
              filename: `${p.id}-menu.pdf`,
              content_type: "application/pdf",
              content_base64: makeMenuPdf(`${p.name}: catering menu`, [
                ...(p.menu ?? []),
                "",
                `Price: $${numbers.perHead.toFixed(2)} per person for ${numbers.headcount} guests`,
                `Delivery and setup: $${numbers.delivery}`,
                `Deposit to confirm: $${numbers.deposit}`,
              ]).toString("base64"),
            }]
          : undefined;
      // Same key for the same inbound email, so a restart can't send a second reply.
      await email.reply({ text, attachments }, { idempotencyKey: `sim:${p.id}:${email.id}` });
      state.lastPrice[threadKey] = numbers.perHead;
      console.log(`[sim:${p.id}] replied at $${numbers.perHead.toFixed(2)}/head${numbers.isCounter ? " (counteroffer)" : ""}`);
    } catch (err) {
      console.error(`[sim:${p.id}] failed on ${email.id}:`, err instanceof Error ? err.message : err);
    }
    // Persist the cursor after each email so a restart resumes after it.
    state.cursors[p.id] = email.cursor;
    await store.save(p.id, state).catch((err) => console.error(`[sim:${p.id}] could not save state:`, err instanceof Error ? err.message : err));
  }
}

/**
 * Start every persona that has an API key. Each runs forever; if one crashes
 * (network blip, Primitive restart) it waits and resumes from its saved cursor.
 */
export async function startSimulators(store: SimStore): Promise<void> {
  const settings = settingsFromEnv();
  const state = await store.load();
  await Promise.all(
    PERSONAS.map(async (p) => {
      if (!process.env[p.apiKeyEnv]) return console.log(`[sim:${p.id}] skipped: ${p.apiKeyEnv} not set`);
      if (p.neverReplies) return console.log(`[sim:${p.id}] silent persona; never replies (tests the timeout)`);
      for (;;) {
        try {
          await runPersona(p, state, store, settings);
        } catch (err) {
          console.error(`[sim:${p.id}] stopped:`, err instanceof Error ? err.message : err);
        }
        await sleep(10_000);
      }
    }),
  );
}
