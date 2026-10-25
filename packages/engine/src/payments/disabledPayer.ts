import type { PayerPort } from "../workflow/ports.ts";

/**
 * The live payer when no on-email payment rail is configured: refuses every signature, so a payment
 * is recorded as SIGNING_REFUSED and never faked. Stripe test mode and the manual handoff are
 * separate paths and do not use it.
 */
export function disabledPayer(reason: string): PayerPort {
  return { client: { payEmailChallenge: async () => { throw new Error(reason); } }, signer: null, simulated: false, disabledReason: reason };
}
