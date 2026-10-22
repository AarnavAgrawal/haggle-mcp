-- 122_engine_metrics (owner: Yash, sprint 5 workstream E). Per-call Anthropic usage, persisted.
--   * ai_usage_events: one row per Claude call the engine made (quote extraction, answering a
--     business's question, the negotiation strategist): which job and workspace it was for, why, the
--     model id, and the token counts the API reported in the response's `usage` (missing usage is 0,
--     never guessed). The in-process meter (packages/engine/src/live/aiUsage.ts) still enforces the
--     limits; this table only lets the metrics report (apps/mcp/scripts/metrics.ts) attribute usage
--     and an approximate cost to each job after a restart. No prompt or reply text is stored.
-- Append-only (a trigger refuses update and delete). job_id is a logical reference without a foreign
-- key: a usage row must never make the Claude call that produced it fail. Additive only: no existing
-- table, constraint or trigger is changed; applies on top of 100-111 without 112-121. Safe to re-run.

create table if not exists public.ai_usage_events (
  id                          bigint generated always as identity primary key,
  job_id                      text check (job_id is null or length(job_id) between 3 and 80),
  workspace_id                text check (workspace_id is null or length(workspace_id) between 3 and 80),
  purpose                     text not null check (length(purpose) between 1 and 40),
  model                       text not null check (length(model) between 1 and 80),
  input_tokens                integer not null default 0 check (input_tokens >= 0),
  output_tokens               integer not null default 0 check (output_tokens >= 0),
  cache_creation_input_tokens integer not null default 0 check (cache_creation_input_tokens >= 0),
  cache_read_input_tokens     integer not null default 0 check (cache_read_input_tokens >= 0),
  at                          timestamptz not null default now()
);
create index if not exists ai_usage_events_job_idx on public.ai_usage_events(job_id, at);
create index if not exists ai_usage_events_at_idx on public.ai_usage_events(at);

create or replace function public.haggle_ai_usage_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'ai_usage_events is append-only';
end;
$$;
drop trigger if exists ai_usage_events_append_only on public.ai_usage_events;
create trigger ai_usage_events_append_only before update or delete on public.ai_usage_events
  for each row execute function public.haggle_ai_usage_append_only();

alter table public.ai_usage_events enable row level security;
alter table public.ai_usage_events force row level security;
revoke all on public.ai_usage_events from anon, authenticated;
