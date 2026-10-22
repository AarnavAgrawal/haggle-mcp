// Every environment variable the server, the brain it hosts, the operator scripts and the test/eval
// harnesses read, with its purpose, whether it is a secret, what each target needs and how it is
// validated. config.ts derives its lists (live-required, mock-only, production-refused, database
// URLs) and its format checks from this table; docs/env-manifest.md is the readable version, and
// apps/mcp/tests/envManifest.test.ts fails when code reads a variable that isn't listed here.
//
// Targets: mock = HAGGLE_MODE=mock in any HAGGLE_ENV (development, CI, demos); dev = development
// live (dev accounts); staging = HAGGLE_ENV=staging (live); production = HAGGLE_ENV=production
// (live only). Values are never printed: messages name the variable only.

export type Need =
  | "required"     // missing = configuration refused
  | "recommended"  // launch-gate warns when missing
  | "optional"
  | "refused"      // set at all = refused (production: mock/rehearsal flags)
  | "refused_true" // "true" = refused (production: demo shortcuts)
  | "unused";      // not read in that target
export type Target = "mock" | "dev" | "staging" | "production";
export type ReadBy = "server" | "brain" | "script" | "test" | "eval" | "sellers" | "platform";

export type Rule =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "bool" }
  | { kind: "posInt"; allowZero?: boolean }
  | { kind: "intRange"; min: number; max: number }
  | { kind: "posNumber" }
  | { kind: "httpsUrl" }
  | { kind: "url" }
  | { kind: "postgresUrl" }
  | { kind: "minLength"; min: number }
  | { kind: "pattern"; re: RegExp; describe: string }
  | { kind: "json" }
  | { kind: "timezone" }
  | { kind: "text" };

export interface EnvVarSpec {
  name: string;
  purpose: string;
  /** A credential or signing key: never logged, echoed or committed. */
  secret: boolean;
  /** Personal data (phone numbers, addresses): treated like a secret in output. */
  pii?: boolean;
  readBy: readonly ReadBy[];
  need: Record<Target, Need>;
  rule: Rule;
  /** A rule violation is an error (refuses to start) or a warning (the code falls back safely). */
  invalid: "error" | "warn";
  /** Checked by hand-written logic in config.ts (conditional on another variable); the generic loop skips it. */
  conditional?: true;
  /** Overrides the generic rule message. */
  message?: string;
  /** A connection string checked by the production-database guard. */
  dbUrl?: true;
  /**
   * Read by code on another sprint branch, not yet on this one (named here ahead of integration).
   * envManifest.test.ts fails once code reads it, so the flag is removed at integration.
   */
  pendingIntegration?: string;
  default?: string;
}

const N = (mock: Need, dev: Need, staging: Need, production: Need): Record<Target, Need> => ({ mock, dev, staging, production });
const LIVE_REQ = N("unused", "required", "required", "required");
const OPT = N("optional", "optional", "optional", "optional");
const LIVE_OPT = N("unused", "optional", "optional", "optional");
const MOCK_ONLY = N("optional", "optional", "optional", "refused");
const BOOL = { kind: "bool" } as const;
const TEXT = { kind: "text" } as const;

