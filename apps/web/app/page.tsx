import { redirect } from "next/navigation";
import { membership, sessionUser } from "@/lib/workspace";

/** Home: signed out → /login; no workspace yet → /onboarding; otherwise the deals. */
export default async function Home() {
  const user = await sessionUser();
  if (!user) redirect("/login");
  redirect((await membership(user.id)) ? "/deals" : "/onboarding");
}
