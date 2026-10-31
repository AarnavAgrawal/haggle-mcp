// The signed-in app: one shell (rail + content) that persists across client navigations between
// /chat, /deals, /vendors, /settings and /account. The session check runs here too (requireHaggle is
// cached per request, so the page's own check reuses it): a signed-out visitor is redirected before
// anything renders. The rail's deals list streams in behind <Suspense>.
import type { ReactNode } from "react";
import { DemoBanner } from "@/components/DemoBanner";
import { AppShell } from "@/components/shell/AppShell";
import { Rail } from "@/components/shell/Rail";
import { requireHaggle } from "@/lib/workspace";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user } = await requireHaggle();
  return (
    <AppShell banner={<DemoBanner />} rail={<Rail email={user.email} guest={user.is_anonymous} />}>
      {children}
    </AppShell>
  );
}
