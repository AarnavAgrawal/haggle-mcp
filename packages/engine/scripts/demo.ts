// One-command DEMO: the real engine runs the v3 golden scenario against the simulated fleet,
// in memory, with simulated time. Everything printed comes from the engine's own events and
// results; nothing is scripted output. Simulated businesses, approval and payment are labelled.
import { createMockEngine, fleetBusinesses, GOLDEN_REQUEST } from "../src/index.ts";

const c = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", x: "\x1b[0m" };
let t = Date.now();
const { engine, fleet } = createMockEngine({ now: () => new Date(t) });
const clock = () => `${c.dim}+${String(Math.round((t - start) / 1000)).padStart(3)}s${c.x}`;
const start = t;
const names = new Map(fleetBusinesses().map((b) => [b.business_id, b.name]));
const log = (s: string) => console.log(`${clock()}  ${s}`);

console.log(`\n${c.y}${c.b}DEMO MODE${c.x}${c.y} · simulated businesses, approval and payment · no real email or funds${c.x}\n`);
const { budget_usd, ...request } = GOLDEN_REQUEST;
const deal = await engine.deal({ request, budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...((b as { phone?: string }).phone ? { phone: (b as { phone?: string }).phone } : {}), source: "fleet" })) });
log(`${c.b}deal${c.x} ${deal.job_id}: ${request.quantity} × ${request.what}, ${request.date}, ${request.area}, budget $${budget_usd}, ≥12 vegetarian, delivery`);
log(`buyer inbox ${deal.inbox} · contacted ${deal.contacted.length} businesses: ${deal.contacted.map((x) => `${x.business} [${x.channel}]`).join(", ")}`);

let cursor = 0;
let ready = false;
for (let i = 0; i < 400 && !ready; i++) {
  t += 1000;
  const w = await engine.waitForUpdate(deal.job_id, cursor, 0);
  cursor = Number(w.cursor);
  for (const u of w.updates) {
    const who = "business_id" in u ? names.get(u.business_id) ?? "" : "";
    if (u.type === "quote") log(`${c.g}quote${c.x}   ${who}: $${u.total_usd.toLocaleString()} (round ${u.round})`);
    else if (u.type === "question") log(`${c.y}question${c.x} ${who}: "${u.text}"`);
    else if (u.type === "flag") log(`${c.r}flag${c.x}    ${who}: ${u.flag.replace(/_/g, " ")}`);
    else if (u.type === "state") log(`${c.b}state${c.x}   ${u.from} → ${u.to}`);
    else if (u.type === "reply" && /Counteroffer|Asked|Answered/.test(u.summary)) log(`${c.dim}email${c.x}   ${u.summary}`);
  }
  const q = await engine.getQuotes(deal.job_id);
  for (const p of q.pending_questions) {
    log(`agent answers ${names.get(p.business_id)} via answer_business: "Yes, plates and cutlery for 40."`);
    await engine.answerSeller(deal.job_id, p.question_id, "Yes, plates and cutlery for 40.");
  }
  ready = q.ready;
}

const q = await engine.getQuotes(deal.job_id);
console.log(`\n${c.b}Ranked quotes${c.x}`);
const excluded = new Set(q.rejected.map((r) => r.business_id));
for (const x of q.quotes) {
  const fit = excluded.has(x.business_id) ? `${c.r}excluded${c.x}` : x.meets_requirements ? "fits" : `${c.r}doesn't fit${c.x}`;
  const rec = x.quote_id === q.recommended_quote_id ? `${c.g}★${c.x}` : " ";
  console.log(`  ${rec} ${x.business.padEnd(16)} ${x.total_usd ? `$${x.total_usd.toLocaleString()}`.padStart(7) : "     —"}  deposit ${x.deposit_usd ? `$${x.deposit_usd}` : "—"}  ${fit}  ${x.negotiated_from ? `(was $${x.negotiated_from.toLocaleString()})` : ""} ${x.flags.length ? `${c.dim}[${x.flags.join(", ")}]${c.x}` : ""}`);
}
for (const r of q.rejected) console.log(`  ${c.r}×${c.x} ${q.business_names[r.business_id]}: ${r.reason.replace(/_/g, " ")}`);

const best = q.quotes.find((x) => x.quote_id === q.recommended_quote_id)!;
console.log("");
const approval = await engine.requestApproval(deal.job_id, best.quote_id, "simulated");
log(`approve: ${best.business} $${best.total_usd} with $${best.deposit_usd} deposit · ${c.y}DEMO simulated human says yes${c.x}`);
await engine.decideApproval(approval.id, "approve", "simulated", "DEMO simulated human");
await engine.pay(deal.job_id, best.quote_id);
for (let i = 0; i < 30; i++) {
  t += 1000;
  const w = await engine.waitForUpdate(deal.job_id, cursor, 0);
  cursor = Number(w.cursor);
  for (const u of w.updates) if (u.type === "payment") log(`payment ${u.status.replace(/_/g, " ")}`);
  if (w.state === "paid") break;
}
const final = await engine.getQuotes(deal.job_id);
console.log(`\n${c.b}${final.state === "paid" ? `${c.g}PAID` : final.state}${c.x} · receipt ${final.payment?.settle_tx} ${c.y}(DEMO receipt, not on-chain)${c.x}`);
console.log(`${c.dim}${fleet.sent.length} emails sent, every one with a unique idempotency key; audit trail has ${cursor} events.${c.x}\n`);
