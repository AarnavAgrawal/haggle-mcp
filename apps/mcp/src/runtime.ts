// Builds the engine for the configured mode. Mock mode (default) needs no credentials and is
// labelled DEMO everywhere; live mode needs every variable below and refuses to start partially.
import { createMockEngine, type HaggleEngine } from "@haggle/engine";

export type Runtime = {
  mode: "mock" | "live";
  engine: HaggleEngine;
  /** Mock mode: the simulated fleet's delivery pump (the engine also pumps on every wait). */
  tick?: () => Promise<number>;
  webhook?: { secret: string; endpointId?: string; inboxDomain: string };
  missing: string[];
};

const LIVE_REQUIRED = ["PRIMITIVE_API_KEY", "PRIMITIVE_WEBHOOK_SECRET", "HAGGLE_INBOX_DOMAIN", "ANTHROPIC_API_KEY", "SUPABASE_DB_URL"] as const;

let runtime: Runtime | null = null;
let liveFactory: ((env: NodeJS.ProcessEnv) => Promise<Runtime>) | null = null;

/** apps/mcp/src/live.ts registers itself so mock-only builds never load live dependencies. */
export function registerLiveFactory(f: (env: NodeJS.ProcessEnv) => Promise<Runtime>) {
  liveFactory = f;
}

export async function getRuntime(env = process.env): Promise<Runtime> {
  if (runtime) return runtime;
  if (env.HAGGLE_MODE === "live") {
    const missing = LIVE_REQUIRED.filter((k) => !env[k]?.trim());
    if (missing.length || !liveFactory) throw new Error(`live mode is not configured: missing ${missing.join(", ") || "live factory"}`);
    runtime = await liveFactory(env);
    return runtime;
  }
  const delayScale = Number(env.HAGGLE_SIM_DELAY_SCALE ?? "1");
  const m = createMockEngine({ delayScale: Number.isFinite(delayScale) && delayScale >= 0 ? delayScale : 1 });
  runtime = { mode: "mock", engine: m.engine, tick: () => m.fleet.deliverDue(), missing: [] };
  return runtime;
}

/** Tests only. */
export function resetRuntime() {
  runtime = null;
}
