// Point the buyer identity's Inkbox webhook at a new deploy URL (ported from haggle-testing
// scripts/updateWebhook.ts): the subscription(s) ending in /webhooks/inkbox are updated to
// <base-url>/webhooks/inkbox with every v5 event type; if there is none, one is created. Run after
// the new server is up. Dry run by default; --confirm to apply.
//
//   node packages/engine/scripts/inkbox-webhook-move.ts <path to .env> <https://new-base-url> [--confirm]
//
// Prints hosts and event types only. If Inkbox mints a new signing key (first subscription of the
// identity) it is printed once: set it as INKBOX_WEBHOOK_SECRET on the server.
import { readFileSync } from "node:fs";
import { Inkbox } from "@inkbox/sdk";

const [envPath, base, flag] = process.argv.slice(2);
if (!envPath || !base) throw new Error("usage: inkbox-webhook-move.ts <path to .env> <https://new-base-url> [--confirm]");
if (!/^https:\/\//.test(base)) throw new Error("the new base URL must be https");
const env: Record<string, string> = {};
for (const l of readFileSync(envPath, "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]!] = m[2]!.trim(); }
const WANT = ["message.received", "call.ended", "imessage.received", "a2a.sent_task.updated"];
const target = `${base.replace(/\/+$/, "")}/webhooks/inkbox`;
const inkbox = new Inkbox({ apiKey: env.INKBOX_API_KEY! });
const id = await inkbox.getIdentity(env.INKBOX_IDENTITY || "haggle");
const subs = (await inkbox.webhooks.subscriptions.list({ agentIdentityId: id.id, scope: "identity" })).filter((s) => /\/webhooks\/inkbox$/.test(s.url));
const dry = flag !== "--confirm";
if (subs.length === 0) {
  if (dry) {
    console.log(`No subscription to /webhooks/inkbox yet: would create ${new URL(target).host} [${WANT.join(", ")}] (dry run; re-run with --confirm)`);
  } else {
    const created = await inkbox.webhooks.subscriptions.create({ agentIdentityId: id.id, url: target, eventTypes: WANT });
    console.log(`Created ${new URL(created.url).host} [${created.eventTypes.join(", ")}]`);
    if (created.signingKey) console.log(`New signing key (shown once; set it as INKBOX_WEBHOOK_SECRET): ${created.signingKey}`);
  }
} else {
  for (const s of subs) {
    const from = new URL(s.url).host;
    const events = [...new Set([...s.eventTypes, ...WANT])];
    if (s.url === target && events.length === s.eventTypes.length) { console.log(`${from}: already at ${target}`); continue; }
    if (dry) { console.log(`${from} -> ${new URL(target).host} [${events.join(", ")}] (dry run; re-run with --confirm)`); continue; }
    const u = await inkbox.webhooks.subscriptions.update(s.id, { scope: "identity", url: target, eventTypes: events });
    console.log(`${from} -> ${new URL(u.url).host} [${u.eventTypes.join(", ")}]`);
  }
}
