/**
 * One-time setup of the seller fleet on Inkbox (idempotent; safe to re-run).
 *
 *   INKBOX_API_KEY=... SELLERS_PUBLIC_URL=https://<host> npm run setup -w @haggle/sellers
 *
 * - Creates the 6 seller identities (mailbox each).
 * - Mission Eats: provisions a phone number and makes Voice AI answer in character.
 * - Bay Catering: enables A2A with a catering-quote skill.
 * - Subscribes each email/A2A seller's events to SELLERS_PUBLIC_URL/webhooks/inkbox/<handle>
 *   (default: the Inkbox tunnel https://<SELLERS_TUNNEL>.inkboxwire.com).
 * - Writes .haggle-data/sellers-identities.json (signing keys; gitignored) and
 *   .haggle-data/directory.json (real addresses for the brain: set HAGGLE_DIRECTORY_FILE to it).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IncomingCallAction, Inkbox, type AgentIdentity } from "@inkbox/sdk";
import { phoneInstructions } from "../src/phone.ts";
import { PERSONAS, type Persona } from "../src/personas.ts";
import { DATA_DIR, loadRegistry, saveRegistry, type IdentityRecord } from "../src/store.ts";

const inkbox = new Inkbox();
const tunnel = process.env.SELLERS_TUNNEL ?? "bay-catering-sf";
const publicUrl = (process.env.SELLERS_PUBLIC_URL ?? `https://${tunnel}.inkboxwire.com`).replace(/\/$/, "");
const voice = process.env.MISSION_EATS_VOICE ?? "ara";

async function ensureIdentity(p: Persona): Promise<AgentIdentity> {
  try {
    return await inkbox.getIdentity(p.handle);
  } catch {
    console.log(`  creating identity ${p.handle}`);
    return inkbox.createIdentity(p.handle, { displayName: p.name, emailLocalPart: p.handle });
  }
}

async function main() {
  const registry = loadRegistry();
  const directory: Record<string, unknown>[] = [];

  for (const p of PERSONAS) {
    console.log(`${p.name} (${p.handle})`);
    const id = await ensureIdentity(p);
    const rec: IdentityRecord = { ...registry[p.handle], identityId: id.id };
    if (id.emailAddress) rec.email = id.emailAddress;

    if (p.channel === "phone") {
      const number = id.phoneNumber ?? (await id.provisionPhoneNumber());
      rec.phone = number.number;
      await id.setIncomingCallAction({ incomingCallAction: IncomingCallAction.HOSTED_AGENT });
      await id.setHostedAgentConfig({ voice, instructions: phoneInstructions(p) });
      console.log(`  Voice AI answers ${rec.phone} as ${p.name}`);
    }

    if (p.channel === "a2a") {
      await id.a2aEnable();
      const settings = await id.a2aSetSkills([
        {
          id: "catering_quote",
          name: "Catering quote",
          description: "Instant catering quote for a group in San Francisco: send headcount, vegetarian count and date; get a structured quote back.",
          tags: ["catering", "quote", "san-francisco"],
          examples: ["Lunch for 40 on 2026-10-22, 12 vegetarian, delivered by 11:45"],
          inputModes: ["text", "data"],
          outputModes: ["text", "data"],
        },
      ]);
      rec.cardUrl = settings.cardUrl;
      console.log(`  A2A card ${rec.cardUrl}`);
    }

    if (p.channel !== "phone") {
      const events = p.channel === "a2a" ? ["message.received", "a2a.task.created", "a2a.task.message"] : ["message.received"];
      const url = `${publicUrl}/webhooks/inkbox/${p.handle}`;
      const sub = await inkbox.webhooks.subscriptions.create({ agentIdentityId: id.id, url, eventTypes: events });
      if (sub.signingKey) rec.signingKey = sub.signingKey;
      console.log(`  webhooks → ${url}`);
    }
    if (!rec.signingKey && p.channel !== "phone") {
      rec.signingKey = (await id.createSigningKey()).signingKey;
    }

    registry[p.handle] = rec;
    directory.push({
      id: p.business_id,
      ...(p.channel !== "phone" && rec.email ? { email: rec.email } : {}),
      ...(rec.phone ? { phone: rec.phone } : {}),
      ...(rec.cardUrl ? { a2a_card_url: rec.cardUrl } : {}),
    });
  }

  saveRegistry(registry);
  mkdirSync(DATA_DIR, { recursive: true });
  const directoryPath = join(DATA_DIR, "directory.json");
  writeFileSync(directoryPath, JSON.stringify(directory, null, 2));
  console.log(`\nSaved ${join(DATA_DIR, "sellers-identities.json")} and ${directoryPath}`);
  console.log(`Point the brain at the real addresses: HAGGLE_DIRECTORY_FILE=${directoryPath}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
