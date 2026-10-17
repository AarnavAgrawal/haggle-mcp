/**
 * Primitive round-trip spike (Friday head-start item): send from a per-job address, wait for
 * the reply, and print what Primitive tells us about the sender. Read-only beyond one email.
 *
 * Sends exactly ONE email, and only to a recipient you explicitly confirm you control:
 *   PRIMITIVE_API_KEY=… HAGGLE_INBOX_DOMAIN=<you>.primitive.email \
 *   SPIKE_TO=<your own address> SPIKE_CONFIRM_RECIPIENT_IS_MINE=yes \
 *   corepack pnpm --filter @haggle/spikes primitive-roundtrip
 * Then reply to the email from SPIKE_TO within ~2.5 minutes.
 */
import primitive from "@primitivedotdev/sdk";
import { randomBytes } from "node:crypto";

const API = "https://api.primitive.dev/v1";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name}. See the header of this file for usage.`);
    process.exit(2);
  }
  return v;
}

const apiKey = required("PRIMITIVE_API_KEY");
const domain = required("HAGGLE_INBOX_DOMAIN");
const to = required("SPIKE_TO");
if (process.env.SPIKE_CONFIRM_RECIPIENT_IS_MINE !== "yes") {
  console.error("Refusing to send: set SPIKE_CONFIRM_RECIPIENT_IS_MINE=yes to confirm SPIKE_TO is your own test inbox.");
  process.exit(2);
}

const jobTag = randomBytes(4).toString("hex");
const from = `job-spike${jobTag}@${domain}`;
const client = primitive.client({ apiKey });

// Reply-only accounts can't email new recipients; surface that before sending.
const perms = await fetch(`${API}/send-permissions`, { headers: { authorization: `Bearer ${apiKey}` } });
console.log("send-permissions:", perms.status, JSON.stringify(await perms.json().catch(() => null)));

const sent = await client.send(
  {
    from,
    to,
    subject: `Haggle spike ${jobTag}: please reply to this test`,
    bodyText: `This is a Haggle integration test from ${from}. Reply with any text to complete the round trip.`,
  },
  { idempotencyKey: `spike-${jobTag}` },
);
console.log("sent:", { id: sent.id, status: sent.status, accepted: sent.accepted, rejected: sent.rejected });

// Wait for the reply via the documented long-poll endpoint (≤30 s per request).
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  const res = await fetch(`${API}/sent-emails/${encodeURIComponent(sent.id)}/reply?wait=true&wait_timeout_ms=30000`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const body = (await res.json()) as { data?: { reply: Record<string, unknown> | null; timed_out?: boolean } };
  const reply = body.data?.reply;
  if (reply) {
    const { from_email, to_email, subject, thread_id, sender_verified, sender_matches_recipient, auth } = reply;
    console.log("reply received:", { from_email, to_email, subject, thread_id, sender_verified, sender_matches_recipient, auth });
    process.exit(0);
  }
  console.log(`no reply yet (HTTP ${res.status}); waiting…`);
}
console.error("No reply within 150 s. The send itself is recorded above.");
process.exit(1);
