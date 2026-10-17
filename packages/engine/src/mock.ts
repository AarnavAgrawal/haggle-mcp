// MOCK MODE wiring: the real engine over in-memory persistence, the simulated fleet, the stand-in
// brain and a payer that builds real x402 steps with a stub signer and no network. Everything it
// produces is labelled simulated / DEMO. Used by `HAGGLE_MODE=mock` and the end-to-end tests.
import { createX402Client } from "@primitivedotdev/sdk/x402";
import { StubBrain } from "./brain/stubBrain.ts";
import { fleetBusinesses, SimFleet } from "./sim/fleet.ts";
import { InMemoryRepository } from "./store/memory.ts";
import { HaggleEngine } from "./workflow/engine.ts";
import { inlineAttachments, type EngineConfig } from "./workflow/ports.ts";
import type { Brain } from "@haggle/core/contracts";
import type { PayerClient } from "./payments/x402Challenge.ts";

export const MOCK_INBOX_DOMAIN = "mock.haggle.dev";

export function createMockEngine(opts: { now?: () => Date; delayScale?: number; brain?: Brain; config?: Partial<EngineConfig> } = {}) {
  const now = opts.now ?? (() => new Date());
  const repo = new InMemoryRepository();
  const fleet = new SimFleet({ now, delayScale: opts.delayScale ?? 1 });
  const payerClient = createX402Client({ apiKey: "prim_mock", fetch: (async () => { throw new Error("mock payer has no network"); }) as typeof fetch });
  const engine: HaggleEngine = new HaggleEngine({
    repo,
    email: fleet,
    extractor: fleet,
    attachments: inlineAttachments,
    brain: opts.brain ?? new StubBrain(fleetBusinesses()),
    payer: {
      client: payerClient as unknown as PayerClient,
      signer: { address: "0x5157000000000000000000000000000000000002", signTypedData: async () => `0x${"00".repeat(65)}` },
      simulated: true,
    },
    config: {
      mode: "mock", inboxDomain: MOCK_INBOX_DOMAIN, collectionWindowMs: 10 * 60_000, negotiationWindowMs: 5 * 60_000,
      approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500, maxRounds: 2, ...opts.config,
    },
    now,
    onTick: async () => {
      await fleet.deliverDue();
    },
  });
  fleet.connect((msg, trustFor, o) => engine.ingest(msg, trustFor, o).then(async (r) => (r.jobId ? engine.advanceJob(r.jobId) : undefined)));
  return { engine, fleet, repo };
}
