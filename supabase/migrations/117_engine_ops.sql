-- 117_engine_ops (owner: Yash). Operations (sprint 4, workstream F): reconciler catch-up and the
-- read paths operators and pollers hit.
--   * reconcile_cursors: per buyer identity and channel, the time up to which the inbound reconciler
--     has listed and handled every item (packages/engine/src/live/reconcileWindow.ts). After a
--     restart or an outage longer than the sweep's normal window (6 h), the sweep catches up from
--     here in bounded slices instead of silently skipping what arrived while it was down. The mark
--     only moves forward (the repository writes greatest(old, new)).
--   * indexes for the job board / polling / matching paths, measured on a seeded database
--     (apps/mcp/scripts/query-bench.ts; numbers in the sprint 4 report):
--       listOpenJobs (every tick, recovery, reconciler, ops report): partial index on open jobs;
--       findBusinessCandidates (every inbound email): RFQ Message-ID lookups by expression;
--       ops report quarantined replies, pending approvals by channel (every approval text).
-- Additive only: no existing check, trigger or policy is relaxed; nothing depends on 112-116. Safe to re-run.

create table if not exists public.reconcile_cursors (
  scope      text not null check (length(scope) between 1 and 320),
  channel    text not null check (channel in ('email','email_status','text','call')),
  high_water timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (scope, channel)
);

create index if not exists jobs_open_created_idx on public.jobs(created_at)
  where state not in ('paid','confirmed','cancelled','failed');
create index if not exists job_businesses_rfq_msgid_idx on public.job_businesses(lower(btrim(rfq_message_id, '<>')))
  where rfq_message_id is not null;
create index if not exists messages_quarantined_idx on public.messages(job_id, created_at)
  where quarantine_reason is not null;
create index if not exists approvals_pending_channel_idx on public.approvals(channel, created_at desc)
  where status = 'pending';

alter table public.reconcile_cursors enable row level security;
alter table public.reconcile_cursors force row level security;
revoke all on public.reconcile_cursors from anon, authenticated;
