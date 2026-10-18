// Real-Claude extraction on the actual live reply formats (2026-10-18 rehearsal, job_868e…): calls only
// the Anthropic API, contacts no business. Guards against the "compiled grammar is too large" outage and
// against invented figures: numbers must come from the business's own words.
//
//   npx tsx scripts/acceptance/extract-eval.mts apps/mcp/.env
import fs from "node:fs";
import { createAnthropicClient, dropAgentOnlyAmounts, parseReply } from "../../packages/engine/src/index.ts";

const env = Object.fromEntries(fs.readFileSync(process.argv[2] ?? "apps/mcp/.env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const client = createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY!, ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) });
const model = env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const request = { what: "catering", date: "2026-10-24", headcount: 50, location: "San Francisco, CA", dietary: [], requirements: [] };
const RFQ = "On 10/18/2026, 12:08:19 AM, haggle@inkboxmail.com wrote:\n> Hi Harbor Table,\n> I'm an AI assistant arranging this order for a client. Could you quote the following?\n> - What: catering\n> - When: Saturday, October 24, 2026\n> - People: 50\n> - Location: San Francisco, CA\n> Please reply by Sunday October 18 07:38 UTC with your total price, what it includes (delivery or travel, tax), any deposit you need.";
export const REPLIES = [
  { who: "Sunset Kitchen (iMessage)", channel: "imessage", text: "$1500, $250 deposit", total: 1500, deposit: 250 },
  { who: "Harbor Table (email)", channel: "email", text: `prolly around 1300 total bucks\n\n${RFQ}`, total: 1300, deposit: null },
  { who: "Mission Eats (call)", channel: "phone", text: "remote: Hello\nhaggle (AI assistant): Hi, this is Haggle, an AI assistant calling for a customer about a quote for catering. Do you have a minute?\nremote: Yes, I do. What's up\nhaggle (AI assistant): Great. So I'm hoping to get a quote for catering for 50 people on Saturday, October 24th, 2026 in San Francisco. Um. Could you give me the all-in total, including delivery and tax?\nremote: It'll cost approximately twelve hundred dollars", total: 1200, deposit: null },
];
let fails = 0;
for (const r of REPLIES) {
  try {
    let x = await parseReply(client, model, { request, bodyText: r.text });
    if (r.channel === "phone") x = dropAgentOnlyAmounts(x, r.text);
    const problems = [
      x.total_usd !== r.total && `total ${x.total_usd} ≠ ${r.total}`,
      x.deposit_usd !== r.deposit && `deposit ${x.deposit_usd} ≠ ${r.deposit}`,
      (x.tax_usd !== null || x.delivery_fee_usd !== null) && `invented tax/delivery (${x.tax_usd}/${x.delivery_fee_usd})`,
    ].filter(Boolean);
    if (problems.length) fails++;
    if (process.env.DUMP) console.log("DUMP", JSON.stringify({ who: r.who, extraction: x }));
    console.log(`${problems.length ? "FAIL" : "PASS"}  ${r.who}: total ${x.total_usd}, deposit ${x.deposit_usd}, confidence ${x.confidence}, missing [${x.missing_fields.join(", ")}]${problems.length ? ` — ${problems.join("; ")}` : ""}`);
  } catch (e) {
    fails++;
    console.log(`FAIL  ${r.who}: ${(e as Error).message.slice(0, 160)}`);
  }
}
console.log(fails ? `\n${fails} failed` : "\nall replies parsed");
process.exitCode = fails ? 1 : 0;
