// /vendors: the businesses this workspace may contact, each with the consent it rests on; add one
// (with an attestation), remove one, or find businesses in public listings. Haggle contacts only these.
// The list is read here on the server; after a change the panel re-renders this page (router.refresh).
import { RetryButton } from "@/components/shell/RetryButton";
import { VendorsPanel } from "@/components/vendors/VendorsPanel";
import { DEMO } from "@/lib/demo";
import { callService, HaggleError } from "@/lib/haggle";
import { vendorServiceConfig } from "@/lib/vendors/deps";
import type { VendorList } from "@/lib/vendors/types";
import { requireHaggle } from "@/lib/workspace";
import "@/components/vendors/vendors.css";

export const dynamic = "force-dynamic";

export default async function VendorsPage() {
  const { user, workspaceId } = await requireHaggle();
  let list: VendorList | null = null;
  let error: { message: string; fix: string } | null = null;
  try {
    list = await callService<VendorList>(vendorServiceConfig(), "/internal/vendors", { workspaceId });
  } catch (err) {
    error = err instanceof HaggleError ? { message: err.message, fix: err.fix } : { message: "The Haggle server couldn't be reached.", fix: "Try again in a moment." };
  }
  const guestBlocked = user.is_anonymous === true && !DEMO;

  return (
    <main className="shell vend-page">
      {list ? (
        <VendorsPanel list={list} canAdd={!guestBlocked} cantAddReason="Guest accounts can't add real businesses. Sign in with your email to add the ones you work with." />
      ) : (
        <>
          <header className="vend-head">
            <h1>Vendors</h1>
          </header>
          <div className="ui-sheet vend-error" role="alert">
            <p>
              <strong>Your vendors couldn&apos;t be loaded.</strong> {error?.message} {error?.fix}
            </p>
            <RetryButton />
          </div>
        </>
      )}
    </main>
  );
}
