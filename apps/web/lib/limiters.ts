// Server only. The web app's rate limits, shared by every instance through the database (take_rate_slot,
// migration 124, called with the service-role client). Imported only by route handlers and route
// dependency modules, never by a client component. Each falls back to a per-instance memory count
// while the database can't answer (lib/rateLimit.ts). Bucket names are the rows' `bucket` column.
import { DAY_S, dailyCap, TURN_LIMIT, TURN_WINDOW_S } from "@/lib/chat/limits";
import { durableLimiter, type RpcClient } from "@/lib/rateLimit";
import { supabaseAdmin } from "@/lib/supabase/admin";

let admin: RpcClient | null = null;
/** One service-role client per instance, made at the first take (so a build never needs the key). */
const client = (): RpcClient => (admin ??= supabaseAdmin() as unknown as RpcClient);
const shared = (bucket: string, max: number, windowS: number) => durableLimiter(bucket, max, windowS, client);

export const limiters = {
  /** Chat: 20 turns per user per 10 minutes. */
  chatTurns: shared("web_chat_turns", TURN_LIMIT, TURN_WINDOW_S),
  /** Chat: WEB_CHAT_DAILY_CAP turns per UTC day across the site (key "site"; unset or 0 = no cap). */
  chatDaily: dailyCap(Number(process.env.WEB_CHAT_DAILY_CAP ?? "0"), (max) => shared("web_chat_daily", max, DAY_S)),
  /** Approve / pay / callback / purchase clicks: 30 per user per minute. */
  approval: shared("web_approval_actions", 30, 60),
  /** Vendor adds and removals: 20 per user per minute; vendor searches: 10. */
  vendorWrites: shared("web_vendor_writes", 20, 60),
  vendorDiscover: shared("web_vendor_discover", 10, 60),
  /** Account deletion: 3 attempts per user per 10 minutes; data export: 5. */
  accountDelete: shared("web_account_delete", 3, 600),
  accountExport: shared("web_account_export", 5, 600),
};
