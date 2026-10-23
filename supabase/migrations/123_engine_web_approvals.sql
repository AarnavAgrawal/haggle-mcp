-- 123_engine_web_approvals (production branch, approvals from the web app). The signed-in account owner
-- approves in the Haggle web app: approval channel 'web' (recorded with approver 'web:<user>'), reached
-- only through the service-token routes (apps/mcp/src/service/approvals.ts), never an MCP tool.
--   * approvals.channel: widened to allow 'web'. Every existing value stays allowed; nothing is
--     narrowed, renamed or moved. Older code never writes 'web' and reads it as an unknown channel.
-- Applies on top of 100-117 alone (the check comes from 101). Safe to re-run (drop if exists, then add).
-- Rollback: code first; the wider check can stay (a narrower one would refuse rows already written).

alter table public.approvals drop constraint if exists approvals_channel_check;
alter table public.approvals add constraint approvals_channel_check
  check (channel in ('elicitation','email','simulated','view','imessage','web'));
