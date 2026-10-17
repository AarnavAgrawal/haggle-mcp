-- Haggle buyer-side core schema (owner: Yash / buyer side).
-- Money is stored as integer cents (bigint); USDC amounts as integer base units (numeric(78,0)).
-- Row Level Security is enabled on every table with NO policies for anon/authenticated:
-- only the server (service_role, which bypasses RLS) can read or write. Clients never touch
-- these tables directly; privileged payment mutations happen only in the MCP server.

create table public.jobs (
  id                     text primary key check (id ~ '^job_[A-Za-z0-9]{6,40}$'),
  state                  text not null check (state in (
                           'created','dispatching','collecting_quotes','clarifying','negotiating','comparing',
                           'awaiting_approval','approved','rejected','payment_pending','payment_failed',
                           'settled','cancelled','expired','failed')),
  version                integer not null default 0 check (version >= 0),
  intent                 text not null check (length(intent) between 3 and 2000),
  title                  text not null,
  category               text,
  budget_cents           bigint not null check (budget_cents >= 0),
  spend_cap_cents        bigint not null check (spend_cap_cents >= 0),
  deadline               timestamptz not null,
  reply_by               timestamptz not null,
  requirements           jsonb not null default '[]'::jsonb check (jsonb_typeof(requirements) = 'array'),
  approver_email         text not null check (approver_email = lower(approver_email)),
  inbox                  text not null unique check (inbox = lower(inbox)),
  max_negotiation_rounds smallint not null default 2 check (max_negotiation_rounds between 0 and 5),
  metadata               jsonb not null default '{}'::jsonb,
  mode                   text not null check (mode in ('live','mock')),
  event_seq              bigint not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint jobs_cap_within_budget check (spend_cap_cents <= budget_cents),
  constraint jobs_reply_before_deadline check (reply_by <= deadline)
);
create index jobs_state_idx on public.jobs (state) where state not in ('settled','cancelled','expired','failed');

create table public.sellers (
  id            text primary key check (id ~ '^sel_[A-Za-z0-9]{6,40}$'),
  email         text not null unique check (email = lower(email)),
  display_name  text,
  kind          text not null default 'unknown' check (kind in ('agent','human','unknown')),
  domain        text not null,
  created_at    timestamptz not null default now()
);
create index sellers_domain_idx on public.sellers (domain);

create table public.seller_conversations (
  job_id             text not null references public.jobs(id) on delete cascade,
  seller_id          text not null references public.sellers(id),
  state              text not null check (state in (
                       'pending','contacted','replied','clarifying','negotiating','quoted','declined',
                       'unresponsive','won','lost','withdrawn','blocked')),
  version            integer not null default 0,
  rfq_message_id     text,
  thread_message_ids text[] not null default '{}',
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  sender_verified    boolean not null default false,
  current_quote_id   text,
  rounds_used        smallint not null default 0 check (rounds_used >= 0),
  primary key (job_id, seller_id)
);
create index seller_conversations_thread_idx on public.seller_conversations using gin (thread_message_ids);

-- Raw webhook deliveries, deduplicated by provider event id before any processing.
create table public.webhook_events (
  provider          text not null,
  provider_event_id text not null,
  event_type        text not null,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  status            text not null default 'received' check (status in ('received','processed','quarantined','failed')),
  error             text,
  payload           jsonb not null,
  primary key (provider, provider_event_id)
);

create table public.email_messages (
  id                   text primary key check (id ~ '^msg_[A-Za-z0-9]{6,40}$'),
  job_id               text references public.jobs(id) on delete cascade,  -- null = quarantined
  seller_id            text references public.sellers(id),
  direction            text not null check (direction in ('inbound','outbound')),
  provider_message_id  text not null unique,
  rfc_message_id       text,
  in_reply_to          text,
  "references"         text[] not null default '{}',
  from_address         text not null,
  to_addresses         text[] not null,
  subject              text not null,
  body_text            text,
  body_html            text,
  attachments          jsonb not null default '[]'::jsonb,
  auth                 jsonb,
  kind                 text not null,
  quarantine_reason    text,
  received_at          timestamptz not null default now(),
  constraint email_quarantine_consistent check ((job_id is null) = (quarantine_reason is not null) or direction = 'outbound')
);
create index email_messages_job_idx on public.email_messages (job_id, received_at);
create index email_messages_rfc_idx on public.email_messages (rfc_message_id);
create index email_messages_quarantine_idx on public.email_messages (received_at) where job_id is null;

