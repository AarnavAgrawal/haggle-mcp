// Haggle's own waits in live mode (and the few that matter in mock). HAGGLE_DEMO_SPEED=true (decision
// 49, off by default) shortens them so a whole deal (quotes, negotiation, the "all quotes are in" text,
// approve, pay) fits in about two minutes of video, with seller personas that answer in seconds and
// one Voice AI call. Off, every value is today's. Collection still closes as soon as every business
// has answered; these are only the caps and spacings around that.
import type { EngineConfig } from "@haggle/engine";

type EngineTimings = Pick<EngineConfig, "collectionWindowMs" | "negotiationWindowMs" | "callCooldownMs"> &
  Partial<Pick<EngineConfig, "counterCallGapMs" | "minCallGapMs" | "callRetryMs" | "questionBatchMs" | "replyGraceMs" | "questionHoldMs" | "followUpHoldMs" | "callDelayMs" | "escalateEmailToCallAfterMs">>;

export interface LiveTimings {
  demoSpeed: boolean;
  /** The backup tick that advances every open deal. */
  tickMs: number;
  /** The inbound reconciliation sweep (lost webhooks). */
  reconcileEveryMs: number;
  /** A pre-close sweep of one deal at most this often. */
  reconcileJobMinIntervalMs: number;
  /** A placed call with no call.ended after this long is looked up by the sweep. */
  reconcileCallGraceMs: number;
  engine: EngineTimings;
}

const secs = (v: string | undefined) => (Number(v) > 0 ? Number(v) * 1000 : null);

export function liveTimings(env: NodeJS.ProcessEnv = process.env): LiveTimings {
  const demoSpeed = env.HAGGLE_DEMO_SPEED === "true";
  const callDelay = secs(env.HAGGLE_CALL_DELAY_S);
  const escalate = secs(env.HAGGLE_ESCALATE_EMAIL_TO_CALL_S);
  const reconcile = secs(env.HAGGLE_RECONCILE_EVERY_S);
  if (!demoSpeed) {
    return {
      demoSpeed, tickMs: 30_000, reconcileEveryMs: reconcile ?? 60_000, reconcileJobMinIntervalMs: 15_000, reconcileCallGraceMs: 3 * 60_000,
      engine: {
        collectionWindowMs: 30 * 60_000, negotiationWindowMs: 5 * 60_000, callCooldownMs: 2 * 60_000,
        ...(callDelay !== null ? { callDelayMs: callDelay } : {}), ...(escalate !== null ? { escalateEmailToCallAfterMs: escalate } : {}),
      },
    };
  }
  return {
    demoSpeed, tickMs: 5_000, reconcileEveryMs: Math.min(reconcile ?? 15_000, 15_000), reconcileJobMinIntervalMs: 5_000, reconcileCallGraceMs: 30_000,
    engine: {
      // A cap only (collection closes as soon as everyone answered); room for one Voice AI call.
      collectionWindowMs: 4 * 60_000, negotiationWindowMs: 60_000,
      callCooldownMs: 5_000, counterCallGapMs: 5_000, minCallGapMs: 5_000, callRetryMs: 10_000,
      questionBatchMs: 5_000, replyGraceMs: 60_000, questionHoldMs: 60_000, followUpHoldMs: 30_000,
      ...(callDelay !== null ? { callDelayMs: Math.min(callDelay, 5_000) } : {}), ...(escalate !== null ? { escalateEmailToCallAfterMs: Math.min(escalate, 30_000) } : {}),
    },
  };
}

/** Mock mode under HAGGLE_DEMO_SPEED: the same shorter windows (the simulated fleet has no call spacing). */
export function mockDemoConfig(env: NodeJS.ProcessEnv = process.env): Partial<EngineConfig> {
  if (env.HAGGLE_DEMO_SPEED !== "true") return {};
  const { collectionWindowMs, negotiationWindowMs, questionBatchMs, replyGraceMs, questionHoldMs, followUpHoldMs } = liveTimings(env).engine;
  return { collectionWindowMs, negotiationWindowMs, questionBatchMs, replyGraceMs, questionHoldMs, followUpHoldMs };
}
