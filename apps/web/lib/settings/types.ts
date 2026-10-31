// What /api/settings returns: the MCP server's view of the owner's settings (GET /internal/workspaces/settings).

export interface PendingApprover {
  kind: "phone" | "email";
  /** The new contact, masked. */
  to: string;
  expires_at: string;
  attempts_left: number;
}

export interface WorkspaceSettings {
  name: string;
  timezone: string;
  sender_name: string | null;
  default_area: string | null;
  default_deal_limit_usd: number;
  ceiling_usd: number;
  /** Masked. */
  approver: { phone: string | null; email: string | null };
  pending: PendingApprover[];
}

export interface SettingsSaved {
  ok: true;
  mode: "mock" | "live";
  settings: WorkspaceSettings;
  changed: string[];
  pending_verification: ("phone" | "email")[];
  /** Demo site only (mock server): nothing was sent, so the code is shown instead. */
  demo_codes?: { kind: "phone" | "email"; code: string }[];
  next: string;
}
