// x402 over email, payer side. Parse the seller's challenge, run the guard, and only then build
// the signed `interaction.json` payment step. Building the step does NOT send or settle anything:
// the caller sends it in-thread with `sendEmail` (key `sendKeys.payment(stepId)`), and only a
// verified receipt marks the payment settled.
//
// New in Haggle v3 (quote-broker paid with Stripe). Uses the SDK's own parser and signer; no
// signing format is invented here.
import { parseEmailChallengeFromPart, type X402EmailChallenge } from "@primitivedotdev/sdk/x402";
import { checkX402PaymentAllowed, type X402GuardInput, type X402GuardResult } from "./guard.ts";

export interface ParsedChallenge {
  challenge: X402EmailChallenge;
  interactionId: string;
  stepId: string;
  network: string;
  asset: string;
  amountBaseUnits: string;
  payTo: string;
  expiresAt: string;
}

export type ChallengeParse = { ok: true; parsed: ParsedChallenge } | { ok: false; reason: string };

/** Parse an inbound `interaction.json` part. Malformed or non-challenge parts are rejected. */
export function parseChallengePart(part: string | Uint8Array): ChallengeParse {
  try {
    const challenge = parseEmailChallengeFromPart(part);
    const req = challenge.challenge.payment_requirements;
    return {
      ok: true,
      parsed: {
        challenge,
        interactionId: challenge.interaction_id,
        stepId: challenge.challenge.nonce_binding.challenge_step_id,
        network: req.network,
        asset: req.asset,
        amountBaseUnits: req.maxAmountRequired,
        payTo: req.payTo,
        expiresAt: challenge.challenge.expires_at,
      },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "unparseable challenge" };
  }
}

/** The slice of the x402 client this module uses; tests pass a fake. */
export interface PayerClient {
  payEmailChallenge(challenge: X402EmailChallenge, options: { signer: unknown }): Promise<{ json: string | Uint8Array }>;
}

export type PreparedPayment =
  | { ok: true; amountBaseUnits: string; stepId: string; interactionJson: Uint8Array }
  | { ok: false; guard: Extract<X402GuardResult, { ok: false }> };

/**
 * Guard first, sign second. The guard's input comes from the database (approval, quote,
 * existing payment) plus what ingestion verified about the challenge email.
 */
export async function preparePayment(
  payer: PayerClient,
  signer: unknown,
  parsed: ParsedChallenge,
  guardInput: Omit<X402GuardInput, "challenge"> & {
    challengeEmail: { business_id: string; sender_trusted: boolean; thread_matched: boolean };
  },
): Promise<PreparedPayment> {
  const { challengeEmail, ...rest } = guardInput;
  const verdict = checkX402PaymentAllowed({
    ...rest,
    challenge: {
      ...challengeEmail,
      network: parsed.network,
      asset: parsed.asset,
      amount_base_units: parsed.amountBaseUnits,
      pay_to: parsed.payTo,
      expires_at: parsed.expiresAt,
    },
  });
  if (!verdict.ok) return { ok: false, guard: verdict };
  if (verdict.existingPayment) return { ok: false, guard: { ok: false, code: "PAYMENT_IN_FLIGHT", existingPayment: verdict.existingPayment } };
  let built;
  try {
    built = await payer.payEmailChallenge(parsed.challenge, { signer });
  } catch (e) {
    // The SDK re-checks the challenge (e.g. expiry against the real clock) and refuses to sign.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, guard: { ok: false, code: /expired/i.test(msg) ? "CHALLENGE_EXPIRED" : "SIGNING_REFUSED" } };
  }
  const interactionJson = typeof built.json === "string" ? new TextEncoder().encode(built.json) : built.json;
  return { ok: true, amountBaseUnits: verdict.amountBaseUnits, stepId: parsed.stepId, interactionJson };
}
