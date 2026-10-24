// MOCK MODE wiring: the real engine over in-memory persistence, the simulated fleet (email and
// Voice AI calls), the stand-in brain and a payment rail: by default a SIMULATED Stripe (v5; no
// network, DEMO PaymentIntents), or the v3 x402 payer (real x402 steps, stub signer, no network)
// with rail: "x402" or an explicit payer. Like live Inkbox mode, every job shares one buyer mailbox. Everything it
// produces is labelled simulated / DEMO. Used by `HAGGLE_MODE=mock` and the end-to-end tests.
import { createX402Client } from "@primitivedotdev/sdk/x402";
import { StubBrain } from "./brain/stubBrain.ts";
import { fleetBusinesses, SimFleet, type Persona } from "./sim/fleet.ts";
import { InMemoryRepository } from "./store/memory.ts";
import { HaggleEngine } from "./workflow/engine.ts";
import { inlineAttachments, type EngineConfig, type IMessagePort, type PayerPort, type VoiceContextPort } from "./workflow/ports.ts";
import type { Brain } from "./contract.ts";
import type { PayerClient } from "./payments/x402Challenge.ts";
import { simulatedStripe, type StripePort } from "./payments/stripe.ts";
import type { Repository } from "./store/types.ts";

export const MOCK_INBOX_DOMAIN = "mock.haggle.dev";
export const MOCK_BUYER_INBOX = `haggle@${MOCK_INBOX_DOMAIN}`;

export function createMockEngine(opts: { now?: () => Date; delayScale?: number; brain?: Brain; config?: Partial<EngineConfig>; repo?: Repository; phone?: boolean; a2a?: boolean; imessage?: IMessagePort; voice?: VoiceContextPort; personas?: Persona[]; payer?: PayerPort; rail?: "stripe" | "x402"; stripe?: StripePort } = {}) {
  // An explicit payer means the x402 rail (e.g. tests of the disabled live payer).
  const rail = opts.rail ?? (opts.payer ? "x402" : "stripe");
  const stripe = rail === "stripe" ? (opts.stripe ?? simulatedStripe()) : undefined;
  const now = opts.now ?? (() => new Date());
  const repo = opts.repo ?? new InMemoryRepository({ now });
  const fleet = new SimFleet({ now, delayScale: opts.delayScale ?? 1, ...(opts.personas ? { personas: opts.personas } : {}) });
  const payerClient = createX402Client({ apiKey: "prim_mock", fetch: (async () => { throw new Error("mock payer has no network"); }) as typeof fetch });
  const engine: HaggleEngine = new HaggleEngine({
    repo,
    email: fleet,
    ...(opts.phone === false ? {} : { phone: fleet }),
    ...(opts.a2a === false ? {} : { a2a: fleet.a2a }),
    ...(opts.imessage ? { imessage: opts.imessage } : {}),
    ...(opts.voice ? { voice: opts.voice } : {}),
    ...(stripe ? { stripe } : {}),
    extractor: fleet,
    attachments: inlineAttachments,
    brain: opts.brain ?? new StubBrain(fleetBusinesses(opts.personas)),
    payer: opts.payer ?? {
      client: payerClient as unknown as PayerClient,
      signer: { address: "0x5157000000000000000000000000000000000002", signTypedData: async () => `0x${"00".repeat(65)}` },
      simulated: true,
    },
    config: {
      mode: "mock", inboxDomain: MOCK_INBOX_DOMAIN, sharedInbox: MOCK_BUYER_INBOX, collectionWindowMs: 10 * 60_000, negotiationWindowMs: 5 * 60_000, followUpHoldMs: 60_000,
      approvalTtlMs: 30 * 60_000, globalPaymentCapCents: rail === "stripe" ? 50_000 : 500, maxRounds: 2, defaultSpendingCapCents: 150_000, spendingCapCeilingCents: 500_000,
      // Simulated businesses only: no call spacing, no call hours (live sets both), DEMO identity.
      callCooldownMs: 0, identity: { name: "Haggle (DEMO)", phone: null },
      ...opts.config,
    },
    now,
    onTick: async () => {
      await fleet.deliverDue();
    },
  });
  fleet.connect(
    (msg, trustFor, o) => engine.ingest(msg, trustFor, o).then(async (r) => (r.jobId ? engine.advanceJob(r.jobId) : undefined)),
    (call) => engine.ingestCall(call).then(async (r) => (r.jobId ? engine.advanceJob(r.jobId) : undefined)),
    (taskId) => engine.ingestA2aTask(taskId, { simulated: true }).then(async (r) => (r.jobId ? engine.advanceJob(r.jobId) : undefined)),
  );
  return { engine, fleet, repo, stripe };
}