create table public.quotes (
  id                   text primary key check (id ~ '^q_[A-Za-z0-9]{6,40}$'),
  job_id               text not null references public.jobs(id) on delete cascade,
  seller_id            text not null references public.sellers(id),
  revision             integer not null check (revision > 0),
  supersedes           text references public.quotes(id),
  status               text not null check (status in ('current','superseded','expired','withdrawn')),
  source_message_id    text not null references public.email_messages(id),
  source               text not null,
  -- Denormalized for ranking queries; null means unknown, never zero.
  total_cents          bigint check (total_cents >= 0),
  deposit_cents        bigint check (deposit_cents >= 0),
  meets_requirements   text not null check (meets_requirements in ('yes','no','unknown')),
  confidence           numeric(4,3) not null check (confidence between 0 and 1),
  valid_until          timestamptz,
  negotiation_round    smallint not null default 0,
  body                 jsonb not null,   -- full normalized Quote (with provenance)
  created_at           timestamptz not null default now(),
  unique (job_id, seller_id, revision)
);
-- At most one current quote per seller per job.
create unique index quotes_one_current_idx on public.quotes (job_id, seller_id) where status = 'current';

alter table public.seller_conversations
  add constraint seller_conversations_current_quote_fk foreign key (current_quote_id) references public.quotes(id);

create table public.seller_questions (
  id                 text primary key check (id ~ '^sq_[A-Za-z0-9]{6,40}$'),
  job_id             text not null references public.jobs(id) on delete cascade,
  seller_id          text not null references public.sellers(id),
  source_message_id  text not null references public.email_messages(id),
  question           text not null,
  status             text not null check (status in ('open','auto_answered','answered','escalated','dismissed')),
  answer             text,
  answered_by        text check (answered_by in ('haggle_from_job_context','buyer_agent')),
  answer_message_id  text references public.email_messages(id),
  created_at         timestamptz not null default now(),
  answered_at        timestamptz,
  constraint seller_questions_answer_consistent check ((status in ('answered','auto_answered')) = (answer is not null))
);
create index seller_questions_open_idx on public.seller_questions (job_id) where status in ('open','escalated');

create table public.negotiation_rounds (
  id                   text primary key check (id ~ '^rnd_[A-Za-z0-9]{6,40}$'),
  job_id               text not null references public.jobs(id) on delete cascade,
  seller_id            text not null references public.sellers(id),
  round                smallint not null check (round > 0),
  kind                 text not null check (kind in ('clarification_request','counteroffer','seller_counter','accepted','declined')),
  target_total_cents   bigint check (target_total_cents >= 0),
  basis_quote_id       text references public.quotes(id),
  basis_summary        text,
  outbound_message_id  text references public.email_messages(id),
  response_message_id  text references public.email_messages(id),
  respond_by           timestamptz,
  outcome              text not null check (outcome in ('pending','improved','unchanged','declined','expired')),
  created_at           timestamptz not null default now(),
  -- A counteroffer must cite a real competing quote: never an invented one.
  constraint counteroffer_has_basis check (kind <> 'counteroffer' or (basis_quote_id is not null and target_total_cents is not null)),
  unique (job_id, seller_id, round, kind)
);

create table public.approval_requests (
  id                  text primary key check (id ~ '^apr_[A-Za-z0-9]{6,40}$'),
  job_id              text not null references public.jobs(id) on delete cascade,
  quote_id            text not null references public.quotes(id),
  seller_id           text not null references public.sellers(id),
  quote_revision      integer not null,
  quoted_total_cents  bigint not null check (quoted_total_cents >= 0),
  max_payment_cents   bigint not null check (max_payment_cents >= 0),
  channel             text not null check (channel in ('elicitation','email')),
  approver_email      text not null,
  nonce_hash          text unique,
  approval_message_id text references public.email_messages(id),
  status              text not null check (status in ('pending','approved','declined','expired','invalidated')),
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  constraint approval_max_within_total check (max_payment_cents <= quoted_total_cents)
);
-- One live approval request per job at a time.
create unique index approval_requests_one_pending_idx on public.approval_requests (job_id) where status = 'pending';

create table public.approval_records (
  id                 text primary key check (id ~ '^apr_[A-Za-z0-9]{6,40}$'),
  request_id         text not null unique references public.approval_requests(id),
  job_id             text not null references public.jobs(id) on delete cascade,
  quote_id           text not null references public.quotes(id),
  seller_id          text not null references public.sellers(id),
  quote_revision     integer not null,
  approved_max_cents bigint not null check (approved_max_cents >= 0),
  decision           text not null check (decision in ('approved','declined')),
  channel            text not null check (channel in ('elicitation','email')),
  approver           text not null,
  evidence           jsonb not null,
  consumed_at        timestamptz,
  decided_at         timestamptz not null default now()
);

