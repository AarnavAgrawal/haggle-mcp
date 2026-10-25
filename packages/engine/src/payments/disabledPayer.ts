import type { PayerPort } from "../workflow/ports.ts";

/**
 * The payer for a server with no Stripe rail: every charge is refused with `reason` and never
 * faked. Stripe test mode and the manual handoff are separate paths and do not use it.
 */
export function disabledPayer(reason: string): PayerPort {
  return { simulated: false, disabledReason: reason };
}
