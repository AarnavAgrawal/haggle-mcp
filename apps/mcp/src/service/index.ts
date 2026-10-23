// The web app's service-only routes, registered once from apps/mcp/index.ts. Each area keeps its own file.
import { registerAccountRoutes } from "./account.ts";
import { registerApprovalRoutes } from "./approvals.ts";
import type { ServiceApp } from "./http.ts";
import { registerVendorRoutes } from "./vendors.ts";
import { registerWorkspaceRoutes } from "./workspaces.ts";

export function registerServiceRoutes(app: ServiceApp) {
  registerWorkspaceRoutes(app);
  registerApprovalRoutes(app);
  registerVendorRoutes(app);
  registerAccountRoutes(app);
}
