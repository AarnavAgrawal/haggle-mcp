-- 126_engine_workspace_identities (owner: Aarnav). A mailbox per workspace (HAGGLE_MAILBOX_PER_WORKSPACE,
-- off by default). Each workspace may get its own Inkbox agent identity (a mailbox, no phone): its
-- deals' email goes out from that mailbox (jobs.inbox) and replies come back to it, so a vendor's mail
-- for one user's request never lands in a mailbox shared with every other user. Phone, iMessage, voice
-- and approval texts stay on the shared buyer identity.
--   * workspace_identities: one row per workspace. `status` 'provisioning' is the cross-process claim
--     taken before Inkbox is called (insert ... on conflict do nothing); 'active' once the identity, its
--     mailbox address and its webhook signing key are stored; 'failed' after an error (retried later).
--     `webhook_secret` is the identity's webhook signing key (Inkbox returns it once): service-role
--     only, never exposed to clients. Handles are globally unique at Inkbox, so `handle` and `mailbox`
--     are unique here too.
--   * job_businesses_email_lower_idx: matching a new email (not a reply) by its sender's address
--     (PostgresRepository.findOpenBusinessesBySender, inbound/matching.ts rule 5).
-- RLS on, no client policies: only the server (service_role) reads or writes. Additive only; safe to re-run.

create table if not exists public.workspace_identities (
  workspace_id   text primary key references public.workspaces(id) on delete cascade,
  handle         text not null unique check (handle ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  identity_id    text,
  mailbox        text unique check (mailbox is null or (length(mailbox) <= 320 and mailbox = lower(mailbox))),
  webhook_secret text check (webhook_secret is null or length(webhook_secret) between 16 and 512),
  status         text not null default 'provisioning' check (status in ('provisioning', 'active', 'failed')),
  error          text check (error is null or length(error) <= 300),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (status <> 'active' or (identity_id is not null and mailbox is not null and webhook_secret is not null))
);

alter table public.workspace_identities enable row level security;
alter table public.workspace_identities force row level security;
revoke all on public.workspace_identities from anon, authenticated;

create index if not exists job_businesses_email_lower_idx on public.job_businesses (lower(email)) where email is not null;
