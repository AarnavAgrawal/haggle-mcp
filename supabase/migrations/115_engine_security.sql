-- 115_engine_security (owner: Yash). Sprint 4 workstream D: a money result never turns into another.
--   * payments: a failed, rejected or settled payment is final (a failed or unknown charge can never
--     later read as paid; a settled one is never re-opened); a payment settles only from 'sent' (x402)
--     or 'charging' (Stripe), never on insert; its terms (job, approval, business, amount, rail, and a
--     set idempotency key) never change.
--   * payment_handoffs: "the customer reports paying" (human_confirmed) is reached only from an open
--     handoff, never written directly on insert.
-- Additive only: nothing in 100-111 is edited or relaxed. Applies on top of 100-111 alone.

create or replace function public.haggle_payment_final() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'settled' then raise exception 'a payment is never recorded as settled on insert'; end if;
    return new;
  end if;
  if old.status in ('failed','rejected','settled') and new.status is distinct from old.status then
    raise exception 'a failed, rejected or settled payment is final';
  end if;
  if new.status = 'settled' and old.status not in ('sent','charging','settled') then
    raise exception 'a payment settles only from sent (x402) or charging (Stripe)';
  end if;
  if new.job_id is distinct from old.job_id or new.approval_id is distinct from old.approval_id or new.business_id is distinct from old.business_id
     or new.amount_cents is distinct from old.amount_cents or new.rail is distinct from old.rail
     or (old.idempotency_key is not null and new.idempotency_key is distinct from old.idempotency_key) then
    raise exception 'payment terms are immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists payments_final on public.payments;
create trigger payments_final before insert or update on public.payments
  for each row execute function public.haggle_payment_final();

create or replace function public.haggle_handoff_report_from_open() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'human_confirmed' and (tg_op = 'INSERT' or old.status not in ('instructions_requested','instructions_received','human_confirmed')) then
    raise exception 'a reported payment needs an open handoff first';
  end if;
  return new;
end;
$$;
drop trigger if exists payment_handoffs_report_from_open on public.payment_handoffs;
create trigger payment_handoffs_report_from_open before insert or update on public.payment_handoffs
  for each row execute function public.haggle_handoff_report_from_open();
