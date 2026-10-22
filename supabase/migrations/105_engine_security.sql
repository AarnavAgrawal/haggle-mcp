-- 105_engine_security (owner: Yash). Production-security pass 1 (2026-10-21):
--   * workspaces.revoked_at: a revoked workspace's token and connector secret no longer resolve
--     (scripts/workspace-admin.ts revoke / rotate);
--   * quotes are immutable apart from their status: an approval binds a quote id, so the amounts,
--     the record (items, terms, validity) and the business it names can never change under it;
--   * an approval must name a quote of its own job and business, at that quote's total.
-- Additive only: no existing check, trigger or policy is relaxed.

alter table public.workspaces add column revoked_at timestamptz;

create or replace function public.haggle_quote_immutable() returns trigger
language plpgsql as $$
begin
  if new.id <> old.id or new.job_id <> old.job_id or new.business_id <> old.business_id or new.message_id <> old.message_id
     or new.round <> old.round or new.record <> old.record or new.total_cents is distinct from old.total_cents
     or new.deposit_cents is distinct from old.deposit_cents or new.compliant <> old.compliant
     or new.requirement_results <> old.requirement_results or new.sender_trusted <> old.sender_trusted or new.source <> old.source then
    raise exception 'a quote is immutable apart from its status (a revision is a new quote)';
  end if;
  return new;
end;
$$;
create trigger quotes_immutable before update on public.quotes
  for each row execute function public.haggle_quote_immutable();

create or replace function public.haggle_approval_matches_quote() returns trigger
language plpgsql as $$
declare q record;
begin
  select job_id, business_id, total_cents into q from public.quotes where id = new.quote_id;
  if q.job_id is distinct from new.job_id or q.business_id is distinct from new.business_id or q.total_cents is distinct from new.quote_total_cents then
    raise exception 'approval must name its own job''s quote, business and total';
  end if;
  return new;
end;
$$;
create trigger approvals_match_quote before insert on public.approvals
  for each row execute function public.haggle_approval_matches_quote();
