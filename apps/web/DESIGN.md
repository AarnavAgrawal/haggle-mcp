# Haggle web: design direction

The source of truth for how apps/web looks, moves and feels. Every UI change follows it; change this
file first if the direction changes.

## The idea: a marked-up quote

Haggle is a sharp buyer working the phones for you. The most characteristic artifact of that world is a
printed quote someone has marked up: the old price struck through in ballpoint, the winner circled, the
saving run over with a highlighter. The interface is the clean printed sheet; Haggle's work shows up as
**pen marks with meaning**:

| Mark | Means | Where |
| --- | --- | --- |
| Hand-drawn strike (pen blue) | a price that was superseded by negotiation | `$1,380` → `$1,240` |
| Hand-drawn circle (pen blue) | Haggle's recommendation | the recommended quote's total |
| Highlighter swipe (yellow-green) | money saved | `−$140` |
| Hand-drawn underline (pen blue) | where you are | current nav item, active tab |

Marks are SVG paths with slight irregularity (never a font, never emoji). They are the one place the UI
is playful; everything around them is quiet, precise and dense. No mark is decoration: if a marked thing
isn't true (no negotiation, no recommendation), there's no mark.

## Tokens

Colors (light, default). Names describe the role; use the variables, never raw hex in components.

| Token | Hex | Use |
| --- | --- | --- |
| `--desk` | `#EEF0F3` | app background (the desk under the sheets) |
| `--sheet` | `#FFFFFF` | panels, the quote sheet, inputs |
| `--ink` | `#15203A` | primary text, prices |
| `--ink-2` | `#4B556B` | secondary text |
| `--ink-3` | `#7A8296` | hints, meta, placeholders |
| `--rule` / `--rule-strong` | `#DCE0E7` / `#BFC5D1` | hairlines, input borders |
| `--pen` | `#2346D8` | primary action, links, pen marks, focus ring |
| `--pen-wash` | `#E8EDFF` | selected rows, new-item flash |
| `--highlight` | `#E4F53B` | savings only (text on it stays `--ink`) |
| `--signed` / `--signed-wash` | `#0D7A4C` / `#E3F3EA` | approved, meets requirement, paid |
| `--hold` / `--hold-wash` | `#8A5A00` / `#FBF0D9` | needs you, waiting, demo marker |
| `--risk` / `--risk-wash` | `#B42318` / `#FCEBEA` | failed, declined, destructive |

Dark (prefers-color-scheme: dark), equally designed, not inverted: desk `#0C1220`, sheet `#131B2D`,
ink `#E6E9F2`, ink-2 `#AEB5C7`, ink-3 `#7F879C`, rule `#222B40`, rule-strong `#313C56`, pen `#8FA3FF`,
pen-wash `#1C2550`, highlight `#D6EC2E` (text on it `#15203A`), signed `#4CCB92`, hold `#F0B54A`,
risk `#FF8A80`, washes at ~15% of their color over the sheet. In dark mode the highlighter appears only
on savings; the pen blue carries everything else.

Type (self-hosted with next/font; the CSP allows only same-origin fonts):
- **Bricolage Grotesque** (variable, `opsz` + `wdth`): the wordmark, page titles, section heads, every
  price. Weight 650-800, tracking -0.02em at 30px and above. Prices use lining tabular figures.
- **Schibsted Grotesk**: everything else (body, UI, tables, forms). 400 / 500 / 650.
- Scale (px): 12, 14, 16, 18, 21, 24, 30, 36, 48, 60. Body 16/1.55; UI text 15/1.45; table text 14/1.4;
  page title 30 (36 on wide screens); the landing headline 48-60.
- Line length under 72ch for prose. Sentence case everywhere. No all-caps labels, no tracked-out
  eyebrows, no monospace data labels, no " · "-joined meta strings (use separate spans with gaps), no
  "→" on buttons, no one-word-accent headlines.

Shape and depth:
- Radius: 4px controls, 8px sheets, 999px only for the status dot. Not one radius for everything.
- One shadow, only on floating things (drawer, menu, sticky approval bar): `0 8px 24px -12px rgb(21 32 58 / .28)`.
  Sheets on the desk are separated by color and a 1px `--rule`, not shadows.
- Spacing on a 4px grid: 4, 8, 12, 16, 24, 32, 48, 64.

## Layout

**App shell** (signed-in pages, a route-group layout so it persists across navigations):
- Left rail, 256px, on `--desk`: wordmark; **New request** (primary); the deals list grouped as
  *Needs you* (awaiting approval or a question), *In progress*, *Done* — each item one line of request
  title + a status line (dot + words) + best price when there is one; then Vendors, Settings, Account and
  the signed-in email + sign out pinned at the bottom. The deals list streams in (Suspense); the rail
  never blocks a page.
