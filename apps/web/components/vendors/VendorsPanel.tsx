"use client";
// The vendors page's live part: the list, "Add vendor" and "Find businesses". After a change it
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
      <section className="card stack" aria-labelledby="list-h">
        <div className="dash-head">
          <h2 id="list-h" className="dash-h2" style={{ margin: 0 }}>
            Your vendors ({list.vendors.length} of {list.limits.max_vendors})
          </h2>
          <span className="hint">{left} more can be added today</span>
        </div>
        {status ? (
          <p className="note" role="status" style={{ margin: 0 }}>
            {status}
          </p>
        ) : null}
        <VendorTable vendors={list.vendors} onChanged={refresh} />
      </section>

      {canAdd ? (
        <AddVendorForm prefill={prefill} onAdded={refresh} />
      ) : (
        <p className="note" style={{ margin: 0 }}>
          {cantAddReason}
        </p>
      )}

      <FindBusinesses
        vendorNames={list.vendors.map((v) => v.name)}
        onAdd={(b) => setPrefill({ key: Date.now(), name: b.name, consent_basis: "public_listing_email", note: `Found in public listings${b.website ? `; email from ${b.website}` : ""}` })}
      />
    </>
  );
}
