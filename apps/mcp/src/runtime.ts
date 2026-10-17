// Builds the engine for the configured mode. Mock mode (default) needs no credentials and is
// labelled DEMO everywhere; live mode needs every variable below and refuses to start partially.
import { createMockEngine, type HaggleEngine, type InkboxMailApi } from "@haggle/engine";

export type Runtime = {
  mode: "mock" | "live";
  engine: HaggleEngine;
  /** Mock mode: the simulated fleet's delivery pump (the engine also pumps on every wait). */
  tick?: () => Promise<number>;
  /** Live mode: the Inkbox buyer identity and its webhook signing key. */
  inkbox?: { api: InkboxMailApi; buyerMailbox: string; webhookSecret: string };
  missing: string[];
};

export const LIVE_REQUIRED = ["INKBOX_API_KEY", "INKBOX_WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "SUPABASE_DB_URL"] as const;

let runtime: Promise<Runtime> | null = null;
let liveFactory: ((env: NodeJS.ProcessEnv) => Promise<Runtime>) | null = null;

/** apps/mcp/src/live.ts registers itself so mock-only builds never load live dependencies. */
export function registerLiveFactory(f: (env: NodeJS.ProcessEnv) => Promise<Runtime>) {
  liveFactory = f;
}

/** Environment variables live mode still needs (empty in mock mode). */
export function missingLiveConfig(env = process.env): string[] {
  if (env.HAGGLE_MODE !== "live") return [];
  return LIVE_REQUIRED.filter((k) => !env[k]?.trim());
}

export async function getRuntime(env = process.env): Promise<Runtime> {
  if (runtime) return runtime;
  if (env.HAGGLE_MODE === "live") {
    const missing = missingLiveConfig(env);
    if (missing.length || !liveFactory) throw new Error(`live mode is not configured: missing ${missing.join(", ") || "live factory"}`);
    runtime = liveFactory(env).catch((e) => {
      runtime = null; // let the next call retry (e.g. Inkbox briefly unreachable at boot)
      throw e;
    });
    return runtime;
  }
  const delayScale = Number(env.HAGGLE_SIM_DELAY_SCALE ?? "1");
  const m = createMockEngine({ delayScale: Number.isFinite(delayScale) && delayScale >= 0 ? delayScale : 1 });
  runtime = Promise.resolve({ mode: "mock", engine: m.engine, tick: () => m.fleet.deliverDue(), missing: [] });
  return runtime;
}

/** Tests only. */
export function resetRuntime() {
  runtime = null;
}
