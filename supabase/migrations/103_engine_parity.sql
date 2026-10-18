-- 103_engine_parity.sql (owner: Yash). Features ported from haggle-testing (Errand):
--   * workspaces: tenants with hashed bearer tokens / connector secrets; jobs, settings and
--     client_request_id are scoped to one. Existing rows move to the 'ws_default' workspace and
--     engine_settings id=1 becomes its settings (the table is kept for rollback, no longer read);
--   * approvals: an action (confirm | pay | confirm_and_pay), a wrong-code counter, and 'locked'
--     after too many wrong codes; confirm-only approvals pay nothing (payment_cents = 0);
--   * jobs: terminal state 'confirmed' (a confirm-only approval was sent to the business);
--   * job_businesses: send retries (attempts + next attempt time) and email -> call escalation;
--   * messages: the agent's own guarded messages ('message') and post-approval 'confirmation's.

create table public.workspaces (
  id                    text primary key check (id ~ '^ws_[a-z0-9_]{3,40}$'),
  name                  text not null check (length(name) between 1 and 120),
  token_hash            text unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),          -- sha256(bearer token)
  connector_secret_hash text unique check (connector_secret_hash is null or connector_secret_hash ~ '^[0-9a-f]{64}$'), -- sha256(/c/<secret>/mcp)
  timezone              text not null default 'America/Los_Angeles',
  spending_cap_cents    bigint check (spending_cap_cents is null or spending_cap_cents > 0),
  approver_phone        text check (approver_phone is null or approver_phone ~ '^\+[1-9][0-9]{6,14}$'),
  approver_email        text check (approver_email is null or approver_email = lower(approver_email)),
  default_area          text check (default_area is null or length(default_area) between 2 and 200),
  settings_updated_at   timestamptz,
  created_at            timestamptz not null default now()
);

insert into public.workspaces (id, name, spending_cap_cents, approver_phone, approver_email, default_area, settings_updated_at)
select 'ws_default', 'Default workspace', s.spending_cap_cents, s.approver_phone, s.approver_email, s.default_area, s.updated_at
from (select 1) one left join public.engine_settings s on s.id = 1;

alter table public.jobs add column workspace_id text not null default 'ws_default' references public.workspaces(id);
alter table public.jobs drop constraint jobs_client_request_id_key;
alter table public.jobs add constraint jobs_workspace_client_request_key unique (workspace_id, client_request_id);
create index jobs_workspace_updated_idx on public.jobs(workspace_id, updated_at desc);

alter table public.jobs drop constraint jobs_state_check;
alter table public.jobs add constraint jobs_state_check check (state in
  ('created','contacting','collecting','negotiating','awaiting_approval','paying','paid','confirmed','cancelled','failed'));

alter table public.job_businesses add column send_attempts integer not null default 0 check (send_attempts between 0 and 10);
alter table public.job_businesses add column next_attempt_at timestamptz;
alter table public.job_businesses add column escalated_at timestamptz;

alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in
  ('rfq','reply','followup','answer','counter','approval_request','approval_reply','accept','payment','receipt','cancel','quarantine','call','message','confirmation'));
create index messages_phone_idx on public.messages(channel, to_address, from_address, created_at) where channel = 'phone';

alter table public.approvals add column action text not null default 'confirm_and_pay' check (action in ('confirm','pay','confirm_and_pay'));
alter table public.approvals add column attempts integer not null default 0 check (attempts between 0 and 20);
alter table public.approvals drop constraint approvals_status_check;
alter table public.approvals add constraint approvals_status_check check (status in ('pending','approved','declined','expired','used','locked'));
-- A confirm-only approval moves no money; every paying approval still has a positive amount.
alter table public.approvals drop constraint approvals_payment_cents_check;
alter table public.approvals add constraint approvals_payment_cents_check check (payment_cents >= 0 and (payment_cents > 0 or action = 'confirm'));
alter table public.approvals drop constraint approvals_quote_total_cents_check;
alter table public.approvals add constraint approvals_quote_total_cents_check check (quote_total_cents >= 0);

-- Money can only move for a paying approval (confirm-only approvals never get a payment row).
create or replace function public.haggle_payment_matches_approval() returns trigger
language plpgsql set search_path = '' as $$
declare a record;
begin
  select * into a from public.approvals where id = new.approval_id;
  if a.job_id <> new.job_id or a.business_id <> new.business_id or a.payment_cents <> new.amount_cents then
    raise exception 'payment does not match its approval';
  end if;
  if a.action = 'confirm' then
    raise exception 'a confirm-only approval cannot be paid';
  end if;
  if new.status in ('signed','sent','settled','charging') and a.status not in ('approved','used') then
    raise exception 'payment requires an approved approval';
  end if;
  return new;
end;
$$;

alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;
revoke all on public.workspaces from anon, authenticated;
