// PURE: deterministic checks on free text the AGENT asks Haggle to send to a business
// (answer_business, send_message). The engine's own templates are honest by construction; this
// guard holds agent-written text to the same rules.
//
// Ported from haggle-testing src/core/negotiate/messageGuard.ts. It blocks:
//   1. a dollar amount that isn't from this request or a stored quote (no invented competing offers);
//   2. the name of another business on the job (competitors are never named);
//   3. text over the channel's limit;
//   4. commitment phrases: committing the buyer needs a human approval (approve), never free text.

import { findDollarAmounts } from "../parsing/callSafety.ts";

// The dollar reader lives in parsing/callSafety.ts (decision 24); re-exported for existing importers.
export { findDollarAmounts };

export type GuardCode = "UNVERIFIED_AMOUNT" | "MENTIONS_OTHER_BUSINESS" | "MESSAGE_TOO_LONG" | "COMMITMENT_NEEDS_APPROVAL";

export interface GuardInput {
  /** The agent's own words only; amounts, names and commitments are checked here. */
  text: string;
  /** Characters the channel allows for the whole message. */
  limit: number;
  /** Amounts (cents) the agent may cite: stored quote figures and request details. */
  verifiedCents: Iterable<number>;
  /** Names of the OTHER businesses on this job (not the recipient). */
  otherBusinessNames: string[];
}

export type GuardResult = { ok: true } | { ok: false; code: GuardCode; message: string };

const COMMITMENT_PHRASES = ["we accept", "we'll take it", "we will take it", "book it", "confirmed", "go ahead", "it's a deal"];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const usd = (cents: number) => `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;

export function checkMessage(input: GuardInput): GuardResult {
  const allowed = new Set(input.verifiedCents);
  for (const cents of findDollarAmounts(input.text)) {
    if (!allowed.has(cents)) return { ok: false, code: "UNVERIFIED_AMOUNT", message: `${usd(cents)} isn't an amount from this request or any quote Haggle received.` };
  }
  for (const name of input.otherBusinessNames) {
    const n = name.trim();
    if (n.length < 2) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(n)}($|[^\\p{L}\\p{N}])`, "iu");
    if (re.test(input.text)) return { ok: false, code: "MENTIONS_OTHER_BUSINESS", message: `The message names another business on this deal (${n}).` };
  }
  if (input.text.length > input.limit) return { ok: false, code: "MESSAGE_TOO_LONG", message: `The message is ${input.text.length} characters; this channel allows ${input.limit}.` };
  const lower = input.text.toLowerCase();
  const phrase = COMMITMENT_PHRASES.find((p) => lower.includes(p));
  if (phrase) return { ok: false, code: "COMMITMENT_NEEDS_APPROVAL", message: `"${phrase}" commits the buyer. Commitments only go out after the human approves (approve).` };
  return { ok: true };
}
