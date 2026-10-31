// A mailbox per workspace (HAGGLE_MAILBOX_PER_WORKSPACE, off by default; migration 126).
//
// Each workspace gets its own Inkbox agent identity (a mailbox, no phone), provisioned lazily on its
// first live deal: the deal's email goes out from it (jobs.inbox) and vendors' replies come back to it,
// so one user's vendor mail never shares a mailbox with another user's. Phone, iMessage, voice and
// mail to the approver stay on the shared buyer identity.
//
// Provisioning: claim a row (workspace_identities, 'provisioning'; atomic across processes) -> create
// the identity (handle derived from the workspace id, globally unique at Inkbox; on a collision with an
// identity this org can read, a crashed earlier attempt, it is adopted, otherwise the next handle is
// tried) -> subscribe its webhook to <base>/webhooks/inkbox/<handle> for mail events and store the
// signing key Inkbox returns once (or a freshly rotated one) -> 'active'. Any failure marks the row
// 'failed' (retried after retryFailedAfterMs) and the deal uses the shared mailbox: provisioning never
// blocks a deal. One provisioning per workspace at a time in this process (single flight).
import { createHash } from "node:crypto";
import { Inkbox } from "@inkbox/sdk";
import type { Repository, WorkspaceIdentityRow } from "../store/types.ts";

/** The slice of an org-level (admin) Inkbox client provisioning needs, so tests can fake it. */
export interface InkboxAdminApi {
  createIdentity(handle: string): Promise<{ id: string; emailAddress: string | null }>;
  /** The identity with this handle when this org can read it; null when it doesn't exist or isn't ours. */
  getIdentity(handle: string): Promise<{ id: string; emailAddress: string | null } | null>;
  subscribe(o: { identityId: string; url: string; eventTypes: string[] }): Promise<{ signingKey: string | null }>;
  /** Mint (or rotate) the identity's webhook signing key; the plaintext is returned once. */
  rotateSigningKey(handle: string): Promise<string>;
}

/** The mail events a workspace identity's webhook carries (calls and texts stay on the shared identity). */
export const WORKSPACE_MAIL_EVENTS = ["message.received", "message.bounced", "message.failed"] as const;

/** "hg-acme-labs-3f9a1c" (+ "-2", "-3" on a collision): lower-case, [a-z0-9-], at most 40 characters. */
export function workspaceHandle(workspaceId: string, attempt = 0, prefix = "hg"): string {
  const slug = workspaceId.toLowerCase().replace(/^ws_/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "") || "ws";
  const hash = createHash("sha256").update(workspaceId).digest("hex").slice(0, 6);
  return `${prefix}-${slug}-${hash}${attempt > 0 ? `-${attempt + 1}` : ""}`.slice(0, 40);
}

/** An Inkbox "handle already taken" (409), whatever wraps it. */
function handleTaken(e: unknown): boolean {
  const status = (e as { statusCode?: number; status?: number })?.statusCode ?? (e as { status?: number })?.status;
  return status === 409 || (e as { name?: string })?.name === "HandleUnavailableError";
}

/** Never let a key or a long provider body into the stored error. */
const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>").slice(0, 300);

export interface WorkspaceMailboxDeps {
  repo: Pick<Repository, "getWorkspaceIdentity" | "findWorkspaceIdentity" | "listWorkspaceIdentities" | "claimWorkspaceIdentity" | "updateWorkspaceIdentity">;
  admin: InkboxAdminApi;
  /** The public base URL of this server (https://…); the webhook goes to <base>/webhooks/inkbox/<handle>. */
  webhookBaseUrl: string;
  sharedMailbox: string;
  log?: (event: string, data: Record<string, unknown>) => void;
  now?: () => Date;
  /** A failed provisioning is tried again after this long (default 10 min). */
  retryFailedAfterMs?: number;
  handlePrefix?: string;
}

export class WorkspaceMailboxes {
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly d: WorkspaceMailboxDeps;
  constructor(d: WorkspaceMailboxDeps) {
    this.d = d;
  }

  private log(event: string, data: Record<string, unknown>) {
    this.d.log?.(event, data);
  }

  /** The workspace's active mailbox, provisioning it on first use; null = use the shared mailbox. */
  async inboxFor(workspaceId: string): Promise<string | null> {
    const row = await this.d.repo.getWorkspaceIdentity(workspaceId);
    if (row?.status === "active" && row.mailbox) return row.mailbox;
    const running = this.inflight.get(workspaceId);
    if (running) return running;
    const p = this.provision(workspaceId).finally(() => this.inflight.delete(workspaceId));
    this.inflight.set(workspaceId, p);
    return p;
  }

