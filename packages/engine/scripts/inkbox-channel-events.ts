// Add the v5 channel events to the buyer identity's Inkbox webhook subscription(s) that point at
// /webhooks/inkbox: call.ended, imessage.received, a2a.sent_task.updated (message.received stays).
// Run only AFTER the server handling them is deployed. Dry run by default; --confirm to apply.
//
//   node packages/engine/scripts/inkbox-channel-events.ts <path to .env> [--confirm]
//
// Prints subscription hosts and event types only (no secrets).
import { readFileSync } from "node:fs";
import { Inkbox } from "@inkbox/sdk";

const [envPath, flag] = process.argv.slice(2);
if (!envPath) throw new Error("usage: inkbox-channel-events.ts <path to .env> [--confirm]");
const env: Record<string, string> = {};
for (const l of readFileSync(envPath, "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]!] = m[2]!.trim(); }
const WANT = ["message.received", "call.ended", "imessage.received", "a2a.sent_task.updated"];
const inkbox = new Inkbox({ apiKey: env.INKBOX_API_KEY! });
const id = await inkbox.getIdentity(env.INKBOX_IDENTITY || "haggle");
const subs = (await inkbox.webhooks.subscriptions.list({ agentIdentityId: id.id, scope: "identity" })).filter((s) => /\/webhooks\/inkbox$/.test(s.url));
if (!subs.length) { console.log("No subscription to /webhooks/inkbox yet; nothing to do."); process.exit(0); }
for (const s of subs) {
  const missing = WANT.filter((e) => !s.eventTypes.includes(e));
  const host = new URL(s.url).host;
  if (!missing.length) { console.log(`${host}: already has ${WANT.join(", ")}`); continue; }
  if (flag !== "--confirm") { console.log(`${host}: would add ${missing.join(", ")} (dry run; re-run with --confirm)`); continue; }
  const u = await inkbox.webhooks.subscriptions.update(s.id, { scope: "identity", eventTypes: [...new Set([...s.eventTypes, ...WANT])] });
  console.log(`${host}: now [${u.eventTypes.join(", ")}]`);
}
