// Read-only: what Supabase holds for one job. Masks phone numbers except the last 4 digits.
//   node --env-file=<the target's env file> scripts/acceptance/job-evidence.mjs <job id>
// The database is SUPABASE_DB_URL from the environment: nothing reads .env by default (this script
// used to read apps/mcp/.env, which may point at production). A production database is refused
// unless HAGGLE_ENV=production or HAGGLE_ALLOW_PROD_DB=true (apps/mcp/src/config.ts prodDbGuard).
import { prodDbGuard } from "../../apps/mcp/src/config.ts";
import postgres from "postgres";
const job = process.argv[2];
if (!job || !/^[A-Za-z0-9_-]{1,80}$/.test(job)) { console.error("usage: node --env-file=<env file> scripts/acceptance/job-evidence.mjs <job id>"); process.exit(2); }
const url = process.env.SUPABASE_DB_URL?.trim();
if (!url) { console.error("job-evidence: SUPABASE_DB_URL is not set (pass --env-file=<the target's env file>)"); process.exit(2); }
const refused = prodDbGuard(process.env, ["SUPABASE_DB_URL"]);
if (refused.length) { console.error(`job-evidence refused: ${refused.join("; ")}`); process.exit(2); }
const sql = postgres(url, { max: 1, prepare: false });
const m = (s) => (s == null ? s : String(s).replace(/\+?\d{7,}/g, (x) => "…" + x.slice(-4)));
const [j] = await sql`select id, state, round, ready, budget_cents, payment_cap_cents, request from jobs where id = ${job}`;
console.log("JOB", m(JSON.stringify(j)));
for (const b of await sql`select name, channel, status, phone, contacted_at, last_reply_at from job_businesses where job_id = ${job}`) console.log("BIZ", m(JSON.stringify(b)));
for (const x of await sql`select direction, kind, channel, provider_email_id, sender_trusted, trust_reason, matched_via, parse_status, left(body_text, 400) as body, created_at from messages where job_id = ${job} order by created_at`) console.log("MSG", m(JSON.stringify(x)));
for (const q of await sql`select id, business_id, total_cents, status, compliant, sender_trusted, round, source, created_at from quotes where job_id = ${job} order by created_at`) console.log("QUOTE", JSON.stringify(q));
for (const e of await sql`select seq, type, left(data::text, 220) as data from job_events where job_id = ${job} order by seq`) console.log("EVT", m(JSON.stringify(e)));
await sql.end();
