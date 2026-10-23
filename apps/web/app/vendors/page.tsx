// /vendors: the businesses this workspace may contact, each with the consent it rests on; add one
// (with an attestation), remove one, or find businesses in public listings. Haggle contacts only these.
import { TopBar } from "@/components/TopBar";
import { VendorsPanel } from "@/components/vendors/VendorsPanel";
import { DEMO } from "@/lib/demo";
import { callService, HaggleError } from "@/lib/haggle";
import { vendorServiceConfig } from "@/lib/vendors/deps";
import type { VendorList } from "@/lib/vendors/types";
import { requireHaggle } from "@/lib/workspace";
import "@/components/dashboard/dashboard.css";

export const dynamic = "force-dynamic";

export default async function VendorsPage() {
  const { user, workspaceId } = await requireHaggle();
  let list: VendorList | null = null;
  let error: { message: string; fix: string } | null = null;
  try {
    list = await callService<VendorList>(vendorServiceConfig(), "/internal/vendors", { workspaceId });
  } catch (err) {
    error = err instanceof HaggleError ? { message: err.message, fix: err.fix } : { message: "The Haggle server couldn't be reached.", fix: "Reload the page in a moment." };
  }
  const guestBlocked = user.is_anonymous === true && !DEMO;

  return (
    <>
      <TopBar email={user.email} active="vendors" />
      <main className="shell stack">
        <div className="dash-title">
          <h1>Vendors</h1>
          {list?.mode === "mock" ? <span className="chip demo">DEMO: simulated, nothing real is sent</span> : null}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          The businesses Haggle may contact for you, and how each agreed to it. Start a request in the chat and Haggle asks these vendors for quotes.
        </p>
        {!list ? (
          <p className="note note-risk" role="alert">
            {error?.message} <span className="fix">{error?.fix}</span>
          </p>
        ) : (
          <VendorsPanel initial={list} canAdd={!guestBlocked} cantAddReason="Guest accounts can't add real businesses. Sign in with your email to add the businesses you work with." />
        )}
      </main>
    </>
  );
}
