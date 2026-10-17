// Run the restaurant simulators inside the deployed server (SIM_ON_SERVER=true),
// so the public demo works without anyone's laptop. State lives in the
// sim_state table instead of a local file. Run this OR `npm run sim`, not both.
import { getSimStates, saveSimState } from "../db/queries.js";
import { startSimulators, type SimState, type SimStore } from "../../sim/simulator.ts";

const dbStore: SimStore = {
  async load(): Promise<SimState> {
    const state: SimState = { cursors: {}, lastPrice: {} };
    for (const row of await getSimStates()) {
      if (row.cursor) state.cursors[row.persona_id] = row.cursor;
      Object.assign(state.lastPrice, row.last_price);
    }
    return state;
  },
  async save(personaId: string, state: SimState): Promise<void> {
    // Each persona stores only its own prices (keys start with "<persona>:").
    const lastPrice = Object.fromEntries(Object.entries(state.lastPrice).filter(([k]) => k.startsWith(`${personaId}:`)));
    await saveSimState({ persona_id: personaId, cursor: state.cursors[personaId] ?? null, last_price: lastPrice });
  },
};

let started = false;

/**
 * Start once per process; errors are logged, never thrown into the server.
 * startSimulators only returns early if loading state fails (e.g. the database
 * isn't reachable yet at boot), so keep retrying until it runs.
 */
export function startHostedSimulators(): void {
  if (started) return;
  started = true;
  console.log("[sim] starting simulators inside the server (SIM_ON_SERVER=true)");
  void (async () => {
    for (;;) {
      try {
        await startSimulators(dbStore);
        return;
      } catch (err) {
        console.error("[sim] could not start, retrying in 30 s:", err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
  })();
}
