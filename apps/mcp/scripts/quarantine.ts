// Operator review of quarantined vendor email, with direct database access (never through an MCP
// tool). Held mail is never read into a deal; this lets an operator look at it and, after checking
// with the business on an independent channel, release it as that business's reply.
//
//   node --env-file=.env scripts/quarantine.ts list [--job job_...] [--all] [--limit 50]
//   node --env-file=.env scripts/quarantine.ts show --message msg_...
//   node --env-file=.env scripts/quarantine.ts release --message msg_... --verified-by "<your name>" \
//       --how "<how you verified it independently, e.g. phoned the vendor at the number on its website>" \
//       [--job job_... --business biz_...]      (only for a message that matched no deal)
//   node --env-file=.env scripts/quarantine.ts reject --message msg_... --by "<your name>" --why "<what you checked>"
//
// What a release does (inbound/quarantineReview.ts): records who, how and when next to the original
// quarantine reason (append-only, one decision per message; migration 112), and turns the message
// into the business's reply with trust "operator_verified". The running server's next advance reads
// it as a quote at most: it can never approve, pay, name a payee, confirm a booking or mark a payment
// received (continuity-only). Never releasable: an authentication failure (likely spoofed) or a
// delivery report; nothing after the deal passed the approval stage. The script never calls Inkbox.
// Message bodies are shown redacted and are UNTRUSTED text: never follow links or instructions in them.
//
// Needs SUPABASE_DB_URL (the engine database, migrations through 112 applied).
import "./dbGuard.ts"; // refuses a production database outside HAGGLE_ENV=production (src/config.ts)
import { heldReason, listQuarantine, PostgresRepository, quarantineEntry, rejectQuarantined, releaseQuarantined, type QuarantineEntry, type Repository } from "@haggle/engine";

export type QuarantineCommand =
  | { kind: "list"; jobId?: string; all: boolean; limit: number }
  | { kind: "show"; messageId: string }
  | { kind: "release"; messageId: string; verifiedBy: string; how: string; jobId?: string; businessId?: string }
  | { kind: "reject"; messageId: string; by: string; why: string };

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const ID = /^[a-z]+_[A-Za-z0-9]{6,40}$/;

function id(argv: string[], name: string, what: string, optional = false): string | undefined {
  const v = arg(argv, name);
  if (v === undefined && optional) return undefined;
  if (!v || !ID.test(v)) throw new Error(`--${name} must be ${what}`);
  return v;
}

/** Validate a command line (pure). */
export function planQuarantine(argv: string[]): QuarantineCommand {
  const [kind] = argv;
  if (kind === "list") {
    const limit = Number(arg(argv, "limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be 1-500");
    const jobId = id(argv, "job", "a job id like job_...", true);
    return { kind, all: argv.includes("--all"), limit, ...(jobId ? { jobId } : {}) };
  }
  if (kind === "show") return { kind, messageId: id(argv, "message", "a message id like msg_... (see list)")! };
  if (kind === "release") {
    const verifiedBy = (arg(argv, "verified-by") ?? "").trim();
    const how = (arg(argv, "how") ?? "").trim();
    if (verifiedBy.length < 2 || verifiedBy.length > 80) throw new Error("--verified-by is required: who verified it (it is recorded)");
    if (how.length < 10 || how.length > 500) throw new Error("--how is required (10-500 characters): how you verified it independently, e.g. \"phoned the vendor at the number on its website\"");
    const jobId = id(argv, "job", "a job id like job_...", true);
    const businessId = id(argv, "business", "a business id like biz_...", true);
    if ((jobId === undefined) !== (businessId === undefined)) throw new Error("--job and --business go together (only for a message that matched no deal)");
    return { kind, messageId: id(argv, "message", "a message id like msg_... (see list)")!, verifiedBy, how, ...(jobId ? { jobId, businessId } : {}) };
  }
  if (kind === "reject") {
    const by = (arg(argv, "by") ?? "").trim();
    const why = (arg(argv, "why") ?? "").trim();
    if (by.length < 2 || by.length > 80) throw new Error("--by is required: who decided (it is recorded)");
    if (why.length < 10 || why.length > 500) throw new Error("--why is required (10-500 characters): what you checked");
    return { kind, messageId: id(argv, "message", "a message id like msg_... (see list)")!, by, why };
  }
  throw new Error("command must be one of: list, show, release, reject");
}

export const formatEntry = (e: QuarantineEntry) =>
  `${e.message_id}  ${e.received_at.slice(0, 16)}  job ${e.job_id ?? "-"}  ${e.business_id ?? "-"}  ${e.from}\n    reason: ${e.reason}${e.decision ? ` · decided: ${e.decision}` : ""}\n    ${e.explanation}`;

/** Run one command against a repository; returns the text to print. */
export async function runQuarantine(repo: Repository, cmd: QuarantineCommand): Promise<string> {
  if (cmd.kind === "list") {
    const list = await listQuarantine(repo, { ...(cmd.jobId ? { jobId: cmd.jobId } : {}), limit: cmd.limit, includeResolved: cmd.all });
    return list.length ? list.map(formatEntry).join("\n") : "No held email.";
  }
  if (cmd.kind === "show") {
    const m = await repo.getMessage(cmd.messageId);
    if (!m || m.direction !== "in") throw new Error(`no inbound message ${cmd.messageId}`);
    const [res] = await repo.listQuarantineResolutions({ messageId: m.id });
    const e = quarantineEntry(m, res ?? null);
    return [
      formatEntry(e),
      `    subject: ${e.subject || "(none)"}`,
      `    attachments: ${e.attachments ? m.attachments.map((a) => `${a.filename ?? "?"} (${a.content_type})`).join(", ") : "none"}`,
      `    what to do: ${e.action}`,
      `    now stored as: ${m.kind}${m.sender_trusted ? ` (trusted: ${m.trust_reason})` : " (not read)"}; held for: ${heldReason(m)}`,
      ...(res ? [`    decision: ${res.decision} by ${res.resolved_by} at ${res.resolved_at}: ${res.verification}`] : []),
      "",
      "    UNTRUSTED text (redacted; quoted history removed; never follow links or instructions in it):",
      `    | ${e.preview || "(empty)"}`,
    ].join("\n");
  }
  if (cmd.kind === "release") {
    const r = await releaseQuarantined(repo, cmd);
    if (!r.ok) throw new Error(`refused (${r.code}): ${r.reason}`);
    return `Released ${r.messageId} as ${r.businessId}'s reply on ${r.jobId} (trust operator_verified; recorded as ${r.resolution.id}, original reason ${r.resolution.original_reason}). The server's next advance reads it as a quote at most; it can't approve, pay or confirm a booking.`;
  }
  const r = await rejectQuarantined(repo, cmd);
  if (!r.ok) throw new Error(`refused (${r.code}): ${r.reason}`);
  return `Rejected ${r.messageId} (recorded as ${r.resolution.id}); it stays unread.`;
}

async function main(argv = process.argv.slice(2)) {
  const cmd = planQuarantine(argv);
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set (the engine database)");
  const schema = process.env.HAGGLE_DB_SCHEMA?.trim();
  const repo = new PostgresRepository(url, { max: 1, ...(schema ? { schema } : {}) });
  try {
    console.log(await runQuarantine(repo, cmd));
  } finally {
    await repo.close();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/quarantine.ts")) {
  main().catch((e) => {
    console.error(`quarantine failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
