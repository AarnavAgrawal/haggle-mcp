// Real-Claude evaluation of the negotiation strategist on hard scenarios. Calls only the Anthropic API:
// no business is contacted. Prints each decision and PASS/FAIL against scenario expectations, and checks
// that every validated move is truthful (the planner's wording, no invented numbers).
//
//   npx tsx scripts/acceptance/strategy-eval.mts apps/mcp/.env
import fs from "node:fs";
import { applyStrategy, claudeStrategist, createAnthropicClient, planCounteroffers, type CounterQuote, type StrategyContext } from "../../packages/engine/src/index.ts";

const env = Object.fromEntries(fs.readFileSync(process.argv[2] ?? "apps/mcp/.env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const strategist = claudeStrategist(createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY!, ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) }), env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5");
const q = (id: string, name: string, cents: number, extra: Partial<CounterQuote> = {}): CounterQuote => ({ quoteId: `q_${id}`, businessId: `b_${id}`, businessName: name, totalCents: cents, available: true, compliant: true, senderTrusted: true, round: 1, status: "current", confidence: 0.9, flags: [], ...extra });

type Scenario = { name: string; quotes: CounterQuote[]; target: number | null; ctx: Omit<StrategyContext, "quotes" | "targetUsd" | "hardLimit">; notes: Record<string, string[]>; expect: (sent: Set<string>, skipped: Set<string>) => string | null };
const scenarios: Scenario[] = [
  {
    name: "promising above-budget vendor is pursued, not dropped",
    quotes: [q("a", "Ace Movers", 620_000), q("b", "Bolt Movers", 640_000, { deliveryFeeCents: 30_000 })], target: 500_000,
    ctx: { what: "office move", quantity: 1 }, notes: { b_b: ["$300 truck fee listed separately"] },
    expect: (sent) => (sent.has("b_a") && sent.has("b_b") ? null : "expected counters to both over-target movers"),
  },
  {
    name: "a vendor already near the cheapest quote is worth a counter; a wildly priced one may be skipped",
    quotes: [q("c", "Cheap Co", 300_000), q("n", "Near Co", 310_000), q("w", "Wild Co", 900_000)], target: null,
    ctx: { what: "catering", quantity: 100 }, notes: {},
    expect: (sent) => (sent.has("b_n") ? null : "expected a counter to the near-cheapest vendor"),
  },
  {
    name: "already at target: no target counter is ever planned",
    quotes: [q("t", "On Target", 480_000)], target: 500_000,
    ctx: { what: "printing", quantity: 1000 }, notes: {},
    expect: (sent) => (sent.size === 0 ? null : "nothing should be sent to a vendor already at target"),
  },
  {
    name: "deposit-heavy cheapest vendor: target counter may ask about the deposit, never a number",
    quotes: [q("d", "Deposit Heavy", 520_000, { depositCents: 260_000 })], target: 450_000,
    ctx: { what: "roof repair", quantity: 1 }, notes: { b_d: ["50% deposit, non-refundable"] },
    expect: (sent) => (sent.has("b_d") ? null : "expected a target counter"),
  },
];

let fails = 0;
for (const s of scenarios) {
  const plan = planCounteroffers(s.quotes, new Date(Date.now() + 15 * 60_000), 3, null, s.target);
  let decision = null;
  if (plan.length) decision = await strategist.decide(plan, { ...s.ctx, targetUsd: s.target === null ? null : s.target / 100, hardLimit: false, quotes: s.quotes.map((x) => ({ business_id: x.businessId, business: x.businessName, total_usd: x.totalCents! / 100, deposit_usd: x.depositCents ? x.depositCents / 100 : null, round: 1, channel: "email", notes: s.notes[x.businessId] ?? [] })) });
  const r = applyStrategy(plan, decision, s.quotes.map((x) => x.businessName));
  const sent = new Set(r.moves.map((m) => m.businessId));
  const skipped = new Set(r.skipped.map((m) => m.business_id));
  // Truthfulness: every dollar figure in a sent text is one the planner put there.
  const planned = new Map(plan.map((p) => [p.businessId, new Set([...p.text.matchAll(/\$[\d,]+\.\d{2}/g)].map((m) => m[0]))]));
  const invented = r.moves.flatMap((m) => [...m.text.matchAll(/\$[\d,]+\.\d{2}/g)].map((x) => x[0]).filter((x) => !planned.get(m.businessId)!.has(x)));
  const problem = s.expect(sent, skipped) ?? (invented.length ? `invented figures: ${invented.join(", ")}` : null);
  if (problem) fails++;
  console.log(`${problem ? "FAIL" : "PASS"}  ${s.name}${problem ? ` — ${problem}` : ""}`);
  for (const m of r.moves) console.log(`      send ${m.businessName} (${m.basis}) — ${m.strategy.reason}${m.strategy.extra_ask ? ` | asks: "${m.strategy.extra_ask}"` : ""}`);
  for (const k of r.skipped) console.log(`      skip ${k.business_id} — ${k.reason}`);
  if (r.rejectedAsks.length) console.log(`      rejected asks: ${r.rejectedAsks.join("; ")}`);
}
console.log(fails ? `\n${fails} scenario(s) failed` : "\nall scenarios passed");
process.exitCode = fails ? 1 : 0;
