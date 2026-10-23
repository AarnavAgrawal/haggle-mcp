// Who may use the app at all. Guests (Supabase anonymous sign-in) exist for the public demo only: on a
// live site (real businesses, real calls) every user signs in with an email, so there is someone to
// hold to the Terms and to reach. lib/workspace.ts applies this to every page and API route.
import type { User } from "@supabase/supabase-js";
import { DEMO } from "../demo.ts";

/** A signed-in user allowed in: anyone on a demo site; on a live site, only non-anonymous users. */
export const isAllowedUser = (user: Pick<User, "is_anonymous">, demo = DEMO) => demo || user.is_anonymous !== true;

/** Where a refused guest is sent: /login shows a note for this flag. */
export const GUEST_REFUSED_PATH = "/login?guest=off";
