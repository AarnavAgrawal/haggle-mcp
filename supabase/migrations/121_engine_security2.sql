-- 121_engine_security2 (owner: Yash). Sprint 5 adversarial review (workstream D), defense in depth:
--   * an approval's terms (job, quote, business, amounts, cap, action) never change after insert
--     (105 checks them on insert only; an UPDATE could move an approval to another quote or amount);
--   * a decided approval never becomes pending or approved again: approved only from pending,
--     declined and locked only from pending, used only from approved; anything may expire.
-- Same rules as the in-memory store (packages/engine/src/payments/guard.ts approvalUpdateViolation).
-- Additive only: no existing check, trigger or policy is relaxed. Applies on top of 100-111 alone.

create or replace function public.haggle_approval_terms_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.job_id <> old.job_id or new.quote_id <> old.quote_id or new.business_id <> old.business_id
     or new.quote_total_cents <> old.quote_total_cents or new.payment_cents <> old.payment_cents or new.cap_cents <> old.cap_cents
     or new.action <> old.action or new.created_at <> old.created_at then
    raise exception 'an approval''s terms are immutable (quote, business, amounts, cap, action)';
  end if;
  if new.status <> old.status and new.status <> 'expired' and not (
       (new.status in ('approved', 'declined', 'locked') and old.status = 'pending')
    or (new.status = 'used' and old.status = 'approved')) then
    raise exception 'approval status can''t go from % to %', old.status, new.status;
  end if;
  return new;
end;
$$;

drop trigger if exists approvals_terms_immutable on public.approvals;
create trigger approvals_terms_immutable before update on public.approvals
  for each row execute function public.haggle_approval_terms_immutable();
