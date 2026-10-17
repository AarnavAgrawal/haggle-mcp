-- 101_engine_channels.sql (owner: Yash). v5 additions on top of 100_engine_core.sql:
--   * businesses are reached on a channel (email | phone | a2a | imessage); phone-only businesses
--     have no email, so email becomes nullable and the snapshot now also pins phone;
--   * call states for businesses (ringing, no_reply) and "unavailable" (channel not enabled);
--   * messages record their channel; a placed call is an outbound 'call' message;
--   * human approval from the approval view ('view') or iMessage ('imessage');
--   * buyer settings (one row; changed only through the settings tools, never by business mail);
--   * one shared Inkbox buyer mailbox serves every job, so jobs.inbox is no longer unique.

alter table public.jobs drop constraint jobs_inbox_key;

alter table public.job_businesses alter column email drop not null;
alter table public.job_businesses add column phone text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$');
alter table public.job_businesses add column a2a_card_url text check (a2a_card_url is null or a2a_card_url ~ '^https://');
alter table public.job_businesses add column channel text not null default 'email' check (channel in ('email','phone','a2a','imessage'));
alter table public.job_businesses add constraint job_businesses_contactable check (email is not null or phone is not null or a2a_card_url is not null);
alter table public.job_businesses add constraint job_businesses_channel_has_address check (
  (channel <> 'email' or email is not null) and (channel <> 'phone' or phone is not null) and (channel <> 'a2a' or a2a_card_url is not null));
create unique index job_businesses_phone_idx on public.job_businesses(job_id, phone) where phone is not null;

alter table public.job_businesses drop constraint job_businesses_status_check;
alter table public.job_businesses add constraint job_businesses_status_check check (status in
  ('pending','contacted','replied','quoted','question','declined','bounced','silent','ringing','no_reply','unavailable'));

-- Snapshot immutability now null-safe and covering the phone number.
create or replace function public.haggle_snapshot_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.business_id is distinct from old.business_id or new.name is distinct from old.name
     or new.email is distinct from old.email or new.phone is distinct from old.phone
     or new.a2a_card_url is distinct from old.a2a_card_url or new.job_id is distinct from old.job_id then
    raise exception 'business snapshot is immutable';
  end if;
  return new;
end;
$$;

alter table public.messages add column channel text not null default 'email' check (channel in ('email','phone','a2a','imessage'));
alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in
  ('rfq','reply','followup','answer','counter','approval_request','approval_reply','accept','payment','receipt','cancel','quarantine','call'));

alter table public.approvals drop constraint approvals_channel_check;
alter table public.approvals add constraint approvals_channel_check check (channel in ('elicitation','email','simulated','view','imessage'));

create table public.engine_settings (
  id                 integer primary key check (id = 1),
  spending_cap_cents bigint not null check (spending_cap_cents > 0),
  approver_phone     text check (approver_phone is null or approver_phone ~ '^\+[1-9][0-9]{6,14}$'),
  approver_email     text check (approver_email is null or approver_email = lower(approver_email)),
  default_area       text check (default_area is null or length(default_area) between 2 and 200),
  updated_at         timestamptz not null default now()
);
create index jobs_updated_idx on public.jobs(updated_at desc);

alter table public.engine_settings enable row level security;
alter table public.engine_settings force row level security;
revoke all on public.engine_settings from anon, authenticated;
