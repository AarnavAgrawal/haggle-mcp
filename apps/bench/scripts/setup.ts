/**
 * Create the baseline's own Inkbox identity (idempotent), so the baseline arm has a mailbox that
 * Haggle's buyer never touches. The baseline has no phone number (plan limit); its place_call tool
 * returns Inkbox's error, which is itself part of what the benchmark measures.
 *
 *   npm run setup -w @haggle/bench
 */
import { Inkbox } from "@inkbox/sdk";

const handle = process.env.BASELINE_HANDLE ?? "haggle-baseline";
const inkbox = new Inkbox();

try {
  const id = await inkbox.getIdentity(handle);
  console.log(`${handle} exists: ${id.emailAddress}`);
} catch {
  const id = await inkbox.createIdentity(handle, { displayName: "Events team (baseline)" });
  console.log(`created ${handle}: ${id.emailAddress}`);
}
