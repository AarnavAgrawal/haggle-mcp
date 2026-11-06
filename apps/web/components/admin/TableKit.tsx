"use client";
// The ledger tables' shared controls (DESIGN.md "The ledger pages"): views as tabs with counts, search,
// a filter select, sortable headers and CSV export.
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Icon, channelIcon } from "@/components/ui/Icon";
import { PenUnderline } from "@/components/ui/PenMarks";
import { channelWords } from "@/lib/dashboard/format";
import type { SortDir } from "@/lib/dashboard/ledger";
import { downloadCsv } from "./tableState";

export function ViewTabs<K extends string>({ views, value, onChange, label }: { views: { key: K; label: string; count: number }[]; value: K; onChange: (key: K) => void; label: string }) {
  return (
    <div className="adm-tabs" role="group" aria-label={label}>
      {views.map((v) => (
        <button key={v.key} type="button" className="adm-tab" aria-pressed={v.key === value} onClick={() => onChange(v.key)}>
          <span className="adm-tab-label">
            {v.label}
            {v.key === value ? <PenUnderline /> : null}
          </span>
          <span className="adm-tab-count">{v.count}</span>
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) {
  return (
    <div className="adm-search">
      <Icon name="search" />
      <input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function SelectFilter({ value, onChange, label, all, options }: { value: string; onChange: (v: string) => void; label: string; all: string; options: { value: string; label: string }[] }) {
  return (
    <select className="adm-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{all}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Sorting where the table's header isn't shown (phones): the same order, as a select. */
export function SortSelect<K extends string>({ sort, dir, options, onSort }: { sort: K; dir: SortDir; options: { sort: K; dir: SortDir; label: string }[]; onSort: (column: K, dir: SortDir) => void }) {
  return (
    <select
      className="adm-select adm-sort-select"
      aria-label="Sort by"
      value={`${sort}:${dir}`}
      onChange={(e) => {
        const o = options.find((x) => `${x.sort}:${x.dir}` === e.target.value);
        if (o) onSort(o.sort, o.dir);
      }}
    >
      {/* The order the header set may not be one of these; it still needs to show. */}
      {options.some((o) => o.sort === sort && o.dir === dir) ? null : <option value={`${sort}:${dir}`}>Custom order</option>}
      {options.map((o) => (
        <option key={`${o.sort}:${o.dir}`} value={`${o.sort}:${o.dir}`}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A column header that sorts: the first click on a new column uses its natural direction. */
export function SortTh<K extends string>({ label, column, sort, dir, first = "asc", onSort, className }: { label: string; column: K; sort: K; dir: SortDir; first?: SortDir; onSort: (column: K, dir: SortDir) => void; className?: string }) {
  const active = sort === column;
  return (
    <th scope="col" className={className} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" className="adm-sort" data-active={active || undefined} onClick={() => onSort(column, active ? (dir === "asc" ? "desc" : "asc") : first)}>
        {label}
        <Icon name="chevron-down" size={16} className={active && dir === "asc" ? "adm-sort-up" : undefined} />
      </button>
    </th>
  );
}

export function ExportButton({ filename, build, disabled }: { filename: string; build: () => string; disabled?: boolean }) {
  return (
    <Button disabled={disabled} onClick={() => downloadCsv(filename, build())}>
      Export CSV
    </Button>
  );
}

/** A channel as an icon and a word. */
export function Via({ channel }: { channel: string }) {
  return (
    <span className="via">
      <Icon name={channelIcon(channel)} />
      {channelWords(channel)}
    </span>
  );
}

/** Shown when filters leave nothing, with the way back. */
export function NoMatches({ children, onClear }: { children: ReactNode; onClear: () => void }) {
  return (
    <div className="adm-nomatch">
      <p>{children}</p>
      <Button size="s" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}