  /** An active workspace identity by its webhook handle (the route's path segment). */
  async byHandle(handle: string): Promise<WorkspaceIdentityRow | null> {
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(handle)) return null;
    const row = await this.d.repo.findWorkspaceIdentity({ handle });
    return row?.status === "active" ? row : null;
  }

  /** Every active workspace mailbox (the reconciler sweeps each). */
  async mailboxes(): Promise<WorkspaceIdentityRow[]> {
    return (await this.d.repo.listWorkspaceIdentities()).filter((r) => r.status === "active" && !!r.mailbox);
  }

  /** The shared mailbox or an active workspace mailbox: the only addresses Haggle sends mail from. */
  async isOurs(address: string): Promise<boolean> {
    const a = address.trim().toLowerCase();
    if (a === this.d.sharedMailbox.toLowerCase()) return true;
    const row = await this.d.repo.findWorkspaceIdentity({ mailbox: a });
    return row?.status === "active";
  }

  private async provision(workspaceId: string): Promise<string | null> {
    const now = (this.d.now ?? (() => new Date()))();
    const retryBefore = new Date(now.getTime() - (this.d.retryFailedAfterMs ?? 10 * 60_000)).toISOString();
    const claim = await this.d.repo.claimWorkspaceIdentity(workspaceId, workspaceHandle(workspaceId, 0, this.d.handlePrefix), retryBefore);
    if (!claim.claimed) {
      // Another process holds the claim (or it failed recently): the shared mailbox for this deal.
      return claim.row.status === "active" ? claim.row.mailbox : null;
    }
    let handle = claim.row.handle;
    try {
      let identity: { id: string; emailAddress: string | null } | null = null;
      for (let attempt = 0; attempt < 4 && !identity; attempt++) {
        try {
          identity = await this.d.admin.createIdentity(handle);
        } catch (e) {
          if (!handleTaken(e)) throw e;
          // Ours already (an earlier attempt crashed after creating it)? Adopt it. Otherwise the next handle.
          const existing = attempt === 0 ? await this.d.admin.getIdentity(handle).catch(() => null) : null;
          if (existing) {
            identity = existing;
            break;
          }
          handle = workspaceHandle(workspaceId, attempt + 1, this.d.handlePrefix);
          await this.d.repo.updateWorkspaceIdentity(workspaceId, { handle });
        }
      }
      if (!identity) throw new Error("no free identity handle");
      const mailbox = identity.emailAddress?.trim().toLowerCase();
      if (!mailbox) throw new Error("the new identity has no mailbox");
      await this.d.repo.updateWorkspaceIdentity(workspaceId, { identity_id: identity.id, mailbox });
      const url = `${this.d.webhookBaseUrl.replace(/\/+$/, "")}/webhooks/inkbox/${handle}`;
      const sub = await this.d.admin.subscribe({ identityId: identity.id, url, eventTypes: [...WORKSPACE_MAIL_EVENTS] });
      // Inkbox returns the signing key only for an identity's first subscription: otherwise mint one.
      const key = sub.signingKey ?? (await this.d.admin.rotateSigningKey(handle));
      if (!key || key.length < 16) throw new Error("no webhook signing key for the new identity");
      await this.d.repo.updateWorkspaceIdentity(workspaceId, { webhook_secret: key, status: "active", error: null });
      this.log("workspace_mailbox_provisioned", { workspace_id: workspaceId, handle, mailbox });
      return mailbox;
    } catch (e) {
      const error = errorText(e);
      await this.d.repo.updateWorkspaceIdentity(workspaceId, { status: "failed", error }).catch(() => {});
      this.log("workspace_mailbox_failed", { workspace_id: workspaceId, handle, error });
      return null;
    }
  }
}

/** InkboxAdminApi over the SDK with an org-level (admin) API key (INKBOX_ADMIN_API_KEY). */
export function inkboxAdminApi(apiKey: string): InkboxAdminApi {
  const inkbox = new Inkbox({ apiKey });
  const pick = (i: { id: string; emailAddress: string | null }) => ({ id: i.id, emailAddress: i.emailAddress });
  return {
    createIdentity: async (handle) => pick(await inkbox.createIdentity(handle)),
    getIdentity: async (handle) => {
      try {
        return pick(await inkbox.getIdentity(handle));
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 403 || status === 404) return null;
        throw e;
      }
    },
    subscribe: async (o) => {
      const r = await inkbox.webhooks.subscriptions.create({ agentIdentityId: o.identityId, url: o.url, eventTypes: o.eventTypes });
      return { signingKey: r.signingKey ?? null };
    },
    rotateSigningKey: async (handle) => (await inkbox.signingKeys.createOrRotate(handle)).signingKey,
  };
}
