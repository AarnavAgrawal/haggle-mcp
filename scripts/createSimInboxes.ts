// Create one Primitive agent account (managed inbox) per simulated restaurant
// (DESIGN.md §15). Zero-touch signup: each account starts reply-only, which is
// all a simulator needs. API keys go into .env (never printed); the inbox
// addresses go to sim/.addresses.json for create_quote_request and the eval.
//
// Run once: npm run setup:sim
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createAgent } from "@primitivedotdev/sdk";
import { setEnvVars } from "./envFile.ts";
import { PERSONAS as personas } from "../sim/personas.ts";

const ADDRESSES = new URL("../sim/.addresses.json", import.meta.url);
const addresses: Record<string, string> = existsSync(ADDRESSES) ? JSON.parse(readFileSync(ADDRESSES, "utf8")) : {};

// Primitive returns the managed inbox as a domain (e.g. "pink-crab.primitive.email"),
// not a mailbox. Mail to any local part at that domain lands in the inbox, so give
// each restaurant a readable address. TODO(verify): any local part is accepted
// (the docs describe the inbox as a receiving FQDN).
const toAddress = (inbox: string) => (inbox.includes("@") ? inbox : `catering@${inbox}`);
for (const id of Object.keys(addresses)) addresses[id] = toAddress(addresses[id]!); // repair older runs

for (const p of personas) {
  if (process.env[p.apiKeyEnv]) {
    console.log(`${p.name}: already has ${p.apiKeyEnv}; skipping.`);
    continue;
  }
  const agent = await createAgent({ terms_accepted: true, device_name: `quote-broker-sim-${p.id}` });
  if (!agent.address) {
    console.error(`${p.name}: account created but no inbox address was returned. Check the Primitive dashboard.`);
  }
  setEnvVars({ [p.apiKeyEnv]: agent.account.api_key });
  if (agent.address) addresses[p.id] = toAddress(agent.address);
  console.log(`${p.name}: inbox ${addresses[p.id] ?? "(none)"}; key saved to .env as ${p.apiKeyEnv}.`);
}

writeFileSync(ADDRESSES, JSON.stringify(addresses, null, 2) + "\n");
console.log("\nVendor list for create_quote_request:");
console.log(JSON.stringify(personas.filter((p) => addresses[p.id]).map((p) => ({ name: p.name, email: addresses[p.id] })), null, 2));
