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
| `--ink-3` | `#646D82` | hints, meta, placeholders (darkened from #7A8296 to pass AA on the desk) |
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

## Components

The shared foundation. Tokens live in `app/globals.css`, primitives in `components/ui/` (styles in
`components/ui/ui.css`, loaded once by the root layout), the app shell in `components/shell/`. Import
primitives from `@/components/ui` (or the file directly). Use the tokens (`var(--pen)`, `var(--r-sheet)`,
`var(--s-4)`…), never raw hex. Legacy names (`--panel`, `--carbon`, `--win`, `--warn`, `--info`…) are
aliases kept only so old page CSS renders; new CSS uses the new names.

**Tokens beyond the table above:** `--pen-strong` (hover/pressed pen), `--on-pen`, `--on-highlight`,
`--skeleton`, `--shadow-float`, `--scrim`, `--font-text`, `--font-display`, `--t-15`, `--r-control` (4px),
`--r-sheet` (8px), `--s-1..--s-16` (4px grid), `--rail` (256px), `--content` (1080px), `--ease-out`.
Utilities: `.num` (Bricolage tabular lining figures), `.display`, `.sr-only`. Never put
`font-variant-numeric: tabular-nums` on Schibsted text: its tabular commas and colons are wide ("$1 , 200").

| Component | Props | Example |
| --- | --- | --- |
| `Button` | `variant` default/primary/quiet/danger, `size` m/s, `block`, `icon` (square, needs aria-label), `pending`, plus button attrs (`type` defaults to "button") | `<Button variant="primary" pending={isPending} onClick={approve}>Approve $5 deposit</Button>` |
| `buttonClass(variant, { size, block, icon, className })` | for links styled as buttons; the `.btn .btn-primary .btn-quiet .btn-danger .btn-s .btn-icon .btn-block` classes still work directly | `<Link className={buttonClass("primary")} href="/chat">New request</Link>` |
| `SubmitButton` | Button props; pending from `useFormStatus` (React actions) or the form's native submit | `<form action={save}><SubmitButton variant="primary">Save</SubmitButton></form>` |
| `Field` | `label`, `hint?`, `error?`, `optional?`, `id?`; one control as the child (gets id, aria-describedby, aria-invalid) | `<Field label="Budget" hint="Haggle never commits above it." optional><input name="budget" inputMode="decimal" /></Field>` |
| `Status` / `StatusDot` | `tone` live/ok/hold/risk/idle; words as children. live breathes (still under reduced motion) | `<Status tone="live">Calling now</Status>` |
| `Price` | `amount` (null -> "not stated"), `cents?`, `size` s/m/l/xl (14/16/24/36), `sign?` "-"/"+" | `<Price amount={1150} size="l" />` |
| `Struck` | children (the old price), `animate?`, `delay?` ms, `srPrefix?` (default "was") | `<Struck><Price amount={1380} /></Struck> <Price amount={1240} />` |
| `Circled` | children, `animate?`, `delay?`. Only on the recommended total; say "Recommended" in words too | `<Circled animate><Price amount={1150} size="l" /></Circled>` |
| `Highlighted` | children, `animate?`, `delay?`. Only on money saved | `<Highlighted><Price amount={140} sign="-" size="s" /></Highlighted>` |
| `PenUnderline` / `Underlined` | `animate?`, `delay?`. PenUnderline sits at the bottom of its nearest `position: relative` ancestor; render it only on the current item | `<Underlined>Quotes</Underlined>` |
| `Skeleton` / `SkeletonText` | `w`, `h`, `radius` / `lines`, `lineHeight`, `gap`; aria-hidden, mark the region `aria-busy` | `<Skeleton w={120} h={24} />` |
| `Icon` | `name`: mail, phone, message, agent, check, x, close, chevron-right, chevron-down, plus, search, menu, external, clock, more; `size` 16/20/24; `label?` makes it meaningful. `channelIcon(channel)` maps email/phone/imessage/a2a | `<Icon name={channelIcon(q.channel)} />` |
| `Badge` | children (default "Demo"). The Demo marker only | `{mode === "mock" && <Badge />}` |
| `Sheet` | `as` div/section/article/aside/li/form, `pad` m/s/none | `<Sheet as="section" pad="none" aria-label="Quotes">…</Sheet>` |
| `EmptyState` | `title`, `action?`, children (one sentence), `headingLevel` 2/3 | `<EmptyState title="No deals yet" action={<Link className={buttonClass("primary")} href="/chat">New request</Link>} />` |
| `Drawer` | `open`, `onClose`, `label`, `title?`, `side` left/right, `width?`; modal `<dialog>`, Esc/backdrop close, focus returns | `<Drawer open={adding} onClose={() => setAdding(false)} label="Add a vendor" title="Add a vendor" side="right">…</Drawer>` |

Motion for pen marks: `animate` draws once (straight marks wipe left to right ~420ms, the circle draws
~640ms); `delay` orchestrates a sequence (the landing hero: strike 0, highlight ~500, circle ~900).
Reduced motion shows marks already drawn.

**The app shell** (`app/(app)/layout.tsx` -> `components/shell/AppShell.tsx` + `Rail.tsx`):
- Every signed-in route lives in `app/(app)/` and renders inside `.app-main`. Each page renders its own
  single `<main>`; the `.shell` wrapper is left-aligned at `--content` width inside the app.
- The layout calls `requireHaggle()` (cached per request; the page's own call reuses it).
- The rail's deals list comes from `loadDeals()` in `components/shell/data.ts` (list_deals, newest 20,
  one call per request, never throws: `{ deals } | { error: { message, fix } }`). `/deals` uses the same
  call. Grouping and status words: `groupDeals()` / `dealStatus()` / `dealHref()` in
  `components/shell/deals.ts`; reuse them so the rail and pages agree.
- The layout persists across client navigations, so the rail only re-renders on a full load or
  `router.refresh()`. After a mutation that changes a deal (deal started in chat, approve, pay,
  cancel), call `startTransition(() => router.refresh())` and the rail updates with the page.
- Full-height pages (the chat) are supported: `body:has(.chat-layout)` makes the shell fill the window.
- `app/(app)/loading.tsx` is the generic skeleton; add a route-specific `loading.tsx` shaped like the page.
- `RetryButton` (`components/shell/RetryButton.tsx`) re-renders the route with a pending state; use it
  for any section that failed to load.
