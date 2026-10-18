// Read-only: what Supabase holds for one job. Masks phone numbers except the last 4 digits.
import postgres from "postgres";
import fs from "node:fs";
const url = fs.readFileSync("apps/mcp/.env", "utf8").match(/^SUPABASE_DB_URL=(.*)$/m)[1];
const sql = postgres(url, { max: 1, prepare: false });
const job = process.argv[2];
const m = (s) => (s == null ? s : String(s).replace(/\+?\d{7,}/g, (x) => "…" + x.slice(-4)));
const [j] = await sql`select id, state, round, ready, budget_cents, payment_cap_cents, request from jobs where id = ${job}`;
console.log("JOB", m(JSON.stringify(j)));
for (const b of await sql`select name, channel, status, phone, contacted_at, last_reply_at from job_businesses where job_id = ${job}`) console.log("BIZ", m(JSON.stringify(b)));
for (const x of await sql`select direction, kind, channel, provider_email_id, sender_trusted, trust_reason, matched_via, parse_status, left(body_text, 400) as body, created_at from messages where job_id = ${job} order by created_at`) console.log("MSG", m(JSON.stringify(x)));
for (const q of await sql`select id, business_id, total_cents, status, compliant, sender_trusted, round, source, created_at from quotes where job_id = ${job} order by created_at`) console.log("QUOTE", JSON.stringify(q));
for (const e of await sql`select seq, type, left(data::text, 220) as data from job_events where job_id = ${job} order by seq`) console.log("EVT", m(JSON.stringify(e)));
await sql.end();
