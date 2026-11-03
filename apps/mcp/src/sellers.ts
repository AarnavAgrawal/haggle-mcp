// Haggle's own demo sellers, answered by this server (HAGGLE_SELLERS_JSON): the seller personas
// (@haggle/sellers) reply from their Inkbox mailboxes to a demo workspace's requests (src/demoWorkspace.ts),
// so a demo login works around the clock with no separate seller server. Inkbox posts each seller's
// mail to POST /webhooks/sellers/<handle>, verified with that seller identity's own signing key.
// Needs INKBOX_ADMIN_API_KEY (an org-level key that can act as each seller). Off when either is unset.
import { createHostedSellers, parseSellerRegistry } from "@haggle/sellers/hosted";

export type HostedSellers = ReturnType<typeof createHostedSellers>;

/** Largest seller webhook accepted (an email event is a few KB; the body is fetched from Inkbox). */
export const SELLER_WEBHOOK_MAX_BYTES = 256 * 1024;

export function hostedSellersFromEnv(env: Record<string, string | undefined>, warn: (msg: string) => void = console.warn): HostedSellers | null {
  const json = env.HAGGLE_SELLERS_JSON?.trim();
  const key = env.INKBOX_ADMIN_API_KEY?.trim();
  if (!json) return null;
  if (!key) {
    warn("HAGGLE_SELLERS_JSON is set but INKBOX_ADMIN_API_KEY isn't: the demo sellers are off");
    return null;
  }
  let registry;
  try {
    registry = parseSellerRegistry(json);
  } catch {
    warn("HAGGLE_SELLERS_JSON isn't valid JSON: the demo sellers are off");
    return null;
  }
  if (!Object.keys(registry).length) {
    warn("HAGGLE_SELLERS_JSON lists no seller with a signing key: the demo sellers are off");
    return null;
  }
  return createHostedSellers({ inkboxApiKey: key, registry, ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}), fast: true });
}
