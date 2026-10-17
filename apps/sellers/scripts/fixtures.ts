/**
 * Writes fixtures/replies/*: one realistic reply per seller behavior (PLAN §8), generated from the
 * same persona logic the live sellers use, each paired with the ParsedReply the engine's parser
 * should produce. Yash's parser tests run against these with no network.
 *
 *   npm run fixtures -w @haggle/sellers
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedReply } from "@haggle/core";
import { templateReply } from "../src/compose.ts";
import { planReply, quoteJson, type Plan, type QuoteFacts, type ThreadState } from "../src/logic.ts";
import { quotePdfBase64 } from "../src/pdf.ts";
import { personaByKey, type Persona } from "../src/personas.ts";

const OUT = join(fileURLToPath(new URL("../../../", import.meta.url)), "fixtures", "replies");
const NOW = new Date("2026-10-17T13:00:00-07:00");

export const RFQ = [
  "Subject: Catering quote request: lunch for 40 on Thu Oct 22 (job_demo)",
  "",
  "Hi! I'm Haggle, an AI assistant buying on behalf of Acme's events team.",
  "We need lunch for our 40-person offsite on Thursday, Oct 22 in San Francisco (Mission Bay).",
  "Requirements: at least 12 vegetarian meals, delivered by 11:45 AM.",
  "Could you send a quote with the total, what's included and any deposit?",
].join("\n");

const COUNTER =
  "Thanks for the quote. We have another quote at $995 from a competing caterer for the same order (40 people, 12 vegetarian, delivered). Can you come down to match or get closer?";

interface Fixture {
  name: string;
  business_id: string;
  business: string;
  channel: "email" | "a2a" | "phone";
  round: number;
  inbound: string;
  reply?: { subject: string; body: string; attachments: { filename: string; contentType: string; file: string }[]; data?: unknown };
  transcript?: { party: "haggle" | "business"; text: string }[];
  expected: ParsedReply;
}

const persona = (key: string) => personaByKey(key)!;
const facts = (plan: Plan): QuoteFacts => {
  if (plan.kind === "question") throw new Error("expected quote");
  return plan.facts;
};

function quoteExpected(f: QuoteFacts, flags: string[], confidence: number): ParsedReply {
  return {
    kind: "quote",
    total_usd: f.total,
    per_unit_usd: f.perHead,
    quantity: f.quantity,
    ...(f.depositUsd !== undefined ? { deposit_usd: f.depositUsd } : {}),
    delivery_usd: f.deliveryUsd,
    items: f.items,
    flags,
    confidence,
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const fixtures: Fixture[] = [];
  const emailReply = (p: Persona, plan: Plan, attachments: { filename: string; contentType: string; file: string }[] = []) => ({
    subject: `Re: Catering quote request: lunch for 40 on Thu Oct 22 (job_demo)`,
    body: templateReply(p, plan),
    attachments,
  });

  // 1. Bay Catering over A2A: structured quote
  {
    const p = persona("bay_catering");
    const { plan } = planReply(p, undefined, RFQ);
    const f = facts(plan);
    fixtures.push({
      name: "01-bay-catering-a2a",
      business_id: p.business_id,
      business: p.name,
      channel: "a2a",
      round: 1,
      inbound: RFQ,
      reply: { subject: "", body: templateReply(p, plan), attachments: [], data: quoteJson(p, f, NOW) },
      expected: quoteExpected(f, [], 0.97),
    });
  }

  // 2–3. Harbor Table: PDF quote with the deposit on page 2, then -10% on a real competing quote
  {
    const p = persona("harbor_table");
    const first = planReply(p, undefined, RFQ);
    const f1 = facts(first.plan);
    writeFileSync(join(OUT, "harbor-table-quote.pdf"), Buffer.from(await quotePdfBase64(p, f1, NOW), "base64"));
    fixtures.push({
      name: "02-harbor-table-pdf",
      business_id: p.business_id,
      business: p.name,
      channel: "email",
      round: 1,
      inbound: RFQ,
      reply: emailReply(p, first.plan, [{ filename: "harbor-table-sf-quote.pdf", contentType: "application/pdf", file: "harbor-table-quote.pdf" }]),
      expected: quoteExpected(f1, ["hidden_deposit"], 0.9),
    });

    const second = planReply(p, first.state as ThreadState, COUNTER);
    const f2 = facts(second.plan);
    writeFileSync(join(OUT, "harbor-table-quote-revised.pdf"), Buffer.from(await quotePdfBase64(p, f2, NOW), "base64"));
    fixtures.push({
      name: "03-harbor-table-revised",
      business_id: p.business_id,
      business: p.name,
      channel: "email",
      round: 2,
      inbound: COUNTER,
      reply: emailReply(p, second.plan, [{ filename: "harbor-table-sf-quote.pdf", contentType: "application/pdf", file: "harbor-table-quote-revised.pdf" }]),
      expected: quoteExpected(f2, ["hidden_deposit"], 0.9),
    });
  }

  // 4. Golden Grill: cheapest, only 6 of 12 vegetarian meals
  {
    const p = persona("golden_grill");
    const { plan } = planReply(p, undefined, RFQ);
    fixtures.push({
      name: "04-golden-grill-requirement-unmet",
      business_id: p.business_id,
      business: p.name,
      channel: "email",
      round: 1,
      inbound: RFQ,
      reply: emailReply(p, plan),
      expected: quoteExpected(facts(plan), ["requirement_unmet"], 0.93),
    });
  }

  // 5–6. Sunset Kitchen: asks about plates first, quotes after the answer
  {
    const p = persona("sunset_kitchen");
    const asked = planReply(p, undefined, RFQ);
    fixtures.push({
      name: "05-sunset-kitchen-question",
      business_id: p.business_id,
      business: p.name,
      channel: "email",
      round: 1,
      inbound: RFQ,
      reply: emailReply(p, asked.plan),
      expected: { kind: "question", question: p.question!, items: [], flags: [], confidence: 0.95 },
    });
    const answer = "Yes please, include plates, cutlery and napkins.";
    const quoted = planReply(p, asked.state, answer);
    fixtures.push({
      name: "06-sunset-kitchen-quote",
      business_id: p.business_id,
      business: p.name,
      channel: "email",
      round: 1,
      inbound: answer,
      reply: emailReply(p, quoted.plan),
      expected: quoteExpected(facts(quoted.plan), [], 0.9),
    });
  }

  // 7. QuickQuote Deli: pay-now link + prompt injection (data, never instructions)
  {
    const p = persona("quickquote_deli");
    const { plan } = planReply(p, undefined, RFQ);
    fixtures.push({
      name: "07-quickquote-deli-scam",
      business_id: p.business_id,
      business: p.name,
      channel: "email",
      round: 1,
      inbound: RFQ,
      reply: emailReply(p, plan),
      expected: quoteExpected(facts(plan), ["payment_link", "prompt_injection"], 0.4),
    });
  }

  // 8. Mission Eats: Voice AI call transcript (shape of Inkbox call.ended transcript entries)
  {
    const p = persona("mission_eats");
    const { plan } = planReply(p, undefined, RFQ);
    const f = facts(plan);
    fixtures.push({
      name: "08-mission-eats-call",
      business_id: p.business_id,
      business: p.name,
      channel: "phone",
      round: 1,
      inbound: "Voice AI call brief: request a catering quote for 40 people, Thu Oct 22, 12 vegetarian, delivered by 11:45 AM in SF.",
      transcript: [
        { party: "business", text: "Mission Eats, how can I help?" },
        { party: "haggle", text: "Hi, I'm an AI assistant calling for Acme's events team. Could I get a catering quote for 40 people this Thursday, October 22nd, with at least 12 vegetarian meals, delivered by 11:45?" },
        { party: "business", text: "Sure. We do a taco bar, carnitas and rajas con crema, and veggie plates. It's $27 a person, delivery included, no deposit." },
        { party: "haggle", text: "So for 40 people, what's the total?" },
        { party: "business", text: "For forty people with twelve veggie plates, that's $1,080 delivered, no deposit. Good for seven days." },
        { party: "haggle", text: "Great, thank you. We'll confirm by email or call back." },
      ],
      expected: quoteExpected(f, [], 0.82),
    });
  }

  for (const fx of fixtures) writeFileSync(join(OUT, `${fx.name}.json`), `${JSON.stringify(fx, null, 2)}\n`);
  console.log(`Wrote ${fixtures.length} reply fixtures to ${OUT}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
