"use client";
// A table's view, filters and sort, kept in the URL so a view can be reloaded, shared or returned to.
// replaceState, not a navigation: the rows are already here, so changing a filter is instant.
//
// Next keeps this client state across a navigation that only changes search params, so a link to the
// same page (the rail's Deals, "3 more") would change the URL and leave the old filters on screen. The
// URL is the truth: when it stops matching, the table follows it. That is read from window.location,
// not from the render's params, because a background refresh can land with params a keystroke old,
// and following those would undo what was just typed. Remounting instead would lose the selection and
// the search box's focus on every refresh.
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { readQuery } from "@/lib/dashboard/ledger";

export function useTableQuery<T extends Record<string, string>>(initial: T, defaults: T, choices: Partial<Record<keyof T, readonly string[]>>): [T, (patch: Partial<T>) => void] {
  const [state, setState] = useState(initial);
  const params = useSearchParams();

  useEffect(() => {
    const fromUrl = readQuery(Object.fromEntries(new URLSearchParams(window.location.search)), defaults, choices);
    setState((s) => (Object.keys(defaults).every((k) => s[k] === fromUrl[k]) ? s : fromUrl));
  }, [params, defaults, choices]);

  const set = useCallback(
    (patch: Partial<T>) => {
      const next = { ...state, ...patch };
      setState(next);
      const url = new URL(window.location.href);
      for (const key of Object.keys(defaults)) {
        const value = next[key];
        if (value && value !== defaults[key]) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
      }
      // Safari caps replaceState calls; the table still works if a fast typist reaches the cap.
      try {
        window.history.replaceState(null, "", url);
      } catch { /* the URL just lags a moment */ }
    },
    [state, defaults],
  );
  return [state, set];
}

/** Saves text as a file, from the browser: nothing is sent anywhere. */
export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
