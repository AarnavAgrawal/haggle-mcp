// Environment loading and validation (DESIGN.md §17).
//
// Keys are never hard-coded and never logged. Missing keys do not crash the
// process at import time, so the dev server, Inspector, and a deploy without
// secrets still boot; instead, the first code path that needs a key calls
// getConfig(), which throws ConfigError naming the missing variables.
// One rule IS enforced at startup: a live-mode Stripe key refuses to boot (§16).
import { z } from "zod";

const intFromEnv = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const ConfigSchema = z.object({
  PUBLIC_BASE_URL: z.string().url(),
  MCP_AUTH_TOKEN: z.string().min(16).optional(),
  INTERNAL_TICK_SECRET: z.string().min(16).optional(),
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  PRIMITIVE_API_KEY: z.string().startsWith("prim_"),
  PRIMITIVE_FROM_ADDRESS: z.string().email(),
  PRIMITIVE_WEBHOOK_SECRET: z.string().min(1),
  PRIMITIVE_ENDPOINT_ID: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().min(1),
  PARSER_MODEL: z.string().default("claude-haiku-5-5"),
  WRITER_MODEL: z.string().default("claude-sonnet-5-5"),

  // Stripe is used from M4 on; optional until then.
  STRIPE_SECRET_KEY: z.string().startsWith("sk_test_").optional(),
  STRIPE_CUSTOMER_ID: z.string().optional(),
  STRIPE_PAYMENT_METHOD_ID: z.string().optional(),
  SPEND_CAP_CENTS: intFromEnv(50000),

  BUYER_EMAIL: z.string().email().optional(),

  // Public mode. "token": one operator with a shared MCP_AUTH_TOKEN (default).
  // "oauth": anyone signs in with Supabase; jobs, approvals, and Stripe test
  // customers are per user.
  AUTH_MODE: z.enum(["token", "oauth"]).default("token"),
  // Supabase publishable (anon) key: used only by the sign-in page in the browser.
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  LOGIN_METHODS: z.string().default("github,email"),
  // "Name <email>; Name <email>". When set, vendors must come from this list
  // (always required in oauth mode: public users may only contact simulators).
  DEMO_VENDORS: z.string().optional(),
  JOBS_PER_USER_PER_DAY: intFromEnv(10),
  SIM_ON_SERVER: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  COLLECTION_WINDOW_SECONDS: intFromEnv(1800),
  NEGOTIATION_WINDOW_SECONDS: intFromEnv(900),
  APPROVAL_TTL_SECONDS: intFromEnv(86400),
  MAX_ROUNDS_DEFAULT: z.coerce.number().int().min(0).max(2).default(1),
});

export type Config = z.infer<typeof ConfigSchema> & {
  collectionWindowSeconds: number;
  negotiationWindowSeconds: number;
  approvalTtlSeconds: number;
};

// Plain field instead of a parameter property, so `node` can run scripts that
// import this file directly (Node's type stripping rejects parameter properties).
export class ConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Server is missing configuration: ${missing.join(", ")}`);
    this.missing = missing;
  }
}

// Demo timers from §7.5.
const DEMO_TIMERS = { collection: 60, negotiation: 45, approval: 600 };

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    // Report variable names only, never values.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new ConfigError(names);
  }
  const env = parsed.data;
  cached = {
    ...env,
    collectionWindowSeconds: env.DEMO_MODE ? DEMO_TIMERS.collection : env.COLLECTION_WINDOW_SECONDS,
    negotiationWindowSeconds: env.DEMO_MODE ? DEMO_TIMERS.negotiation : env.NEGOTIATION_WINDOW_SECONDS,
    approvalTtlSeconds: env.DEMO_MODE ? DEMO_TIMERS.approval : env.APPROVAL_TTL_SECONDS,
  };
  return cached;
}

/** Startup check: refuse to run with a live Stripe key (§16). */
export function assertSafeStartup(): void {
  const key = process.env.STRIPE_SECRET_KEY;
  if (key && !key.startsWith("sk_test_")) {
    throw new Error("Refusing to start: STRIPE_SECRET_KEY must be a test-mode key (sk_test_...).");
  }
}
