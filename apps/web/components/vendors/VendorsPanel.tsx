"use client";
// The vendors page's live part: the list, "Find businesses" and "Add vendor". After a change it
// re-reads the list from /api/vendors (the MCP server is the source of truth).
import { useState } from "react";
import type { VendorList } from "@/lib/vendors/types";
import { AddVendorForm, type VendorPrefill } from "./AddVendorForm";
import { FindBusinesses } from "./FindBusinesses";
import { VendorTable } from "./VendorTable";
import { vendorApi } from "./api";
import "./vendors.css";

export function VendorsPanel({ initial, canAdd, cantAddReason }: { initial: VendorList; canAdd: boolean; cantAddReason?: string }) {
  const [list, setList] = useState(initial);
  const [status, setStatus] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<VendorPrefill | null>(null);

  async function refresh(message: string) {
    setStatus(message);
    const r = await vendorApi<Omit<VendorList, "ok">>("/api/vendors");
    if (r.ok) setList({ ...r, ok: true });
    else setStatus(`${message} (Couldn't reload the list: ${r.error.message} ${r.error.fix})`);
  }

  const left = Math.max(0, list.limits.adds_per_day - list.limits.added_today);
  return (
    <>
      <section className="section" aria-labelledby="list-h">
        <div className="section-head">
          <h2 id="list-h">
            Your vendors <span className="muted num">{list.vendors.length}</span>
          </h2>
          <p>
            Up to {list.limits.max_vendors}. {left} more can be added today.
          </p>
        </div>
        {status ? (
          <p className="note vend-status" role="status">
            {status}
          </p>
        ) : null}
        <VendorTable vendors={list.vendors} onChanged={refresh} />
      </section>

      <FindBusinesses
        vendorNames={list.vendors.map((v) => v.name)}
        onAdd={(b) => setPrefill({ key: Date.now(), name: b.name, ...(b.emails?.[0] ? { contact: b.emails[0] } : {}), consent_basis: "public_listing_email", note: `Found in public listings${b.website ? `; email from ${b.website}` : ""}` })}
      />

      {canAdd ? (
        <AddVendorForm prefill={prefill} onAdded={refresh} />
      ) : (
        <section className="section">
          <p className="note">{cantAddReason}</p>
        </section>
      )}
    </>
  );
}
