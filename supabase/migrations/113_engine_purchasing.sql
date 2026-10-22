-- 113_engine_purchasing (owner: Yash). Sprint 4 workstream B: confirm-only approvals on the manual
-- pilot rail are booked like paying ones. Before this, a human's "confirm the order" approval closed
-- the deal as `confirmed` at once, on the human's word alone; now the business must confirm the order
-- in writing (a bookings row awaiting its reply) before the job is confirmed.
--   * bookings.payment_cents may be 0, but only for a confirm-only approval (which pays nothing); a
--     paying approval's booking still needs payment_cents > 0 (the trigger enforces both).
--   * a payment handoff still needs a paying approval: never for a confirm-only booking.
-- Every other rule of 110 is unchanged (terms immutable, declined/changed/cancelled final, a booking
-- starts awaiting the business or not in writing, no handoff before the booking is confirmed).
-- Applies on top of 100-111; idempotent (re-running it changes nothing).

alter table public.bookings drop constraint if exists bookings_payment_cents_check;
alter table public.bookings drop constraint if exists bookings_payment_cents_nonneg;
alter table public.bookings add constraint bookings_payment_cents_nonneg check (payment_cents >= 0);

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
     or a.status not in ('approved','used') then
    raise exception 'booking must match a human-approved approval';
  end if;
  -- A confirm-only approval books nothing to pay; a paying approval books a positive amount.
  if (a.action = 'confirm' and new.payment_cents <> 0) or (a.action <> 'confirm' and new.payment_cents <= 0) then
    raise exception 'booking amount must match the approval action (confirm pays nothing; pay pays a positive amount)';
  end if;
  if new.status not in ('awaiting_vendor_confirmation','not_in_writing') then raise exception 'a booking starts awaiting the business (or not in writing)'; end if;
  return new;
end;
$$;

create or replace function public.haggle_handoff_needs_booking() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from public.bookings b where b.approval_id = new.approval_id and b.status in ('confirmed','not_in_writing') and b.payment_cents > 0) then
    raise exception 'a payment handoff starts only after the booking of a paying approval is confirmed';
  end if;
  return new;
end;
$$;
