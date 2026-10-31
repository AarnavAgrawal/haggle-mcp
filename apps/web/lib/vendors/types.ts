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
  /** Its published opening hours, when it was added from a listing that has them. */
  hours?: string[];
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
  /** Addresses the business publishes (its listing's, then its own website's; public: adding one still needs the user's attestation). */
  emails?: string[];
  /** "Open today 9am–5pm" in the business's timezone, when its hours are known. */
  hours_today?: string;
  contact_state: string;
  contact_summary: string;
}

export interface DiscoverResult {
  ok: true;
  mode: "mock" | "live";
  status: string;
  message: string;
  found: FoundBusiness[];
  /** The listing provider's attribution, shown under the results ("Amazon Location Service (data © HERE)"). */
  attribution?: string;
}
