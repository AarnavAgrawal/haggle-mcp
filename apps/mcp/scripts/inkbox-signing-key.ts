// Creates (or rotates) the buyer identity's Inkbox webhook signing key and writes it into an env file
// as INKBOX_WEBHOOK_SECRET. The key is shown by Inkbox only once and is never printed here.
// Rotating invalidates the old key: update every server that verifies this identity's webhooks.
// Usage (repo root): node --env-file=apps/mcp/.env apps/mcp/scripts/inkbox-signing-key.ts [env file]
import { readFileSync, writeFileSync } from "node:fs";
import { Inkbox } from "@inkbox/sdk";

const file = process.argv[2] ?? "apps/mcp/.env";
const apiKey = process.env.INKBOX_API_KEY?.trim();
const handle = process.env.INKBOX_IDENTITY?.trim();
if (!apiKey || !handle) {
  console.error("INKBOX_API_KEY and INKBOX_IDENTITY must be set (pass --env-file=apps/mcp/.env)");
  process.exit(2);
}

const identity = await new Inkbox({ apiKey }).getIdentity(handle);
const { signingKey, createdAt } = await identity.createSigningKey();
const text = readFileSync(file, "utf8");
const line = `INKBOX_WEBHOOK_SECRET=${signingKey}`;
writeFileSync(file, /^\s*INKBOX_WEBHOOK_SECRET=.*$/m.test(text) ? text.replace(/^\s*INKBOX_WEBHOOK_SECRET=.*$/m, line) : `${text.trimEnd()}\n${line}\n`);
console.log(`INKBOX_WEBHOOK_SECRET written to ${file} for identity "${handle}" (created ${createdAt.toISOString()}; value not shown)`);
