// Discovery wording shared by deal(discover) and discover.

/** How many businesses deal(discover: true) asks for. */
export const DISCOVER_COUNT = 6;

/**
 * Why discovery returned fewer businesses than asked, or null when it didn't. Live mode only offers
 * what the operator configured, so an agent asking for the six-seller demo there gets fewer: say so.
 */
export function fewerFound(mode: "mock" | "live", found: number, asked: number): string | null {
  if (found >= asked) return null;
  return `Only ${found} of the ${asked} requested businesses are available${mode === "live" ? " (live mode offers only HAGGLE_DEMO_FLEET and HAGGLE_ALLOWED_RECIPIENTS; the six-seller demo fleet runs in mock mode)" : ""}.`;
}
