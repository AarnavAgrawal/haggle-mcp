-- 109_engine_reliability (owner: Yash). Background reliability (overnight sprint, workstream C):
--   * operator_reviews: the durable dead-letter queue. An action that failed repeatedly, an outcome
--     nobody can know (a call that may have rung), a stale charge, a parse that gave up, a stuck job
--     or a reply that arrived after its deal closed lands here with its reason, attempts and the
--     last error (redacted by the engine). Nothing in it is retried until an operator resolves it.
--   * outbox: an action under open review can't be claimed again (no silent retry), and a call whose
--     outcome is unknown can never be relabelled "not sent" (which would let it be redialed).
-- Additive only: no existing check, trigger or policy is relaxed.

create table public.operator_reviews (
  id          text primary key check (length(id) between 1 and 100),
  job_id      text references public.jobs(id) on delete cascade,
  kind        text not null check (kind in ('outbox','payment','reconcile','parse','stuck_job','late_reply','confirmation')),
  -- What the review is about: an outbox key, a payment id, a message id, a job id.
  subject     text not null check (length(subject) between 1 and 300),
  reason      text not null check (length(reason) between 1 and 200),
  attempts    integer not null default 0 check (attempts between 0 and 1000),
  last_error  text check (last_error is null or length(last_error) <= 500),
  status      text not null default 'open' check (status in ('open','resolved')),
  resolution  text check (resolution is null or length(resolution) <= 500),
  resolved_by text check (resolved_by is null or length(resolved_by) <= 120),
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((status = 'resolved') = (resolved_by is not null and resolved_at is not null and resolution is not null))
);
-- One open review per subject: a repeat failure updates it (attempts, last error), never piles up.
create unique index operator_reviews_open_subject on public.operator_reviews(kind, subject) where status = 'open';
create index operator_reviews_status_idx on public.operator_reviews(status, created_at);
create index operator_reviews_job_idx on public.operator_reviews(job_id);
create index outbox_status_idx on public.outbox(status, updated_at);
create index outbox_provider_ref_idx on public.outbox(provider_ref) where provider_ref is not null;

create or replace function public.haggle_review_transition() returns trigger
language plpgsql as $$
begin
  if new.id <> old.id or new.kind <> old.kind or new.subject <> old.subject or new.job_id is distinct from old.job_id then
    raise exception 'operator review identity is immutable';
  end if;
  if old.status = 'resolved' then raise exception 'a resolved operator review is final'; end if;
  return new;
end;
$$;
create trigger operator_reviews_transition before update on public.operator_reviews
  for each row execute function public.haggle_review_transition();

create or replace function public.haggle_outbox_reliability() returns trigger
language plpgsql as $$
begin
  -- Dead-lettered: re-attempted only after an operator resolves its review.
  if new.status = 'pending' and old.status <> 'pending'
     and exists (select 1 from public.operator_reviews r where r.kind = 'outbox' and r.subject = old.key and r.status = 'open') then
    raise exception 'outbox action % is under operator review', old.key;
  end if;
  -- A call that may have rung is never relabelled "not sent" (106 lets a not_sent call be redialed).
  if old.kind = 'call' and old.status = 'unknown' and new.status = 'not_sent' then
    raise exception 'a call whose outcome is unknown is never marked not sent';
  end if;
  return new;
end;
$$;
create trigger outbox_reliability before update on public.outbox
  for each row execute function public.haggle_outbox_reliability();

alter table public.operator_reviews enable row level security;
alter table public.operator_reviews force row level security;
revoke all on public.operator_reviews from anon, authenticated;
