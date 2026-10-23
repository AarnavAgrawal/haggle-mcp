# Deploying the shareable demo

A public Haggle demo: the web app (`apps/web`) on Vercel, the MCP server (`apps/mcp`) on Manufact in
**mock mode** (simulated businesses: nothing real is contacted or paid), and one Supabase project for
sign-in and storage. Full architecture: [web-app.md](web-app.md).

Never put a secret in git. Values marked *secret* go only in the hosts' environment settings and the
local `.env` files (both gitignored).

## 1. Supabase (one new project, just for the demo)

1. Create the project. Do not reuse a production database: the MCP server refuses databases listed in
   `HAGGLE_PROD_DB_HOSTS` or named "prod"/"production".
2. Apply every file in `supabase/migrations/` in numeric order (SQL editor, or `psql` with the
   connection string): engine `1xx`, brain `2xx`, then web `300`, `301`.
3. Authentication → Sign In / Providers: enable **Email** (magic link) and **Anonymous sign-ins**
   (the "Try the demo" button). Google is optional (needs a Google OAuth client).
4. Authentication → URL Configuration: Site URL = the web app's URL; add Redirect URL
   `<web app URL>/auth/callback` (and `http://localhost:3200/auth/callback` for local runs).
5. Copy: Project URL, `anon` key, `service_role` key (*secret*), and the database connection string
   (*secret*; Settings → Database; the session pooler URI works from serverless hosts).

## 2. MCP server on Manufact (mock mode)

`npx mcp-use login` (once), then from the repo root `npx mcp-use deploy --name haggle-demo --root-dir apps/mcp`
(after `npm run build -w @haggle/mcp`). Copy the MCP URL from the Manufact dashboard; never guess it.

| Variable | Value |
|---|---|
| `HAGGLE_MODE` | `mock` |
| `HAGGLE_ENV` | `staging` |
| `HAGGLE_AUTH` | `required` |
| `HAGGLE_SERVICE_TOKEN` | *secret*: 32+ random characters, the same value as on the web app (`openssl rand -base64 36`) |
| `HAGGLE_MOCK_DATABASE_URL` | *secret*: the Supabase connection string (keeps workspaces and deals; the web app's tables link to them) |
| `HAGGLE_SIM_DELAY_SCALE` | `0.15` (the board fills in over about a minute; `0` is instant) |
| `HAGGLE_TICK_SECRET` | optional *secret*, 16+ chars, if an external cron calls `/internal/tick` |
| `ANTHROPIC_API_KEY` | optional *secret*: the server's own reply parsing uses Claude when set (mock mode works without it) |

Check: `curl <MCP URL without /mcp>/health` answers, and `POST /internal/workspaces` without the token
answers 401.

## 3. Web app on Vercel

Import the GitHub repo in Vercel (or `npx vercel` from `apps/web`): Root Directory `apps/web`,
framework Next.js, install from the repo root (npm workspaces; keep "Include files outside the root
directory" on).

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_HAGGLE_DEMO` | `true` (landing "Try the demo", guest access, demo banner and examples) |
| `NEXT_PUBLIC_SUPABASE_URL` | the Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the Supabase anon key (public by design) |
| `SUPABASE_SERVICE_ROLE_KEY` | *secret* |
| `HAGGLE_MCP_URL` | the Manufact server's base URL (without `/mcp`) |
| `HAGGLE_SERVICE_TOKEN` | *secret*: same value as the server's |
| `ANTHROPIC_API_KEY` | *secret*: the chat |
| `WEB_CHAT_MODEL` | optional, default `claude-opus-5-5` |
| `WEB_CHAT_DAILY_CAP` | e.g. `300`: chat turns per day across the site, so a shared link can't run up the bill |

The chat route streams for up to 300 s (`maxDuration`); if the plan cuts responses short, use a plan
with longer function durations or host the app as a Node server.

## 4. Smoke test the live site

1. Open the site: the landing page shows the DEMO banner and "Try the demo, no sign-up".
2. Try the demo: you land in the chat with catering examples. Send one; Haggle previews who it will
   contact, then starts the deal on your confirmation.
3. Open the deal page: businesses move from contacted to quoted; quotes rank; transcripts open.
4. Approve the recommended quote, then Pay: the deal ends Paid (simulated).
5. Sign out and sign in by email: the deals list is that account's own.

## Local run against the same services

`apps/web/.env.local` (Next.js reads this, not the root `.env`) gets the web variables above with
`HAGGLE_MCP_URL=http://localhost:3000`; the root `.env` gets the server variables. Then
`npm run dev:mcp` and `npm run dev -w @haggle/web` (http://localhost:3200).
