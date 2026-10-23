// Shapes of the MCP server's /internal/vendors answers (apps/mcp/src/service/vendors.ts) and of the
// discover results this app shows.
import type { ConsentBasis, VendorChannel } from "./form.ts";

export interface VendorView {
  name: string;
  contact: string;
  channel: VendorChannel | "a2a";
  /** `operator_recorded`: added by the operator (workspace-admin), whose consent text is free-form. */
  consent: { basis: ConsentBasis | "operator_recorded"; text: string };
  added_by: string;
  added_at: string;
  contactable: boolean;
  suppressed?: "opt_out" | "bounce";
}

export interface VendorList {
  ok: true;
  mode: "mock" | "live";
  vendors: VendorView[];
  limits: { max_vendors: number; adds_per_day: number; added_today: number };
  next: string;
}

/** One business from public discovery, as this app shows it (plain text; links only http(s)). */
export interface FoundBusiness {
  name: string;
  business_ref: string;
  address?: string;
  rating?: number;
  review_count?: number;
  website?: string;
  maps_url?: string;
  phone_published: boolean;
  contact_state: string;
  contact_summary: string;
}

export interface DiscoverResult {
  ok: true;
  mode: "mock" | "live";
  status: string;
  message: string;
  found: FoundBusiness[];
}
