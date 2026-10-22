-- 106_engine_pilot (owner: Yash). Production pass 2 (2026-10-21), toward a real-vendor pilot:
--   * job_leases: one engine instance advances a job at a time, across processes and replicas;
--   * outbox: every outbound action is claimed before the provider is called. A call (Inkbox takes
--     no idempotency key for calls) that is pending or unknown can never be claimed again;
--   * vendor_suppressions: opt-outs and hard bounces; Haggle never contacts that address or number again;
--   * workspace_vendors: per-workspace vendor authorization, with the consent it rests on (operator-added);
--   * payment_handoffs: the manual payment handoff (no money moves through Haggle). A row must
--     match its human-approved paying approval, and a confirmed handoff is final.
-- Additive only: no existing check, trigger or policy is relaxed.

create table public.job_leases (
  job_id     text primary key references public.jobs(id) on delete cascade,
  owner      text not null check (length(owner) between 1 and 100),
  expires_at timestamptz not null
);

create table public.outbox (
  key          text primary key check (length(key) between 1 and 300),
  job_id       text references public.jobs(id) on delete cascade,
  kind         text not null check (kind in ('email','text','call','a2a')),
  status       text not null check (status in ('pending','sent','not_sent','unknown')),
  provider_ref text check (provider_ref is null or length(provider_ref) <= 300),
  attempts     integer not null default 1 check (attempts between 1 and 20),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index outbox_job_idx on public.outbox(job_id);

create or replace function public.haggle_outbox_transition() returns trigger
language plpgsql as $$
begin
  if new.key <> old.key or new.kind <> old.kind or new.job_id is distinct from old.job_id then
    raise exception 'outbox identity is immutable';
  end if;
  if old.status = 'sent' and new.status <> 'sent' then
    raise exception 'a sent outbox action is final';
  end if;
  -- A call may already be ringing once attempted: it is never claimed (pending) again.
  if old.kind = 'call' and new.status = 'pending' and old.status <> 'not_sent' then
    raise exception 'a call whose outcome may be unknown is never re-attempted';
  end if;
  return new;
end;
$$;
create trigger outbox_transition before update on public.outbox
  for each row execute function public.haggle_outbox_transition();

create table public.vendor_suppressions (
  contact    text primary key check (contact = lower(contact) and length(contact) between 3 and 320),
  reason     text not null check (reason in ('opt_out','bounce')),
  job_id     text references public.jobs(id) on delete set null,
  evidence   text check (evidence is null or length(evidence) <= 500),
  created_at timestamptz not null default now()
);

create table public.workspace_vendors (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  contact      text not null check (contact = lower(contact) and length(contact) between 3 and 320),
  name         text not null check (length(name) between 1 and 120),
  consent      text not null check (length(consent) between 3 and 500),
  added_by     text not null check (length(added_by) between 1 and 120),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, contact)
);

create table public.payment_handoffs (
  id                      text primary key,
  job_id                  text not null references public.jobs(id) on delete cascade,
  approval_id             text not null unique references public.approvals(id) on delete cascade,
  business_id             text not null,
  amount_cents            bigint not null check (amount_cents > 0),
  status                  text not null check (status in ('instructions_requested','instructions_received','human_confirmed','cancelled')),
  instructions_text       text check (instructions_text is null or length(instructions_text) <= 4000),
  instructions_message_id text,
  confirmed_by            text,
  confirmed_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  check ((status = 'human_confirmed') = (confirmed_by is not null and confirmed_at is not null))
);
create index payment_handoffs_job_idx on public.payment_handoffs(job_id, created_at);

create or replace function public.haggle_handoff_matches_approval() returns trigger
language plpgsql as $$
declare a record;
begin
  if tg_op = 'UPDATE' then
    if old.status in ('human_confirmed','cancelled') then raise exception 'a confirmed or cancelled handoff is final'; end if;
    if new.approval_id <> old.approval_id or new.amount_cents <> old.amount_cents or new.business_id <> old.business_id or new.job_id <> old.job_id then
      raise exception 'handoff terms are immutable';
    end if;
  end if;
  select job_id, business_id, payment_cents, action, status into a from public.approvals where id = new.approval_id;
  if a.job_id is distinct from new.job_id or a.business_id is distinct from new.business_id or a.payment_cents is distinct from new.amount_cents
     or a.action = 'confirm' or a.status not in ('approved','used') then
    raise exception 'handoff must match a human-approved paying approval';
  end if;
  return new;
end;
$$;
create trigger payment_handoffs_match_approval before insert or update on public.payment_handoffs
  for each row execute function public.haggle_handoff_matches_approval();

do $$
declare t text;
begin
  foreach t in array array['job_leases','outbox','vendor_suppressions','workspace_vendors','payment_handoffs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
