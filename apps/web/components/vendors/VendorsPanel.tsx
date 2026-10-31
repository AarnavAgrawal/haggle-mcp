"use client";
// The vendors page's live part: the header with "Add a vendor", Find businesses (search + results),
// and the vendors table. The server page is the source of truth: after a change the page re-renders
// (router.refresh in a transition), and until the fresh list arrives the change shows optimistically
// (an added vendor appears at the top, a removed one disappears).
import { useRouter } from "next/navigation";
import { useCallback, useOptimistic, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/Sheet";
import { applyVendorChange, canonName } from "@/lib/vendors/present";
import type { FoundBusiness, VendorList, VendorView } from "@/lib/vendors/types";
import { AddVendorForm, type VendorPrefill } from "./AddVendorForm";
import { FindBusinesses } from "./FindBusinesses";
import { VendorTable } from "./VendorTable";

export function VendorsPanel({ list, canAdd, cantAddReason }: { list: VendorList; canAdd: boolean; cantAddReason?: string }) {
  const router = useRouter();
  const [vendors, change] = useOptimistic(list.vendors, applyVendorChange);
  const [, startRefresh] = useTransition();
  const [adding, setAdding] = useState(false);
  const [prefill, setPrefill] = useState<VendorPrefill | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listHeadRef = useRef<HTMLHeadingElement>(null);

  const left = Math.max(0, list.limits.adds_per_day - list.limits.added_today);
  const full = list.vendors.length >= list.limits.max_vendors;
  const addBlocked = !canAdd ? cantAddReason ?? "You can't add vendors from this account." : full ? `You have the most vendors a workspace can have (${list.limits.max_vendors}). Remove one to add another.` : left === 0 ? "You've added as many vendors as you can today. Add more tomorrow." : null;

  const known = new Set(vendors.map((v) => canonName(v.name)));

  // A blank form keeps its draft between openings, until a vendor is added from it.
  // (Remounted on the next opening, not on close, so the closing drawer doesn't flash an empty form.)
  const [blankKey, setBlankKey] = useState(0);
  const usedForm = useRef(false);
  const openBlank = () => {
    if (usedForm.current || prefill) {
      usedForm.current = false;
      setBlankKey((k) => k + 1);
    }
    setPrefill(null);
    setAdding(true);
  };
  const openFor = (b: FoundBusiness) => {
    const email = b.emails?.[0];
    setPrefill({
      key: Date.now(),
      name: b.name,
      business_ref: b.business_ref,
      ...(email ? { contact: email } : {}),
      consent_basis: "public_listing_email",
      note: `Found in public listings${email ? `; email ${email} published by the business` : ""}`,
    });
    setAdding(true);
  };

  // Once the server has added or removed a vendor the outcome is certain: show it now (optimistic,
  // inside a transition) and re-render the page; the optimistic list holds until the fresh one arrives.
  const onAdded = useCallback(
    (vendor: VendorView, next: string) => {
      setAdding(false);
      usedForm.current = true;
      setFresh(vendor.contact);
      setNotice(`${vendor.name} added. ${next}`);
      startRefresh(() => {
        change({ type: "add", vendor });
        router.refresh();
      });
    },
    [change, router],
  );
  const onRemoved = useCallback(
    (v: VendorView) => {
      setNotice(`${v.name} removed. Haggle won't contact it on new deals.`);
      startRefresh(() => {
        change({ type: "remove", contact: v.contact });
        router.refresh();
      });
      // Its row (and the focused button in it) is gone: keep keyboard focus in the list.
      requestAnimationFrame(() => listHeadRef.current?.focus());
    },
    [change, router],
  );

  return (
    <>
      <header className="vend-head">
        <h1>Vendors</h1>
        {addBlocked ? null : (
          <Button variant="primary" onClick={openBlank}>
            <Icon name="plus" />
            Add a vendor
          </Button>
        )}
      </header>

      <FindBusinesses inputRef={searchRef} isVendor={(name) => known.has(canonName(name))} canAdd={!addBlocked} onAdd={openFor} onAddBlank={openBlank} />

      <section className="vend-section" aria-labelledby="vend-list-h">
        <div className="vend-section-head">
          <h2 id="vend-list-h" ref={listHeadRef} tabIndex={-1}>
            Your vendors {vendors.length ? <span className="vend-count num">{vendors.length}</span> : null}
          </h2>
          {addBlocked && canAdd ? <p className="vend-limit">{addBlocked}</p> : null}
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {notice ?? ""}
        </p>
        {!canAdd ? <p className="note vend-note">{cantAddReason}</p> : null}
        {vendors.length ? (
          <VendorTable vendors={vendors} fresh={fresh} onRemoved={onRemoved} />
        ) : (
          <EmptyState
            className="vend-empty"
            headingLevel={3}
            title="No vendors yet"
            action={
              <>
                <Button variant="primary" onClick={() => searchRef.current?.focus()}>
                  <Icon name="search" />
                  Find businesses near you
                </Button>
                {addBlocked ? null : <Button onClick={openBlank}>Add one you already use</Button>}
              </>
            }
          >
            Haggle asks only the businesses you add here for quotes.
          </EmptyState>
        )}
      </section>

      {addBlocked ? null : (
        <Drawer open={adding} onClose={() => setAdding(false)} label="Add a vendor" title="Add a vendor" side="right" width="min(480px, 100vw)" className="vend-drawer">
          <AddVendorForm key={prefill?.key ?? `blank-${blankKey}`} open={adding} prefill={prefill} left={left} onAdded={onAdded} onCancel={() => setAdding(false)} />
        </Drawer>
      )}
    </>
  );
}
