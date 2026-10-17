/**
 * Read-only view of the Inkbox org: identities, phone numbers and the seller webhook subscriptions.
 * Changes nothing; never prints keys.
 *
 *   npm run status -w @haggle/sellers
 */
import { Inkbox } from "@inkbox/sdk";
import { PERSONAS } from "../src/personas.ts";

const inkbox = new Inkbox();

async function main() {
  console.log("Identities:");
  for (const i of await inkbox.listIdentities()) {
    const s = i as unknown as Record<string, unknown>;
    console.log(`  ${s.agentHandle ?? s.agent_handle} ${s.emailAddress ? `<${String(s.emailAddress)}>` : ""} id=${String(s.id)}`);
  }

  console.log("\nPhone numbers:");
  const numbers = await inkbox.phoneNumbers.list();
  if (!numbers.length) console.log("  (none)");
  for (const n of numbers) {
    const s = n as unknown as Record<string, unknown>;
    const owner = s.agentIdentityId ?? s.agent_identity_id ?? s.agentHandle ?? s.agent_handle ?? "unassigned";
    console.log(`  ${n.number} status=${n.status} owner=${String(owner)}`);
  }

  console.log("\nSeller webhook subscriptions:");
  for (const p of PERSONAS) {
    let id: string;
    try {
      id = (await inkbox.getIdentity(p.handle)).id;
    } catch {
      console.log(`  ${p.handle}: identity not created yet`);
      continue;
    }
    const subs = await inkbox.webhooks.subscriptions.list({ agentIdentityId: id, scope: "identity" });
    const mine = subs.filter((s) => s.url.includes(`/webhooks/inkbox/${p.handle}`));
    console.log(`  ${p.handle}: ${mine.length} subscription(s)${mine.length ? ` → ${mine.map((s) => `${s.url} [${s.eventTypes.join(", ")}]`).join("; ")}` : ""}`);
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