// Order matters only for the generic format checks' message order (config.ts / its tests).
export const ENV_MANIFEST: readonly EnvVarSpec[] = [
  // --- deployment identity -------------------------------------------------------------------
  { name: "HAGGLE_ENV", purpose: "Where the server runs: development (default), staging or production", secret: false, readBy: ["server", "script"], need: N("optional", "recommended", "required", "required"), rule: { kind: "enum", values: ["development", "staging", "production"] }, invalid: "error", conditional: true, default: "development" },
  { name: "HAGGLE_MODE", purpose: "mock (simulated, DEMO-labelled) or live (real providers)", secret: false, readBy: ["server"], need: N("optional", "required", "required", "required"), rule: { kind: "enum", values: ["mock", "live"] }, invalid: "error", conditional: true, default: "mock" },
  { name: "HAGGLE_BUILD_SHA", purpose: "Build label shown by /health and /ready (set per deploy)", secret: false, readBy: ["server"], need: N("optional", "optional", "recommended", "recommended"), rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_LOG_LEVEL", purpose: "Lowest log level written", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "enum", values: ["debug", "info", "warn", "error"] }, invalid: "warn", default: "info" },
  { name: "PORT", purpose: "HTTP port (read by mcp-use; the hosting platform sets it)", secret: false, readBy: ["platform"], need: OPT, rule: { kind: "intRange", min: 1, max: 65535 }, invalid: "warn", default: "3000" },

  // --- production-database guard -------------------------------------------------------------
  { name: "HAGGLE_PROD_DB_HOSTS", purpose: "Production database hosts / Supabase project refs (comma-separated) so development and staging refuse them", secret: false, readBy: ["server", "script"], need: N("optional", "recommended", "recommended", "recommended"), rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_ALLOW_PROD_DB", purpose: "true for one deliberate operator command against production from outside production", secret: false, readBy: ["server", "script"], need: N("unused", "optional", "optional", "unused"), rule: BOOL, invalid: "warn" },

  // --- required providers ----------------------------------------------------------------------
  { name: "INKBOX_API_KEY", purpose: "Inkbox API key (buyer identity: email, calls, iMessage, A2A)", secret: true, readBy: ["server", "script"], need: LIVE_REQ, rule: TEXT, invalid: "error", conditional: true },
  { name: "INKBOX_WEBHOOK_SECRET", purpose: "Inkbox webhook signing secret (verifies /webhooks/inkbox)", secret: true, readBy: ["server"], need: LIVE_REQ, rule: TEXT, invalid: "error", conditional: true },
  { name: "ANTHROPIC_API_KEY", purpose: "Claude API key (extraction, question answering, negotiation strategist)", secret: true, readBy: ["server", "eval"], need: LIVE_REQ, rule: TEXT, invalid: "error", conditional: true },
  { name: "SUPABASE_DB_URL", purpose: "Postgres connection string (session pooler, port 5432, BYPASSRLS role)", secret: true, readBy: ["server", "script"], need: LIVE_REQ, rule: { kind: "postgresUrl" }, invalid: "error", conditional: true, dbUrl: true },

  // --- generic format checks (config.ts reports them in this order) -----------------------------
  { name: "HAGGLE_TICK_SECRET", purpose: "Bearer secret for POST /internal/tick (external cron); empty disables the route", secret: true, readBy: ["server"], need: LIVE_OPT, rule: { kind: "minLength", min: 16 }, invalid: "error", message: "HAGGLE_TICK_SECRET must be at least 16 characters (or empty to disable /internal/tick)" },
  { name: "HAGGLE_ALERT_WEBHOOK_URL", purpose: "Slack-compatible incoming webhook for operator alerts (the URL is itself a secret)", secret: true, readBy: ["server"], need: N("unused", "optional", "recommended", "recommended"), rule: { kind: "httpsUrl" }, invalid: "error" },
  { name: "HAGGLE_AI_MAX_CALLS_PER_JOB", purpose: "Claude calls allowed per job; over it, replies wait for a human", secret: false, readBy: ["server"], need: N("unused", "optional", "recommended", "recommended"), rule: { kind: "posInt" }, invalid: "error" },
  { name: "HAGGLE_AI_DAILY_TOKEN_BUDGET", purpose: "Claude tokens per UTC day per process; over it, replies wait for a human", secret: false, readBy: ["server"], need: N("unused", "optional", "recommended", "recommended"), rule: { kind: "posInt" }, invalid: "error" },
  { name: "HAGGLE_STALL_CHECK_EVERY_S", purpose: "Stalled-job check interval in seconds (0 = off)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "posInt", allowZero: true }, invalid: "error", default: "300" },
  { name: "HAGGLE_DB_POOL_MAX", purpose: "Postgres connections per process (Supabase's session pooler allows 15 clients in total)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "intRange", min: 1, max: 10 }, invalid: "error", default: "4" },
  // Request limits (apps/mcp/src/limits.ts; S4-F). Per process, in memory.
  { name: "HAGGLE_MCP_MAX_BODY_BYTES", purpose: "Largest MCP request body accepted (bytes); larger gets 413", secret: false, readBy: ["server"], need: N("optional", "optional", "optional", "optional"), rule: { kind: "intRange", min: 1024, max: 16 * 1024 * 1024 }, invalid: "warn", default: "262144" },
  { name: "HAGGLE_WEBHOOK_MAX_BODY_BYTES", purpose: "Largest Inkbox webhook body accepted (bytes); larger gets 413", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "intRange", min: 1024, max: 32 * 1024 * 1024 }, invalid: "warn", default: "2097152" },
  { name: "HAGGLE_RATE_TOOL_CALLS_PER_MIN", purpose: "Tool calls per minute per credential (token bucket); 0 = off. Default 120 in live mode, off in mock", secret: false, readBy: ["server"], need: N("optional", "optional", "optional", "optional"), rule: { kind: "intRange", min: 0, max: 100_000 }, invalid: "warn" },
  { name: "HAGGLE_RATE_TOOL_CALLS_BURST", purpose: "Burst size of the per-credential tool-call rate limit", secret: false, readBy: ["server"], need: N("optional", "optional", "optional", "optional"), rule: { kind: "intRange", min: 1, max: 10_000 }, invalid: "warn", default: "30" },
  { name: "HAGGLE_DB_QUEUE_TIMEOUT_MS", purpose: "How long a query waits for a free pool connection before failing as transient (ms)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "intRange", min: 100, max: 60_000 }, invalid: "error", default: "5000" },
  { name: "HAGGLE_DB_SCHEMA", purpose: "Schema the migrations were applied to, when not public", secret: false, readBy: ["server", "brain", "script"], need: LIVE_OPT, rule: { kind: "pattern", re: /^[a-z_][a-z0-9_]*$/, describe: "a lower-case schema name ([a-z_][a-z0-9_]*)" }, invalid: "error" },
  { name: "HAGGLE_PAYMENTS", purpose: "manual: approved deals end in a payment handoff to the vendor (no money moves through Haggle)", secret: false, readBy: ["server"], need: N("unused", "optional", "recommended", "recommended"), rule: { kind: "enum", values: ["manual"] }, invalid: "error" },
  { name: "HAGGLE_GLOBAL_PAYMENT_CAP_CENTS", purpose: "Per-payment safety ceiling in cents (max 1,000,000)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "intRange", min: 1, max: 1_000_000 }, invalid: "error", default: "500000" },
  { name: "HAGGLE_SPENDING_CAP_CEILING_CENTS", purpose: "Highest spending cap a workspace may set, in cents", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "posInt" }, invalid: "error", default: "500000" },
  { name: "HAGGLE_EXTERNAL_SENDERS", purpose: "reply_token: accept replies from real vendors' own mail servers when they carry a signed reply token", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "enum", values: ["off", "reply_token"] }, invalid: "error", default: "off" },

  // --- conditional checks --------------------------------------------------------------------
  { name: "HAGGLE_REPLY_TOKEN_SECRET", purpose: "HMAC key for reply tokens (>= 16 characters) with HAGGLE_EXTERNAL_SENDERS=reply_token", secret: true, readBy: ["server"], need: LIVE_OPT, rule: { kind: "minLength", min: 16 }, invalid: "error", conditional: true },
  { name: "HAGGLE_ENABLE_PAYMENTS", purpose: "true: Stripe TEST-mode deposits (needs the three STRIPE_* variables) unless HAGGLE_PAYMENTS=manual", secret: false, readBy: ["server"], need: LIVE_OPT, rule: BOOL, invalid: "warn" },
  { name: "STRIPE_SECRET_KEY", purpose: "Stripe test-mode key (sk_test_ only; live keys are refused)", secret: true, readBy: ["server", "script"], need: LIVE_OPT, rule: { kind: "pattern", re: /^sk_test_/, describe: "a test-mode key (sk_test_)" }, invalid: "error", conditional: true },
  { name: "STRIPE_CUSTOMER_ID", purpose: "Stripe test customer charged for deposits", secret: false, readBy: ["server", "script"], need: LIVE_OPT, rule: TEXT, invalid: "error", conditional: true },
  { name: "STRIPE_PAYMENT_METHOD_ID", purpose: "Stripe test card on that customer", secret: false, readBy: ["server", "script"], need: LIVE_OPT, rule: TEXT, invalid: "error", conditional: true },

  // --- channels and behaviour (unknown values fall back to the safe default) ---------------------
  { name: "INKBOX_IDENTITY", purpose: "Inkbox buyer identity handle", secret: false, readBy: ["server", "script"], need: LIVE_OPT, rule: { kind: "pattern", re: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, describe: "an Inkbox handle" }, invalid: "warn", default: "haggle" },
  { name: "INKBOX_SENDER_TRUST", purpose: "Seller-reply trust: outbound-verified (default) or pinned-org-identity", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "enum", values: ["outbound-verified", "pinned-org-identity"] }, invalid: "warn", default: "outbound-verified" },
  { name: "ANTHROPIC_MODEL", purpose: "Claude model for extraction and the strategist", secret: false, readBy: ["server", "eval"], need: LIVE_OPT, rule: TEXT, invalid: "warn" },
  { name: "ANTHROPIC_WORKSPACE_ID", purpose: "Anthropic workspace for usage attribution", secret: false, readBy: ["server", "eval"], need: LIVE_OPT, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_ENABLE_CALLS", purpose: "true: Voice AI calls (only vendors who agreed)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: BOOL, invalid: "warn" },
  { name: "HAGGLE_ENABLE_IMESSAGE", purpose: "true: iMessage (approvals and businesses that connected first)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: BOOL, invalid: "warn" },
  { name: "HAGGLE_ENABLE_SMS", purpose: "true: SMS from the buyer's own number", secret: false, readBy: ["server"], need: LIVE_OPT, rule: BOOL, invalid: "warn" },
  { name: "HAGGLE_ENABLE_A2A", purpose: "true: A2A tasks to allowlisted Agent Cards", secret: false, readBy: ["server"], need: LIVE_OPT, rule: BOOL, invalid: "warn" },
  { name: "HAGGLE_SYNC_VOICE_CONTEXT", purpose: "false: don't sync deal context to the voice agent", secret: false, readBy: ["server"], need: LIVE_OPT, rule: BOOL, invalid: "warn" },
  { name: "HAGGLE_TRUST_INBOUND_CALLER_ID", purpose: "true: trust caller ID on inbound calls", secret: false, readBy: ["server"], need: LIVE_OPT, rule: BOOL, invalid: "warn" },
  { name: "HAGGLE_EMAIL_APPROVAL_BY_CODE", purpose: "true: accept APPROVE <code> by email (rests on a spoofable From address)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: BOOL, invalid: "warn" },
  { name: "HAGGLE_RECONCILE", purpose: "false: turn off the lost-webhook reconciliation sweep", secret: false, readBy: ["server"], need: LIVE_OPT, rule: BOOL, invalid: "warn" },
  { name: "HAGGLE_RECONCILE_EVERY_S", purpose: "Reconciliation sweep interval (seconds)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "posNumber" }, invalid: "warn", default: "60" },
  { name: "HAGGLE_CALL_DELAY_S", purpose: "Delay before a Voice AI call (seconds)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "posNumber" }, invalid: "warn" },
  { name: "HAGGLE_ESCALATE_EMAIL_TO_CALL_S", purpose: "Unanswered email escalates to a call after this many seconds", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "posNumber" }, invalid: "warn" },
  { name: "HAGGLE_CALL_HOURS", purpose: "Local call hours, start-end (24h)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "pattern", re: /^(\d{1,2})-(\d{1,2})$/, describe: "start-end hours, e.g. 9-20" }, invalid: "warn", default: "9-20" },
  // Workstream A's business-hours window for vendor contact (workflow/contactWindow.ts, contactWindowFromEnv).
  { name: "HAGGLE_CONTACT_HOURS", purpose: "Business-hours window for contacting vendors, HH:MM-HH:MM local; off disables the window", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "pattern", re: /^(off|\d{1,2}:\d{2}-\d{1,2}:\d{2})$/i, describe: "HH:MM-HH:MM (e.g. 08:00-19:00) or off" }, invalid: "warn" },
  { name: "HAGGLE_CONTACT_DAYS", purpose: "Weekdays vendors may be contacted, e.g. Mon-Sat or Mon,Wed,Fri", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "pattern", re: /^(mon|tue|wed|thu|fri|sat|sun)([-,](mon|tue|wed|thu|fri|sat|sun))*$/i, describe: "weekday names, e.g. Mon-Sat or Mon,Wed,Fri" }, invalid: "warn" },
  { name: "HAGGLE_CONTACT_TIMEZONE", purpose: "Time zone of the vendor-contact window", secret: false, readBy: ["server"], need: LIVE_OPT, rule: { kind: "timezone" }, invalid: "warn", default: "America/Los_Angeles" },
  { name: "HAGGLE_CUSTOMER_NAME", purpose: "Customer name used in outreach (40 characters max)", secret: false, readBy: ["server"], need: LIVE_OPT, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_VOICE_WORKSPACE", purpose: "Workspace whose settings the voice line uses", secret: false, readBy: ["server"], need: LIVE_OPT, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_NOTIFY_PHONE", purpose: "Phone (E.164) for update texts, else the settings approver", secret: false, pii: true, readBy: ["server"], need: LIVE_OPT, rule: { kind: "pattern", re: /^\+?[\d\s().-]{8,20}$/, describe: "a phone number" }, invalid: "warn" },
  { name: "HAGGLE_ALLOWED_RECIPIENTS", purpose: "Extra contacts outreach may reach (comma-separated); discovery is not permission", secret: false, pii: true, readBy: ["server"], need: OPT, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_DEMO_FLEET", purpose: "Simulated fleet offered by discover in live mode", secret: false, pii: true, readBy: ["server"], need: LIVE_OPT, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_DEMO_VENDORS", purpose: "Operator-configured demo vendor contacts", secret: false, pii: true, readBy: ["server"], need: LIVE_OPT, rule: TEXT, invalid: "warn" },
  { name: "GOOGLE_PLACES_API_KEY", purpose: "Google Places key for public discovery/reputation (absent = off)", secret: true, readBy: ["server"], need: LIVE_OPT, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_MIGRATIONS_DIR", purpose: "Where /ready finds supabase/migrations when not found by walking up", secret: false, readBy: ["server"], need: OPT, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_AUTH", purpose: "Mock only: required turns on workspace auth (live always requires it)", secret: false, readBy: ["server"], need: N("optional", "unused", "unused", "unused"), rule: { kind: "enum", values: ["open", "required"] }, invalid: "warn" },

  // --- brain (packages/brain, configured from the server's environment) -------------------------
  { name: "SUPABASE_URL", purpose: "Brain profile store (Supabase REST URL); with SUPABASE_SERVICE_ROLE_KEY", secret: false, readBy: ["brain"], need: LIVE_OPT, rule: { kind: "url" }, invalid: "warn" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", purpose: "Brain profile store service-role key", secret: true, readBy: ["brain"], need: LIVE_OPT, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_BRAIN_STORE", purpose: "memory: keep brain profiles in memory (wins over Supabase)", secret: false, readBy: ["brain"], need: OPT, rule: { kind: "enum", values: ["memory"] }, invalid: "warn" },
  { name: "HAGGLE_BRAIN_FILE", purpose: "Brain profile file when Supabase isn't configured", secret: false, readBy: ["brain"], need: OPT, rule: TEXT, invalid: "warn", default: ".haggle-data/brain.json" },
  { name: "HAGGLE_DIRECTORY_FILE", purpose: "Business directory override file (brain)", secret: false, readBy: ["brain"], need: OPT, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_DIRECTORY_JSON", purpose: "Inline business directory JSON (brain)", secret: false, readBy: ["brain"], need: OPT, rule: { kind: "json" }, invalid: "warn" },

  // --- mock / rehearsal only (production refuses them) ----------------------------------------
  { name: "HAGGLE_SIM_DELAY_SCALE", purpose: "Simulated seller reply delay multiplier (0 = instant)", secret: false, readBy: ["server"], need: MOCK_ONLY, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_MOCK_VENDORS", purpose: "none: rehearse a server with no vendor set up", secret: false, readBy: ["server"], need: MOCK_ONLY, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_MOCK_PERSONAS_FILE", purpose: "Scripted simulated vendors (JSON file)", secret: false, readBy: ["server"], need: MOCK_ONLY, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_PLACES_FIXTURE", purpose: "Recorded Places/website responses for discovery rehearsals", secret: false, readBy: ["server"], need: MOCK_ONLY, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_MOCK_DATABASE_URL", purpose: "Throwaway Postgres for mock restart rehearsals (never a real database)", secret: true, readBy: ["server"], need: MOCK_ONLY, rule: { kind: "postgresUrl" }, invalid: "error", conditional: true, dbUrl: true },
  { name: "HAGGLE_MOCK_BRAIN_FILE", purpose: "Brain file kept across mock restarts", secret: false, readBy: ["server"], need: MOCK_ONLY, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_MOCK_WORKSPACES", purpose: "Mock workspaces JSON (tests and rehearsals of auth/isolation)", secret: true, readBy: ["server"], need: MOCK_ONLY, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_APPROVALS", purpose: "out_of_band: mock servers accept only out-of-band approvals (live always does)", secret: false, readBy: ["server"], need: MOCK_ONLY, rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_DEMO_SPEED", purpose: "true: shorter windows for a demo video", secret: false, readBy: ["server"], need: N("optional", "optional", "optional", "refused_true"), rule: BOOL, invalid: "warn" },
  { name: "HAGGLE_ALLOW_ANY_RECIPIENT", purpose: "Ignored in live mode (logged); refused in production", secret: false, readBy: ["server"], need: N("optional", "optional", "optional", "refused_true"), rule: BOOL, invalid: "warn" },
  { name: "SELLERS_ALLOW_UNSIGNED", purpose: "Simulated sellers (apps/sellers) accept unsigned webhooks; refused in production", secret: false, readBy: ["sellers"], need: N("optional", "optional", "optional", "refused_true"), rule: BOOL, invalid: "warn" },

  // --- operator scripts, tests, eval ----------------------------------------------------------
  { name: "HAGGLE_SMOKE_TOKEN", purpose: "Workspace bearer for smoke.ts (never echoed)", secret: true, readBy: ["script"], need: OPT, rule: TEXT, invalid: "warn" },
  { name: "PUBLIC_BASE_URL", purpose: "Server URL printed by workspace-create / workspace-admin rotate", secret: false, readBy: ["script"], need: OPT, rule: { kind: "url" }, invalid: "warn" },
  { name: "HAGGLE_EMAIL_TRIAL", purpose: "1: allow one email-trial run (scripts/email-trial.ts)", secret: false, readBy: ["script"], need: N("unused", "optional", "optional", "unused"), rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_EMAIL_TRIAL_MAILBOXES", purpose: "Mailboxes the email trial may write to (comma-separated)", secret: false, pii: true, readBy: ["script"], need: N("unused", "optional", "optional", "unused"), rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_TEST_DATABASE_URL", purpose: "Throwaway Postgres for the PG-gated tests (scripts/test-postgres.sh sets it)", secret: true, readBy: ["test"], need: N("optional", "unused", "unused", "unused"), rule: { kind: "postgresUrl" }, invalid: "warn", dbUrl: true },
  { name: "HAGGLE_EVAL_MAX_USD", purpose: "Spending cap in USD for an opt-in live eval run (required with HAGGLE_EVAL_LIVE=1)", secret: false, readBy: ["eval"], need: N("optional", "unused", "unused", "unused"), rule: TEXT, invalid: "warn" },
  { name: "HAGGLE_EVAL_LIVE", purpose: "1: the eval harness also runs the Claude extractor (calls Anthropic)", secret: false, readBy: ["eval"], need: N("optional", "unused", "unused", "unused"), rule: TEXT, invalid: "warn" },
];

export const MANIFEST_BY_NAME: ReadonlyMap<string, EnvVarSpec> = new Map(ENV_MANIFEST.map((s) => [s.name, s]));

/** Operating-system variables code may read that aren't configuration. */
export const OS_VARS = ["PATH", "HOME", "NODE_ENV", "TMPDIR"] as const;

const names = (f: (s: EnvVarSpec) => boolean) => ENV_MANIFEST.filter(f).map((s) => s.name);
/** Required in every live target (missing = refused). */
export const manifestLiveRequired = () => names((s) => s.need.dev === "required" && s.need.staging === "required" && s.need.production === "required" && s.name !== "HAGGLE_MODE");
export const manifestProductionRefused = () => names((s) => s.need.production === "refused");
export const manifestProductionRefusedTrue = () => names((s) => s.need.production === "refused_true");
export const manifestDbUrls = () => names((s) => !!s.dbUrl);

const isSet = (v: string | undefined) => v !== undefined && v.trim() !== "";

/** The generic rule message for a violation (names the variable, never the value). */
export function ruleMessage(s: EnvVarSpec): string {
  if (s.message) return s.message;
  const r = s.rule;
  switch (r.kind) {
    case "enum": return `${s.name} must be one of ${r.values.join(", ")}`;
    case "bool": return `${s.name} must be true or false (anything else counts as false)`;
    case "posInt": return `${s.name} must be a positive integer`;
    case "intRange": return `${s.name} must be an integer from ${r.min} to ${r.max}`;
    case "posNumber": return `${s.name} must be a positive number (it is ignored otherwise)`;
    case "httpsUrl": return `${s.name} must be an https:// URL`;
    case "url": return `${s.name} must be an http(s):// URL`;
    case "postgresUrl": return `${s.name} is not a postgres:// connection string`;
    case "minLength": return `${s.name} must be at least ${r.min} characters`;
    case "pattern": return `${s.name} must be ${r.describe}`;
    case "json": return `${s.name} must be valid JSON`;
    case "timezone": return `${s.name} must be an IANA time zone, e.g. America/Los_Angeles`;
    case "text": return `${s.name} is invalid`;
  }
}

/** Does a set value satisfy its rule? (Unset always passes; requirement is checked separately.) */
export function satisfiesRule(rule: Rule, raw: string): boolean {
  const v = raw.trim();
  switch (rule.kind) {
    case "enum": return rule.values.includes(v);
    case "bool": return v === "true" || v === "false";
    case "posInt": return /^\d+$/.test(v) && (Number(v) > 0 || (!!rule.allowZero && Number(v) === 0));
    case "intRange": return /^\d+$/.test(v) && Number(v) >= rule.min && Number(v) <= rule.max;
    case "posNumber": return Number.isFinite(Number(v)) && Number(v) > 0;
    case "httpsUrl": return /^https:\/\//i.test(v);
    case "url": try { return ["http:", "https:"].includes(new URL(v).protocol); } catch { return false; }
    case "postgresUrl": try { const u = new URL(v); return (u.protocol === "postgres:" || u.protocol === "postgresql:") && !!u.hostname; } catch { return false; }
    case "minLength": return v.length >= rule.min;
    case "pattern": return rule.re.test(v);
    case "json": try { JSON.parse(v); return true; } catch { return false; }
    case "timezone": try { new Intl.DateTimeFormat("en-US", { timeZone: v }); return /\//.test(v) || v === "UTC"; } catch { return false; }
    case "text": return true;
  }
}

/** Format problems of every non-conditional variable that is set, in manifest order. */
export function manifestFormatProblems(env: Record<string, string | undefined>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const s of ENV_MANIFEST) {
    if (s.conditional || !isSet(env[s.name]) || satisfiesRule(s.rule, env[s.name]!)) continue;
    (s.invalid === "error" ? errors : warnings).push(ruleMessage(s));
  }
  return { errors, warnings };
}

/** The target a given environment describes. */
export function targetOf(env: Record<string, string | undefined>): Target {
  if (env.HAGGLE_MODE?.trim() !== "live") return env.HAGGLE_ENV?.trim().toLowerCase() === "production" ? "production" : "mock";
  const e = env.HAGGLE_ENV?.trim().toLowerCase();
  return e === "production" ? "production" : e === "staging" ? "staging" : "dev";
}

/** Recommended variables missing for the target (launch-gate warnings; the server doesn't refuse them). */
export function missingRecommended(env: Record<string, string | undefined>, target: Target = targetOf(env)): string[] {
  return ENV_MANIFEST.filter((s) => s.need[target] === "recommended" && !isSet(env[s.name])).map((s) => s.name);
}
