// When a deal started nothing because the workspace has no vendor Haggle may contact, the web app
// shows "Add vendors first" with a link to /vendors (for the chat's deal card, or a deal page).
// Reads the deal tool's answer: structuredContent (job null, setup.ready 0) and its text.

export interface VendorSetupHint {
  href: "/vendors";
  label: "Add vendors first";
  reason: string;
}

type DealAnswer = { ok?: unknown; job?: unknown; setup?: { ready?: unknown; total?: unknown; blockers?: unknown } | null; dry_run?: unknown; would_contact?: unknown };

export function vendorSetupHint(data: DealAnswer | null | undefined, text = ""): VendorSetupHint | null {
  if (!data || data.job) return null;
  const noOwnVendors = /has no vendors of its own yet/i.test(text);
  const nothingReady = !!data.setup && data.setup.ready === 0;
  const dryRunNobody = data.dry_run === true && Array.isArray(data.would_contact) && data.would_contact.length === 0;
  if (!noOwnVendors && !nothingReady && !dryRunNobody) return null;
  return {
    href: "/vendors", label: "Add vendors first",
    reason: noOwnVendors || data.setup?.total === 0
      ? "This workspace has no vendors yet. Add the businesses you work with, and how each agreed to be contacted; then start the request again."
      : "None of this workspace's vendors can be contacted right now. Check them on the Vendors page, or add others.",
  };
}
