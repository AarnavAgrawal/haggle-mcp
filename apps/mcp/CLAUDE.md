# apps/mcp (owner: Yash)

Read the root `CLAUDE.md` first; it wins on any conflict.

- Only edit files inside `apps/mcp/` (plus Yash's `packages/engine/` and `supabase/migrations/1xx_engine_*.sql`).
- Tools are thin: validate input with zod, call `@haggle/engine` (or the brain via the engine), return
  compact `structuredContent` with a `next` hint. No business logic or authorization in views.
- View-bound tools declare `outputSchema`; views use `useToolContext()` / `useCallTool()`.
- Build/run: `corepack pnpm --filter @haggle/mcp build`, `PORT=3000 ./node_modules/.bin/mcp-use start`.
- Never print or commit secrets; `HAGGLE_MODE=mock` must be visibly labelled in every response.
