// Run the restaurant simulators on this machine (DESIGN.md §15).
// Run: npm run sim   (reads .env; needs ANTHROPIC_API_KEY and SIM_*_API_KEY)
//
// State (inbox cursors, last quoted prices) lives in sim/.cursors.json so a
// restart never double-replies. To run them inside the deployed server
// instead, set SIM_ON_SERVER=true there (see src/sim/hosted.ts); don't run both.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { startSimulators, type SimState, type SimStore } from "./simulator.ts";

const STATE_FILE = new URL("./.cursors.json", import.meta.url);

const fileStore: SimStore = {
  async load(): Promise<SimState> {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { cursors: {}, lastPrice: {} };
  },
  async save(_personaId: string, state: SimState): Promise<void> {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  },
};

await startSimulators(fileStore);
