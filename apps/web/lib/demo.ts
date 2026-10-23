// Demo deployment switches (NEXT_PUBLIC_HAGGLE_DEMO=true, inlined at build time). A demo site runs
// against a mock-mode MCP server: simulated businesses, no real calls, texts or payments.
import type { User } from "@supabase/supabase-js";

export const DEMO = process.env.NEXT_PUBLIC_HAGGLE_DEMO === "true";

/** Requests the simulated caterers answer well (demo); real requests of any kind otherwise. */
export const DEMO_EXAMPLES = [
  "Cater lunch for 40 people next Thursday in San Francisco, at least 12 vegetarian, under $1,200",
  "Breakfast for a 120-person hackathon this Saturday at 8am in SoMa, delivery included",
  "Team dinner for 25 next Friday in the Mission, budget $1,000",
];
export const LIVE_EXAMPLES = [
  "Cater lunch for 60 next Friday in SoMa, 12 vegetarian, under $2,500",
  "Breakfast for a 200-person hackathon on Saturday at 8am",
  "Get quotes to fix a leaking kitchen sink this week",
];
export const chatExamples = (demo = DEMO) => (demo ? DEMO_EXAMPLES : LIVE_EXAMPLES);

/**
 * Skip the onboarding form: a guest (anonymous sign-in) always, and everyone on a demo site, where
 * there is no approver phone to collect (approvals are one click; nothing real is paid).
 */
export const autoOnboard = (user: Pick<User, "is_anonymous">, demo = DEMO) => demo || user.is_anonymous === true;
