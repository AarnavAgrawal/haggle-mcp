// Who may get a workspace. Sign-in stays open, so someone waiting can sign in and be told where they
// stand; the gate is at workspace creation (onboard() in lib/workspace.ts), the only self-serve way to one.
// Existing members are never checked. A demo site is simulated, so it has no gate. A failed lookup throws
// rather than answering, so a database problem can never read as "admitted".
import { DEMO } from "../demo.ts";

export type Admission = "member" | "admitted" | "waiting" | "none";

export interface AdmissionDeps {
  isMember(userId: string): Promise<boolean>;
  /** The waitlist entry for a lowercase email, or null. Throws when the lookup fails. */
  lookup(email: string): Promise<{ admitted: boolean } | null>;
}

export async function admissionState(user: { id: string; email?: string }, deps: AdmissionDeps, demo = DEMO): Promise<Admission> {
  if (demo) return "admitted";
  if (await deps.isMember(user.id)) return "member";
  if (!user.email) return "none";
  const entry = await deps.lookup(user.email.toLowerCase());
  if (!entry) return "none";
  return entry.admitted ? "admitted" : "waiting";
}

export const mayProvision = (state: Admission) => state === "member" || state === "admitted";

/** onboard() refused: this person hasn't been admitted. */
export class NotAdmittedError extends Error {
  constructor() {
    super("This account hasn't been admitted from the waitlist yet.");
    this.name = "NotAdmittedError";
  }
}
