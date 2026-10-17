// The real brain (@haggle/brain) behind the engine's adapter. Profiles go to Supabase when
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set (needs migration 200_brain_profiles), else to
// HAGGLE_BRAIN_FILE / memory (see .env.example). Seeded so warm asks work from minute one.
import { createBrain, loadDirectory, storeFromEnv } from "@haggle/brain";
import { BrainAdapter, type BrainAdapterOptions, type EngineContact } from "@haggle/engine";

export function makeBrain(fleet: EngineContact[], env: NodeJS.ProcessEnv = process.env, extra: Pick<BrainAdapterOptions, "discovery"> = {}): BrainAdapter {
  const core = createBrain({ store: storeFromEnv(env), seed: true });
  return new BrainAdapter({ brain: core, directory: loadDirectory(), fleet, ...extra });
}
