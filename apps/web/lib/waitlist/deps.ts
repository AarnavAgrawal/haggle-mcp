// The real dependencies of POST /api/waitlist. Server only.
import { after } from "next/server";
import { limiters } from "@/lib/limiters";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { WaitlistDeps } from "./route.ts";
import { postJoin } from "./slack.ts";

export const waitlistDeps: WaitlistDeps = {
  async insert(row) {
    const { data, error } = await supabaseAdmin().from("web_waitlist").upsert(row, { onConflict: "email", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`couldn't add to the waitlist: ${error.message}`);
    return (data?.length ?? 0) > 0;
  },
  ipLimiter: limiters.waitlistJoin,
  dailyLimiter: limiters.waitlistDaily,
  announce: (row) => postJoin(process.env.WAITLIST_SLACK_WEBHOOK_URL?.trim() || undefined, row),
  defer: (task) => after(task),
};
