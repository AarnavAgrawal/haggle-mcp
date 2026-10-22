-- 118_engine_booking (owner: Yash). Sprint 5 workstream A: no payment handoff without a booking that
-- someone confirmed. Before this, a booking Haggle can't get a written answer for ('not_in_writing':
-- a vendor reached by phone or A2A) started the payment handoff at once, on nobody's confirmation.
-- Now the approver must confirm it with the vendor directly and accept it by text (BOOKED <code>),
-- recorded as bookings.human_attested_at, before the handoff can start.
--   * human_attested_at: set once, only on a not_in_writing booking; never on insert; never cleared.
--   * a payment handoff needs a confirmed booking, or a not_in_writing one the human attested
--     (and, as in 113, a paying approval).
-- Additive: nothing in 100-117 is edited. Idempotent (re-running it changes nothing). Applies on top of
-- 100-111 alone as well (it only needs 110's bookings and payment_handoffs).

alter table public.bookings add column if not exists human_attested_at timestamptz;

alter table public.bookings drop constraint if exists bookings_attested_not_in_writing;
alter table public.bookings add constraint bookings_attested_not_in_writing
  check (human_attested_at is null or status in ('not_in_writing', 'cancelled'));

create or replace function public.haggle_booking_attestation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.human_attested_at is not null then raise exception 'a booking starts unattested'; end if;
    return new;
  end if;
  if new.human_attested_at is distinct from old.human_attested_at then
    if old.human_attested_at is not null then raise exception 'a booking attestation is final'; end if;
    if old.status <> 'not_in_writing' or new.status <> 'not_in_writing' then
      raise exception 'only a booking Haggle cannot confirm in writing is attested by the human';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_attestation on public.bookings;
create trigger bookings_attestation before insert or update on public.bookings
  for each row execute function public.haggle_booking_attestation();

create or replace function public.haggle_handoff_needs_booking() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from public.bookings b
    where b.approval_id = new.approval_id and b.payment_cents > 0
      and (b.status = 'confirmed' or (b.status = 'not_in_writing' and b.human_attested_at is not null))
  ) then
    raise exception 'a payment handoff starts only after the booking of a paying approval is confirmed (in writing, or accepted by the human)';
  end if;
  return new;
end;
$$;
