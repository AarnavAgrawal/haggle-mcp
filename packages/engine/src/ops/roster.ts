// A workspace's vendor roster as the operator manages it (sprint 5, workstream B): each vendor is
// added with the consent it rests on, and every add / remove is recorded append-only (migration 119)
// with who, why and when, including the consent a removed vendor had. A deal can contact only the
// vendors on the roster (plus the server allowlist); suppressions (opt-out, bounce) always win.
import type { Channel, OperatorActionRow, Repository, WorkspaceVendorRow } from "../store/types.ts";
import { recordOperatorAction } from "./operator.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;

/** Consent that names who agreed, how and when reads as at least a short sentence. */
export const MIN_CONSENT_CHARS = 10;

/** Why a contact can't be used for a real vendor, or null. */
export function contactProblem(contact: string, channel?: Channel | null): string | null {
  const email = contact.includes("@");
  if (email ? !EMAIL.test(contact) : !E164.test(contact)) return "not an email address or an E.164 phone number";
  if (channel && (channel === "email") !== email) return `channel ${channel} doesn't fit ${email ? "an email address" : "a phone number"}`;
  return null;
}

/**
 * A contact that belongs to no real business: the simulated fleet (*.sim.haggle.dev), reserved
 * test domains (RFC 2606 / 6761: .test, .example, .invalid, .localhost, example.com/net/org),
 * fictional North American numbers (555-0100..0199), or a contact the operator configured as a demo
 * vendor (HAGGLE_DEMO_VENDORS / HAGGLE_DEMO_FLEET). Never acceptable on a live pilot workspace.
 */
export function simulatedContact(contact: string, demoContacts: Iterable<string> = []): string | null {
  const c = contact.trim().toLowerCase();
  for (const d of demoContacts) if (d.trim().toLowerCase() === c) return "configured as a demo vendor (HAGGLE_DEMO_VENDORS / HAGGLE_DEMO_FLEET)";
  if (c.includes("@")) {
    const domain = c.split("@").pop()!;
    if (/(^|\.)sim\.haggle\.dev$/.test(domain)) return "the simulated demo fleet";
    if (/\.(test|example|invalid|localhost)$/.test(domain) || /(^|\.)example\.(com|net|org)$/.test(domain)) return "a reserved test domain";
    return null;
  }
  if (/^\+1\d{3}55501\d{2}$/.test(c)) return "a fictional 555-01xx number";
  return null;
}

export interface RosterAdd { workspaceId: string; contact: string; name: string; consent: string; channel?: Channel | null; by: string }

/** Add (or re-authorize with new consent) one vendor, recorded with the consent it rests on. */
export async function addVendor(repo: Pick<Repository, "addWorkspaceVendor" | "listWorkspaceVendors" | "appendOperatorAction">, v: RosterAdd): Promise<{ row: WorkspaceVendorRow; replaced: WorkspaceVendorRow | null }> {
  const bad = contactProblem(v.contact, v.channel);
  if (bad) throw new Error(`${v.contact}: ${bad}`);
  if (v.consent.trim().length < 3) throw new Error("consent is required: who agreed to be contacted, how and when");
  const replaced = (await repo.listWorkspaceVendors(v.workspaceId)).find((x) => x.contact === v.contact) ?? null;
  const row = await repo.addWorkspaceVendor({ workspace_id: v.workspaceId, contact: v.contact, name: v.name, consent: v.consent, added_by: v.by.slice(0, 120), ...(v.channel ? { channel: v.channel } : {}) });
  await recordOperatorAction(repo, {
    action: "vendor_added", operator: v.by, reason: v.consent, workspaceId: v.workspaceId,
    detail: { contact: v.contact, name: v.name, consent: v.consent, channel: v.channel ?? null, ...(replaced ? { replaced_consent: replaced.consent, replaced_name: replaced.name } : {}) },
  });
  return { row, replaced };
}

/** Remove one vendor; the removed row (with its consent) is kept in the audit log. */
export async function removeVendor(repo: Pick<Repository, "removeWorkspaceVendor" | "listWorkspaceVendors" | "appendOperatorAction">, v: { workspaceId: string; contact: string; by: string; reason: string }): Promise<WorkspaceVendorRow | null> {
  const prior = (await repo.listWorkspaceVendors(v.workspaceId)).find((x) => x.contact === v.contact) ?? null;
  if (!prior || !(await repo.removeWorkspaceVendor(v.workspaceId, v.contact))) return null;
  await recordOperatorAction(repo, { action: "vendor_removed", operator: v.by, reason: v.reason, workspaceId: v.workspaceId, detail: { contact: prior.contact, name: prior.name, consent: prior.consent, channel: prior.channel ?? null, added_by: prior.added_by, added_at: prior.created_at } });
  return prior;
}

/** The roster's change history, newest first. */
export async function rosterHistory(repo: Pick<Repository, "listOperatorActions">, workspaceId: string, limit = 200): Promise<OperatorActionRow[]> {
  return repo.listOperatorActions ? repo.listOperatorActions({ workspaceId, actions: ["vendor_added", "vendor_removed"], limit }) : [];
}

export interface VendorAssessment { vendor: WorkspaceVendorRow; usable: boolean; problems: string[] }

/**
 * Can each roster vendor be contacted on a real pilot deal? Usable = a valid contact that fits its
 * channel, consent of at least a short sentence, not suppressed, and (on a live workspace) not simulated.
 */
export function assessRoster(vendors: WorkspaceVendorRow[], o: { suppressed: Set<string>; live: boolean; demoContacts?: Iterable<string> }): VendorAssessment[] {
  const demo = [...(o.demoContacts ?? [])];
  return vendors.map((v) => {
    const problems = [
      contactProblem(v.contact, v.channel),
      v.consent.trim().length < MIN_CONSENT_CHARS ? `consent "${v.consent.trim()}" doesn't say who agreed, how and when` : null,
      o.suppressed.has(v.contact) ? "suppressed (opted out or bounced): never contacted" : null,
      o.live ? (() => { const s = simulatedContact(v.contact, demo); return s ? `simulated contact (${s})` : null; })() : null,
    ].filter((p): p is string => !!p);
    return { vendor: v, usable: problems.length === 0, problems };
  });
}
