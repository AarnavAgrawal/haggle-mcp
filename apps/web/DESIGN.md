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
| Hand-drawn strike (`--red-ink`) | a price that was superseded by negotiation | `$1,380` → `$1,240` |
| Hand-drawn circle (`--pen`, ledger green) | Haggle's recommendation | the recommended quote's total |
| Highlighter swipe (`--highlight`, yellow) | money saved | `−$140` |
| Hand-drawn underline (`--pen`) | where you are | current nav item, active tab |

Marks are SVG paths with slight irregularity (never a font, never emoji). They are the one place the UI
is playful; everything around them is quiet, precise and dense. No mark is decoration: if a marked thing
isn't true (no negotiation, no recommendation), there's no mark.

## Tokens

### Palette: "Ledger"

Haggle's world is quotes, line items and totals, with prices crossed out and written lower. That is the
material of a ledger book: pale green paper ruled into columns, totals in dark ink, corrections in red
ink, and the best number marked with a highlighter. So every color has a reason:
- **green ink** circles the recommendation and marks every action;
- **red ink** strikes the superseded price;
- **yellow highlighter** marks the savings;
- **amber** means waiting on you.

The old palette (navy ink and royal blue on cool grey, near-black navy in dark) was the default look of
generated SaaS pages and said nothing about Haggle. It is gone. There is no blue anywhere.

Principles:
- Spend the boldness in one place: the pen marks on the quote sheet (landing hero, deal board).
  Everything else stays quiet: paper, ink, rules.
- Color carries meaning, never decoration. No gradients, tinted shadows or colored status borders.
- Ledger rules only where they are information: quote rows are line items, so they get faint rules and
  right-aligned totals in tabular figures. No ruled backgrounds elsewhere.
- Red ink on a struck price means "old price", not "error". Problems use `--risk` with words.

Colors (light, default). Names describe the role; use the variables, never raw hex in components.

| Token | Hex | Use |
| --- | --- | --- |
| `--desk` | `#ECF1E8` | app background: pale ledger green |
| `--sheet` | `#FBFCF9` | panels, the quote sheet, inputs: near-white paper |
| `--ink` | `#1A2920` | primary text, prices: green-black ink |
| `--ink-2` | `#46564B` | secondary text, secondary button outline |
| `--ink-3` | `#5A695F` | hints, meta, placeholders (5.1:1 on the desk) |
| `--rule` / `--rule-strong` | `#CFDCC9` / `#A8BCA2` | ledger rules, hairlines, input borders |
| `--pen` / `--pen-strong` | `#17603D` / `#0F4A2E` | primary action, links, focus ring, the circle and underline |
| `--on-pen` | `#FBFCF9` | text on the pen (paper white) |
| `--pen-wash` | `#DCEBDD` | selected rows, hover, new-item flash |
| `--red-ink` | `#C0271E` | the strike through a superseded price (the struck text stays `--ink-3`) |
| `--highlight` | `#EEF03A` | savings only (text on it is `--on-highlight`, `#1A2920`) |
| `--signed` / `--signed-wash` | `#2C7A3F` / `#E2F0E4` | done: approved, meets requirement, paid (always with a check and words) |
| `--hold` / `--hold-wash` | `#8A5A00` / `#F8EED8` | waiting on you, demo marker |
| `--risk` / `--risk-wash` | `#B3261E` / `#FBE9E6` | problems: failed, declined, destructive |

Dark (prefers-color-scheme: dark): "Ledger at night". Bottle green, not navy and not black. Designed, not
inverted.

| Token | Hex |
| --- | --- |
| `--desk` / `--sheet` | `#14211A` / `#1B2B22` |
| `--ink` / `--ink-2` / `--ink-3` | `#E4ECE3` / `#AEBDB1` / `#8A9A8E` |
| `--rule` / `--rule-strong` | `#2A3D31` / `#3A5243` |
| `--pen` / `--pen-strong` / `--pen-wash` | `#8FD6A8` / `#B4E6C5` / `#213A2B` |
| `--on-pen` | `#14211A` |
| `--red-ink` / `--risk` | `#FF8A7A` |
| `--highlight` | `#D9E23A` (text on it `#1A2920`) |
| `--signed` | `#7FCB8F` |
| `--hold` | `#F0B54A` |

Washes are about 15% of their color over the sheet. In dark mode the pen is light green, so text on it
is dark (`--on-pen`).

Contrast: `tests/tokens.contrast.test.ts` reads `app/globals.css` and asserts WCAG AA (4.5:1) for
`--ink`, `--ink-2` and `--ink-3` on `--desk` and `--sheet`, and for `--on-pen` on `--pen`, in light and
dark. Every value above passes as written; none needed adjusting. The lowest pair is light `--ink-3` on
the desk at 5.1:1.

The MCP views (`apps/mcp/views/_shared/theme.css`) use the same values. Their older token names
(`--paper`, `--panel`, `--win`, `--warn`, `--info`, `--ch-*`) are aliases onto these.

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
- Buttons: primary is solid `--pen` with paper-white `--on-pen` text; secondary is an ink outline
  (`--ink-2`, `--ink` on hover) on the sheet; both 4px radius. No pills.
- One shadow, only on floating things (drawer, menu, sticky approval bar): `0 8px 24px -12px rgb(26 41 32 / .28)`.
  Sheets on the desk are separated by color and a 1px `--rule`, not shadows. The landing page's paper
  on the blotter is the exception: it floats, so it carries a deeper local `--lift`.
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
Badges are allowed in exactly one case: the **Demo** marker, a 4px-radius tag (not a pill). Must-haves are a checklist, not chips.

## Pages

- **Landing** (`/`): a company front page, and the one place the wordmark is the hero. The ground is the
  **blotter**: a fixed deep ledger green (`--blotter`, local to `app/landing.css`, in both color schemes)
  with the quote sheet as the one piece of paper on it. Top bar: section links, Sign in, Get started; the
  pen underline marks the section you're in. The name fills the first screen, centered, with the headline,
  lede and call to action under it and the example quote sheet peeking up from the bottom edge, tilted.
  Scrolling lifts the sheet flat and into its column, where it pins beside "A deal, start to finish":
  each log entry the reader passes moves the sheet on a step (quotes land, Golden Grill's $1,380 is struck
  to $1,240, −$140 is highlighted, Bay Catering is circled, the deposit is approved). Marks still only
  ever mark something true at that point in the story. Then the three channels as sheets that slide over
  one another (a stack on phones is just a list), the promises as large statements, and a closing call to
  action with the wordmark again as the sign-off. Scroll state lives in `components/LandingMotion.tsx`,
  which renders nothing; the page stays a server component and the markup is the finished sheet, so with
  reduced motion or no script it is simply marked up and everything is visible.
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
  The landing page is the one exception: it is a marketing page, so it animates on load and on scroll
  (see Pages). Signed-in pages stay as described here.

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