create table public.payment_challenges (
  id                     text primary key check (id ~ '^chl_[A-Za-z0-9]{6,40}$'),
  job_id                 text not null references public.jobs(id) on delete cascade,
  seller_id              text not null references public.sellers(id),
  source_message_id      text not null references public.email_messages(id),
  -- Primitive x402: interaction_id is '<uuid>@<payee-domain>'; the step id names the challenge step.
  interaction_id         text not null,
  challenge_step_id      text not null,
  payee_address          text not null check (payee_address ~ '^0x[a-fA-F0-9]{40}$'),
  issuer_email           text not null,
  issuer_authenticated   boolean not null,
  network                text not null,
  amount_base_units      numeric(78,0) not null check (amount_base_units >= 0),
  asset                  text not null,
  expires_at             timestamptz,
  status                 text not null check (status in ('received','held','consumed','rejected','expired')),
  rejection_reason       text,
  raw                    jsonb not null,
  received_at            timestamptz not null default now(),
  unique (interaction_id, challenge_step_id)
);

create table public.payment_attempts (
  id                 text primary key check (id ~ '^pay_[A-Za-z0-9]{6,40}$'),
  job_id             text not null references public.jobs(id) on delete cascade,
  challenge_id       text not null unique references public.payment_challenges(id), -- one attempt per challenge
  approval_id        text not null references public.approval_records(id),
  amount_base_units  numeric(78,0) not null check (amount_base_units > 0),
  network            text not null check (network = 'base-sepolia'),  -- testnet only, enforced in the database too
  idempotency_key    text not null unique,
  status             text not null check (status in ('signing','submitted','settled','failed')),
  gateway            text not null check (gateway in ('primitive_x402','fake')),
  failure_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- At most one live-or-settled payment per job: concurrent pay() calls cannot double-pay.
create unique index payment_attempts_one_active_idx on public.payment_attempts (job_id) where status in ('signing','submitted','settled');
-- An approval can back at most one non-failed payment.
create unique index payment_attempts_one_per_approval_idx on public.payment_attempts (approval_id) where status <> 'failed';

create table public.payment_receipts (
  payment_id         text primary key references public.payment_attempts(id),
  job_id             text not null references public.jobs(id) on delete cascade,
  network            text not null check (network = 'base-sepolia'),
  settle_tx          text not null unique,
  explorer_url       text,
  amount_base_units  numeric(78,0) not null,
  real_settlement    boolean not null,
  source_message_id  text references public.email_messages(id),
  settled_at         timestamptz not null default now()
);

create table public.audit_events (
  id        text primary key check (id ~ '^evt_[A-Za-z0-9]{6,40}$'),
  job_id    text references public.jobs(id) on delete cascade,
  seq       bigint not null,
  type      text not null check (type ~ '^[a-z_]+\.[a-z_]+$'),
  actor     text not null check (actor in ('buyer_agent','human','seller','haggle','system')),
  summary   text not null,
  data      jsonb not null default '{}'::jsonb,
  at        timestamptz not null default now(),
  unique (job_id, seq)
);
create index audit_events_job_seq_idx on public.audit_events (job_id, seq);

-- Append an audit event with a gap-free per-job sequence number (the wait_for_update cursor).
-- The UPDATE takes a row lock on the job, serializing concurrent appends for that job.
create or replace function public.haggle_append_event(
  p_id text, p_job_id text, p_type text, p_actor text, p_summary text, p_data jsonb
) returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare v_seq bigint;
begin
  update public.jobs set event_seq = event_seq + 1, updated_at = now()
    where id = p_job_id returning event_seq into v_seq;
  if v_seq is null then
    raise exception 'unknown job %', p_job_id using errcode = 'foreign_key_violation';
  end if;
  insert into public.audit_events (id, job_id, seq, type, actor, summary, data)
    values (p_id, p_job_id, v_seq, p_type, p_actor, p_summary, coalesce(p_data, '{}'::jsonb));
  return v_seq;
end;
$$;

-- Audit events are append-only. The one exception is a cascade from deleting the whole job
-- (demo reset): cascaded deletes run inside the FK trigger, so pg_trigger_depth() > 1.
create or replace function public.haggle_audit_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'audit_events is append-only';
end;
$$;
create trigger audit_events_no_update before update or delete on public.audit_events
  for each row execute function public.haggle_audit_immutable();

-- Lock everything down: RLS on, no policies => anon/authenticated get nothing.
do $$
declare t text;
begin
  foreach t in array array[
    'jobs','sellers','seller_conversations','webhook_events','email_messages','quotes','seller_questions',
    'negotiation_rounds','approval_requests','approval_records','payment_challenges','payment_attempts',
    'payment_receipts','audit_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke execute on function public.haggle_append_event(text, text, text, text, text, jsonb) from public, anon, authenticated;
