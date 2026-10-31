"use client";
// The quote sheet's interactive layer (DESIGN.md "Deal board"): which quote is chosen for approval,
// which rows are open, and the approval bar docked under the sheet. The rows' contents are rendered on
// the server and passed in; this only adds the radio, the expand toggle, the one-time flash for a newly
// arrived quote, and the bar. Choosing a quote never approves anything: the bar's Approve opens the
// existing confirm step (components/approval/ApprovalPanel), and only the human's confirm records it.
import { createContext, use, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApprovalPanel } from "@/components/approval/ApprovalPanel";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/components/ui/cx";

/** What the bar needs to know about a choosable quote. */
export interface Choice {
  quoteId: string;
  business: string;
  totalUsd: number;
  depositUsd: number | null;
  /** The approval recorded for this quote, if any (pending, approved, used…). */
  status: string | null;
}

interface SheetState {
  chosen: string | null;
  choose: (quoteId: string) => void;
  /** Quote ids already on screen when the board first rendered (a later one flashes once). */
  seen: Set<string>;
  firstRecommended: string | null;
}

const SheetContext = createContext<SheetState | null>(null);

function useSheet(): SheetState {
  const s = use(SheetContext);
  if (!s) throw new Error("QuoteRow and ApprovalBar render inside <QuoteSheetProvider>.");
  return s;
}

/**
 * Wraps the board's main column. `initial`: the quote chosen when the page opens (the quote an
 * approval exists for, else Haggle's recommendation when it can be approved). `ids`: every quote on the
 * board now; the provider persists across live refreshes, so a quote id it hasn't seen is new.
 */
export function QuoteSheetProvider({ initial, ids, recommended, children }: { initial: string | null; ids: string[]; recommended: string | null; children: ReactNode }) {
  const [picked, setPicked] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(ids);
  const first = useRef(recommended);
  // A choice the board no longer offers falls back to the page's default.
  const chosen = picked !== null && ids.includes(picked) ? picked : initial;
  return (
    <SheetContext value={{ chosen, choose: setPicked, seen: seen.current, firstRecommended: first.current }}>
      {children}
    </SheetContext>
  );
}

export function QuoteRow({
  quoteId,
  business,
  choosable,
  recommended,
  summary,
  price,
  details,
  dim,
}: {
  quoteId: string;
  business: string;
  /** Can be chosen for approval (a radio is shown). */
  choosable: boolean;
  recommended: boolean;
  /** Under the name: channel, must-haves, price check, the recommendation's reason. */
  summary: ReactNode;
  /** The right-hand price block (rendered on the server with the pen marks). */
  price: ReactNode;
  /** The expanded part: items, terms, source, transcript excerpt, link to the conversation. */
  details: ReactNode;
  dim?: boolean;
}) {
  const { chosen, choose, seen, firstRecommended } = useSheet();
  const [open, setOpen] = useState(false);
  const [fresh] = useState(() => !seen.has(quoteId));
  const id = useId();
  useEffect(() => {
    seen.add(quoteId);
  }, [seen, quoteId]);
  const selected = choosable && chosen === quoteId;
  // The pen circles a recommendation that changed while the page was open (not on every page load).
  const draw = recommended && firstRecommended !== quoteId;
  return (
    <li className={cx("qrow", selected && "qrow-chosen", recommended && "qrow-rec", dim && "qrow-dim", open && "qrow-open")} data-fresh={fresh || undefined} data-draw={draw || undefined}>
      <div className="qrow-head">
        <span className="qrow-pick">
          {choosable ? (
            <input
              type="radio"
              name="quote-choice"
              className="qrow-radio"
              checked={selected}
              onChange={() => choose(quoteId)}
              aria-label={`Choose ${business} to approve`}
            />
          ) : null}
        </span>
        <div className="qrow-main">
          <h3 className="qrow-name">
            <button type="button" className="qrow-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
              {business}
            </button>
          </h3>
          {summary}
        </div>
        <div className="qrow-price">{price}</div>
        <span className="qrow-chev" aria-hidden="true">
          <Icon name="chevron-down" size={20} />
        </span>
      </div>
      <div id={id} className="qrow-details" hidden={!open}>
        {details}
      </div>
    </li>
  );
}

/**
 * The approval bar: sticky at the bottom of the main column while the sheet is in view, for the chosen
 * quote. It is the approval panel itself (Approve opens the confirm step; nothing is recorded or paid
 * without the human's confirm), keyed by quote so switching quotes starts fresh.
 */
export function ApprovalBar({ jobId, choices, mode }: { jobId: string; choices: Choice[]; mode: "mock" | "live" }) {
  const { chosen } = useSheet();
  const c = choices.find((x) => x.quoteId === chosen) ?? null;
  if (!c) {
    if (!choices.length) return null;
    return (
      <div className="ap-bar ap-bar-empty">
        <Icon name="check" />
        <span>Choose a quote above to approve it. Nothing is ordered or paid until you approve.</span>
      </div>
    );
  }
  return (
    <ApprovalPanel
      key={c.quoteId}
      jobId={jobId}
      quoteId={c.quoteId}
      business={c.business}
      amountUsd={c.totalUsd}
      depositUsd={c.depositUsd}
      status={c.status}
      mode={mode}
    />
  );
}
