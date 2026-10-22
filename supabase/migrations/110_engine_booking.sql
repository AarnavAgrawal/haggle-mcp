-- 110_engine_booking (owner: Yash). Overnight sprint workstream D (2026-10-22): the purchase after
-- the human's approval, honest at every step.
--   * bookings: after the human approves, the business must explicitly confirm availability and the
--     approved terms before the deal counts as booked (or, for a business Haggle can't get a written
--     answer from, the human confirms it with them directly: 'not_in_writing'). A booking must match
--     its human-approved paying approval exactly; declined / changed / cancelled are final.
--   * payment_handoffs: a handoff starts only after the booking is confirmed (new insert trigger;
--     106's trigger and statuses are untouched). stalled_at records an operator-visible timeout.
--   * handoff_receipts: the business's explicit "payment received", from a verified sender, after the
--     customer reported paying. Only this makes a manual payment "settled_verified".
-- Additive only: nothing in 100-106 is edited or relaxed.

create table public.bookings (
  id                 text primary key,
  job_id             text not null references public.jobs(id) on delete cascade,
  approval_id        text not null unique references public.approvals(id) on delete cascade,
  quote_id           text not null references public.quotes(id),
  business_id        text not null,
  total_cents        integer not null check (total_cents > 0),
  payment_cents      integer not null check (payment_cents > 0),
  status             text not null check (status in ('awaiting_vendor_confirmation','confirmed','not_in_writing','declined','changed','cancelled')),
  request_message_id text,
  reply_text         text check (reply_text is null or length(reply_text) <= 4000),
  reply_message_id   text,
  reply_has_link     boolean not null default false,
  confirmed_at       timestamptz,
  stalled_at         timestamptz,
  cancel_reason      text check (cancel_reason is null or length(cancel_reason) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((status = 'confirmed') = (confirmed_at is not null) or status = 'cancelled')
);
create index bookings_job_idx on public.bookings(job_id, created_at);

create or replace function public.haggle_booking_matches_approval() returns trigger
language plpgsql as $$
declare a record;
begin
  if tg_op = 'UPDATE' then
    if old.status in ('declined','changed','cancelled') then raise exception 'a declined, changed or cancelled booking is final'; end if;
    if old.status in ('confirmed','not_in_writing') and new.status not in (old.status, 'cancelled') then
      raise exception 'a confirmed booking can only be cancelled';
    end if;
    if new.approval_id <> old.approval_id or new.quote_id <> old.quote_id or new.business_id <> old.business_id or new.job_id <> old.job_id
       or new.total_cents <> old.total_cents or new.payment_cents <> old.payment_cents then
      raise exception 'booking terms are immutable';
    end if;
    return new;
  end if;
  select job_id, quote_id, business_id, quote_total_cents, payment_cents, action, status into a from public.approvals where id = new.approval_id;
  if a.job_id is distinct from new.job_id or a.quote_id is distinct from new.quote_id or a.business_id is distinct from new.business_id
     or a.quote_total_cents is distinct from new.total_cents or a.payment_cents is distinct from new.payment_cents
     or a.action = 'confirm' or a.status not in ('approved','used') then
    raise exception 'booking must match a human-approved paying approval';
  end if;
  if new.status not in ('awaiting_vendor_confirmation','not_in_writing') then raise exception 'a booking starts awaiting the business (or not in writing)'; end if;
  return new;
end;
$$;
create trigger bookings_match_approval before insert or update on public.bookings
  for each row execute function public.haggle_booking_matches_approval();

alter table public.payment_handoffs add column stalled_at timestamptz;

create or replace function public.haggle_handoff_needs_booking() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from public.bookings b where b.approval_id = new.approval_id and b.status in ('confirmed','not_in_writing')) then
    raise exception 'a payment handoff starts only after the booking is confirmed';
  end if;
  return new;
end;
$$;
create trigger payment_handoffs_need_booking before insert on public.payment_handoffs
  for each row execute function public.haggle_handoff_needs_booking();

create table public.handoff_receipts (
  id          text primary key,
  handoff_id  text not null unique references public.payment_handoffs(id) on delete cascade,
  job_id      text not null references public.jobs(id) on delete cascade,
  message_id  text not null,
  evidence    text not null check (length(evidence) between 1 and 500),
  created_at  timestamptz not null default now()
);

create or replace function public.haggle_receipt_after_report() returns trigger
language plpgsql as $$
declare h record;
begin
  select job_id, status into h from public.payment_handoffs where id = new.handoff_id;
  if h.job_id is distinct from new.job_id or h.status is distinct from 'human_confirmed' then
    raise exception 'a receipt is recorded only after the customer reported paying';
  end if;
  return new;
end;
$$;
create trigger handoff_receipts_after_report before insert on public.handoff_receipts
  for each row execute function public.haggle_receipt_after_report();
create or replace function public.haggle_receipt_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'a recorded receipt is final';
end;
$$;
create trigger handoff_receipts_immutable before update on public.handoff_receipts
  for each row execute function public.haggle_receipt_immutable();

do $$
declare t text;
begin
  foreach t in array array['bookings','handoff_receipts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