- Content on the right, max 1080px for app pages, left-aligned (not centered in a void).
- Below 900px: a 56px top bar (wordmark, New request, menu button) and the rail as a slide-in drawer
  (`<dialog>`, focus-trapped, Esc closes).

**Status** is a 8px dot + words ("Calling now", "Quoted $1,150", "Waiting for reply"), never a pill.
Badges (pills) are allowed in exactly one case: the **Demo** marker. Must-haves are a checklist, not chips.

## Pages

- **Landing** (`/`): left-aligned hero; headline that says the thing specifically; the hero visual is a
  live quote sheet where, once on load, the pen strikes Golden Grill's $1,380, writes $1,240, highlights
  −$140 and circles Bay Catering's total (the page's single orchestrated motion, ~1.4s, skipped under
  reduced motion). Below: "A deal, start to finish" as a short timestamped log of one real-shaped deal
  (09:02 emailed four caterers … 10:20 you approved Bay Catering), not four numbered columns. Then the
  three channels (email, phone, text) with what each does, and the trust line. Light by default.
- **Sign in / onboarding**: one sheet centered on the desk, wordmark above; onboarding is a short
  stepped form with clear defaults.
- **Chat** (`/chat`, `/chat/[id]`): one column, max 720px; the composer is an auto-growing textarea
  (no scrollbar until 8 lines) pinned to the bottom with the send button inside it; suggestions are a
  short list of example requests. Tool results render as structured cards: the **preview** card lists
  what Haggle understood (what, how many, when, where, budget, must-haves) and who it will contact, with
  **Start the deal** and **Change something**; the **started** card links to the deal board by name,
  never a raw job id. Recent conversations live in the shell rail (or a compact list on `/chat`).
- **Deals** (`/deals`): a dense table-like list grouped like the rail; each row: request, status line,
  businesses contacted / quoted, best price, updated time. Empty state invites a new request.
- **Deal board** (`/deals/[id]`): header = title (display), a meta row (people, date, place, budget as
  separate items), status words with a live dot, actions on the right (Cancel deal in a menu, not a big
  button at the bottom). Main column = **the quote sheet**: one row per quote sorted by total — business,
  channel, requirements met (✓ 2 of 2), total (display, right-aligned), per person + deposit beneath.
  Recommended row gets the pen circle and a one-line reason that wraps (never truncated). Negotiated
  prices get the strike + highlighter. Rows expand in place (items, terms, valid until, source,
  transcript excerpt). Selecting a quote opens the **approval bar** (sticky at the bottom of the main
  column): "Approve Bay Catering — $5 deposit now, $1,150 total" + Approve. Below the sheet, **Activity**:
  what Haggle did per business, newest first, relative times; an active call shows a small animated
  3-bar "on call" indicator (the only ambient motion in the app). Side column: the request and the
  must-have checklist, progress as a short vertical list.
- **Business detail**: the conversation with one business as a transcript (emails, call transcript,
  texts) with channel and time per message.
- **Vendors**: your vendors as a compact table (name, channel, contact, consent basis, hours); **Find
  businesses** as a search bar with results you can add in one click; **Add a vendor** as a drawer or
  inline expandable form, not a giant always-open form.
- **Settings / Account**: two-column definition lists on one sheet; dangerous actions in their own
  bordered area at the end.
- **Legal pages**: readable article column (68ch), the same type.

## Interaction and speed

Fast is part of the design:
- Every signed-in route has a `loading.tsx` skeleton shaped like the page (no spinners for page loads);
  data-backed sections stream behind `<Suspense>` so the shell and headings paint immediately.
- Session and workspace lookups are deduped per request (`React.cache`) and use local JWT verification
  (`getClaims`) where a network round trip isn't needed.
- Every mutation shows its pending state on the control that started it within one frame
  (`useTransition` / `useFormStatus`), keeps it until the refreshed data has arrived
  (`startTransition(() => router.refresh())`), and is optimistic where the outcome is certain.
- Internal links are `next/link`. Buttons respond on press (`:active` 1px down), not just on hover.
- Live updates never shift layout; a newly arrived quote flashes `--pen-wash` once (600ms).
- Motion answers actions (expand, open drawer, confirm) with 150-220ms ease-out; no entrance
  animations on scroll, no hover lifts on cards. `prefers-reduced-motion` removes all non-essential motion.

## Words

Write from the buyer's side, plainly: "Waiting for 5 replies", not "Collecting quotes (state)". Name
actions by what happens ("Approve $5 deposit", "Start the deal"). Cut explanatory paragraphs under every
heading: one short sentence where it genuinely helps, otherwise none. Never show internal ids
(`job_…`), raw channel codes or "RFQ". Keep the safety facts the product promises (nothing is ordered
or paid until you approve; calls say they are an AI assistant), stated once where they matter.

## Quality floor

Responsive to 360px; visible focus (2px `--pen` ring, offset 2px); contrast AA; keyboard reachable
drawer, menus and row expansion; light and dark both checked by screenshot; no external assets.
