-- 112_engine_inbound_review (owner: Yash). Sprint 4 workstream A: real email and vendor contact.
--   * messages.delivery_status / delivery_status_at: what Inkbox reported for one of Haggle's own
--     outbound emails after it was accepted (message.bounced / message.failed, or the reconciler's
--     outbound status sweep). Only outbound email rows carry one.
--   * quarantine_resolutions: an operator's decision on a quarantined (or unverified) inbound email,
--     append-only: the original reason, who decided, how it was independently verified (e.g. "phoned
--     the vendor at its listed number"), and when. One decision per message.
--   * A quarantined or unverified inbound message can become a trusted reply only through a recorded
--     release, and only as trust_reason 'operator_verified' (continuity-only in the engine: it can
--     produce a quote, never approve, pay, name a payee or confirm a booking on its own).
-- Additive only: nothing in 100-111 is edited or relaxed. Applies on top of 100-111 on its own.

alter table public.messages add column if not exists delivery_status text check (delivery_status is null or delivery_status in ('bounced','failed'));
alter table public.messages add column if not exists delivery_status_at timestamptz;
alter table public.messages drop constraint if exists messages_delivery_status_outbound;
alter table public.messages add constraint messages_delivery_status_outbound
  check (delivery_status is null or (direction = 'out' and channel = 'email' and delivery_status_at is not null));

create table if not exists public.quarantine_resolutions (
  id                    text primary key,
  message_id            text not null unique,
  job_id                text,
  business_id           text,
  decision              text not null check (decision in ('released','rejected')),
  original_reason       text not null check (length(original_reason) between 1 and 200),
  original_trust_reason text check (original_trust_reason is null or length(original_trust_reason) <= 100),
  resolved_by           text not null check (length(btrim(resolved_by)) between 2 and 80),
  verification          text not null check (length(btrim(verification)) between 10 and 500),
  released_trust_reason text,
  resolved_at           timestamptz not null default now(),
  check ((decision = 'released' and released_trust_reason = 'operator_verified' and job_id is not null and business_id is not null)
      or (decision = 'rejected' and released_trust_reason is null))
);
create index if not exists quarantine_resolutions_job_idx on public.quarantine_resolutions(job_id, resolved_at);

create or replace function public.haggle_resolutions_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;
drop trigger if exists quarantine_resolutions_append_only on public.quarantine_resolutions;
create trigger quarantine_resolutions_append_only before update or delete on public.quarantine_resolutions
  for each row execute function public.haggle_resolutions_append_only();

-- An inbound message stored as quarantined or untrusted becomes a trusted reply only through a
-- recorded release of that very message, as 'operator_verified', keeping its original quarantine reason.
create or replace function public.haggle_release_needs_resolution() returns trigger
language plpgsql as $$
begin
  if old.direction = 'in' and old.sender_trusted is not true and new.sender_trusted is true then
    if new.trust_reason is distinct from 'operator_verified' then
      raise exception 'an untrusted inbound message can only be trusted as operator_verified';
    end if;
    if not exists (select 1 from public.quarantine_resolutions r where r.message_id = old.id and r.decision = 'released'
                   and r.job_id is not distinct from new.job_id and r.business_id is not distinct from new.business_id) then
      raise exception 'releasing a quarantined message needs a recorded operator release for it';
    end if;
    if old.quarantine_reason is not null and new.quarantine_reason is distinct from old.quarantine_reason then
      raise exception 'a released message keeps its original quarantine reason';
    end if;
  end if;
  if old.kind = 'quarantine' and new.kind <> 'quarantine' and (new.kind <> 'reply' or new.sender_trusted is not true) then
    raise exception 'a quarantined message can only be released as a trusted reply';
  end if;
  return new;
end;
$$;
drop trigger if exists messages_release_needs_resolution on public.messages;
create trigger messages_release_needs_resolution before update on public.messages
  for each row execute function public.haggle_release_needs_resolution();

alter table public.quarantine_resolutions enable row level security;
alter table public.quarantine_resolutions force row level security;
revoke all on public.quarantine_resolutions from anon, authenticated;
revoke execute on function public.haggle_resolutions_append_only() from public, anon, authenticated;
revoke execute on function public.haggle_release_needs_resolution() from public, anon, authenticated;
