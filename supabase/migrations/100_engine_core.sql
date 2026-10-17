-- Haggle v3 engine schema (Yash). Mirrors packages/engine/src/store/types.ts.
-- Money: integer cents; USDC: base-unit text (6 decimals). Unknown is NULL, never 0.
-- Engine tables reference brain businesses only logically (business_id, contract D5): no FK
-- into 2xx_brain_* tables, and brain migrations never alter these tables (D11).
-- Safety invariants are enforced here, not only in code (quote-broker@8a68559 schema.sql ideas:
-- one quote per source message, one pending approval per job, one payment per approval).

create table public.jobs (
  id                text primary key,
  short_code        text not null unique check (short_code ~ '^[A-Z0-9]{4,8}$'),
  state             text not null check (state in ('created','contacting','collecting','negotiating','awaiting_approval','paying','paid','cancelled','failed')),
  mode              text not null check (mode in ('mock','live')),
  request           jsonb not null,
  budget_cents      integer check (budget_cents is null or budget_cents > 0),
  payment_cap_cents integer not null check (payment_cap_cents > 0 and payment_cap_cents <= 1000), -- x402 per-settle ceiling is 10 USDC
  approver_email    text check (approver_email is null or approver_email = lower(approver_email)),
  inbox             text not null unique,
  round             integer not null default 1 check (round between 1 and 3),
  max_rounds        integer not null check (max_rounds between 1 and 2),
  collect_until     timestamptz not null,
  ready             boolean not null default false,
  pay_intent        boolean not null default false,
  failure_reason    text,
  client_request_id text unique,
  version           integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.job_businesses (
  job_id                  text not null references public.jobs(id) on delete cascade,
  business_id             text not null check (business_id ~ '^biz_[0-9a-f]{16}$'), -- logical ref to brain businesses; no FK by design
  name                    text not null,
  email                   text not null check (email = lower(email)),
  source                  text not null check (source in ('fleet','web','agent')),
  simulated               boolean not null,
  status                  text not null check (status in ('pending','contacted','replied','quoted','question','declined','bounced','silent')),
  thread_id               text,
  rfq_message_id          text,
  last_inbound_message_id text,
  "references"            jsonb not null default '[]',
  contacted_at            timestamptz,
  last_reply_at           timestamptz,
  followups_sent          integer not null default 0 check (followups_sent between 0 and 3),
  countered_round         integer not null default 0,
  primary key (job_id, business_id),
  unique (job_id, email)
);
create index job_businesses_thread_idx on public.job_businesses(thread_id);

-- The per-job snapshot of who a business is can never change after RFQs go out.
create or replace function public.haggle_snapshot_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.business_id <> old.business_id or new.name <> old.name or new.email <> old.email or new.job_id <> old.job_id then
    raise exception 'business snapshot is immutable';
  end if;
  return new;
end;
$$;
create trigger job_businesses_snapshot before update on public.job_businesses
  for each row execute function public.haggle_snapshot_immutable();

create table public.messages (
  id                       text primary key,
  job_id                   text references public.jobs(id) on delete cascade,
  business_id              text,
  approval_id              text,
  direction                text not null check (direction in ('in','out')),
  kind                     text not null check (kind in ('rfq','reply','followup','answer','counter','approval_request','approval_reply','accept','payment','receipt','cancel','quarantine')),
  provider_email_id        text unique,
  idempotency_key          text unique,
  rfc_message_id           text,
  thread_id                text,
  from_address             text,
  to_address               text,
  subject                  text,
  body_text                text,
  attachments              jsonb not null default '[]',
  attachments_download_url text,
  sender_trusted           boolean,
  trust_reason             text,
  matched_via              text,
  parse_status             text not null check (parse_status in ('none','pending','done','failed')),
  quarantine_reason        text,
  round                    integer,
  simulated                boolean not null default false,
  created_at               timestamptz not null default now(),
  check (direction = 'in' or idempotency_key is not null),        -- every send has an idempotency key
  check (kind <> 'quarantine' or quarantine_reason is not null)
);
create index messages_job_idx on public.messages(job_id, parse_status);
create index messages_rfc_idx on public.messages(lower(btrim(rfc_message_id, '<>')));

create table public.quotes (
  id                  text primary key,
  job_id              text not null references public.jobs(id) on delete cascade,
  business_id         text not null,
  message_id          text not null unique references public.messages(id) on delete cascade, -- one quote per inbound email
  round               integer not null check (round >= 1),
  status              text not null check (status in ('current','superseded','expired','withdrawn')),
  record              jsonb not null,
  total_cents         integer check (total_cents is null or total_cents >= 0),
  deposit_cents       integer check (deposit_cents is null or deposit_cents >= 0),
  compliant           boolean not null,
  requirement_results jsonb not null,
  sender_trusted      boolean not null,
  source              text not null,
  created_at          timestamptz not null default now(),
  foreign key (job_id, business_id) references public.job_businesses(job_id, business_id) on delete cascade,
  check (deposit_cents is null or total_cents is null or deposit_cents <= total_cents), -- a deposit is part of the total
  check (not compliant or total_cents is not null)
);
create unique index quotes_one_current_idx on public.quotes(job_id, business_id) where status = 'current';

create table public.questions (
  id          text primary key,
  job_id      text not null references public.jobs(id) on delete cascade,
  business_id text not null,
  message_id  text not null references public.messages(id) on delete cascade,
  text        text not null,
  status      text not null check (status in ('pending','answered')),
  answer      text,
  answered_at timestamptz,
  created_at  timestamptz not null default now(),
  check ((status = 'answered') = (answer is not null))
);

create table public.approvals (
  id                  text primary key,
  job_id              text not null references public.jobs(id) on delete cascade,
  quote_id            text not null references public.quotes(id),
  business_id         text not null,
  quote_total_cents   integer not null check (quote_total_cents > 0),
  payment_cents       integer not null check (payment_cents > 0),
  cap_cents           integer not null check (cap_cents > 0 and cap_cents <= 1000),
  approver            text,
  channel             text not null check (channel in ('elicitation','email','simulated')),
  status              text not null check (status in ('pending','approved','declined','expired','used')),
  code                text not null check (code ~ '^[0-9]{4}$'),
  expires_at          timestamptz not null,
  decided_at          timestamptz,
  outbound_message_id text,
  thread_id           text,
  created_at          timestamptz not null default now(),
  check (payment_cents <= cap_cents),
  check (payment_cents <= quote_total_cents),
  check (status in ('pending','expired') or decided_at is not null)
);
create unique index approvals_one_pending_idx on public.approvals(job_id) where status = 'pending';

-- Simulated approvals can only exist on mock-mode jobs.
create or replace function public.haggle_no_simulated_live() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.channel = 'simulated' and (select mode from public.jobs where id = new.job_id) <> 'mock' then
    raise exception 'simulated approval on a live job';
  end if;
  return new;
end;
$$;
create trigger approvals_no_simulated_live before insert or update on public.approvals
  for each row execute function public.haggle_no_simulated_live();

create table public.payments (
  id                       text primary key,
  job_id                   text not null references public.jobs(id) on delete cascade,
  approval_id              text not null unique references public.approvals(id), -- one payment per approval
  business_id              text not null,
  status                   text not null check (status in ('awaiting_invoice','invoice_received','signed','sent','settled','rejected','expired','failed')),
  amount_cents             integer not null check (amount_cents > 0 and amount_cents <= 1000),
  amount_base_units        text not null check (amount_base_units ~ '^[0-9]+$'),
  network                  text not null check (network = 'base-sepolia'),             -- testnet only
  challenge_json           text,
  challenge_step_id        text unique,
  challenge_message_id     text,
  challenge_trusted        boolean not null default false,
  challenge_thread_matched boolean not null default false,
  pay_to                   text,
  interaction_json         text,
  settle_tx                text,
  simulated                boolean not null,
  reason                   text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (amount_base_units = (amount_cents::numeric * 10000)::text),                      -- exact cents <-> USDC units
  check (status <> 'settled' or settle_tx is not null),
  check (status not in ('signed','sent','settled') or (challenge_step_id is not null and challenge_trusted and challenge_thread_matched))
);
create unique index payments_one_active_idx on public.payments(job_id) where status not in ('failed','rejected','expired');

-- A payment can only be signed for an approved (or already used) approval of the same job and business.
create or replace function public.haggle_payment_matches_approval() returns trigger
language plpgsql set search_path = '' as $$
declare a record;
begin
  select * into a from public.approvals where id = new.approval_id;
  if a.job_id <> new.job_id or a.business_id <> new.business_id or a.payment_cents <> new.amount_cents then
    raise exception 'payment does not match its approval';
  end if;
  if new.status in ('signed','sent','settled') and a.status not in ('approved','used') then
    raise exception 'payment requires an approved approval';
  end if;
  return new;
end;
$$;
create trigger payments_match_approval before insert or update on public.payments
  for each row execute function public.haggle_payment_matches_approval();

create table public.job_events (
  job_id text not null references public.jobs(id) on delete cascade,
  seq    integer not null check (seq >= 1),
  type   text not null,
  data   jsonb not null default '{}',
  at     timestamptz not null default now(),
  primary key (job_id, seq)
);

-- Gap-free per-job sequence (the wait_for_update cursor): serialised by locking the job row.
create or replace function public.haggle_append_event(p_job_id text, p_type text, p_data jsonb) returns integer
language plpgsql set search_path = '' as $$
declare v_seq integer;
begin
  perform 1 from public.jobs where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  select coalesce(max(seq), 0) + 1 into v_seq from public.job_events where job_id = p_job_id;
  insert into public.job_events (job_id, seq, type, data) values (p_job_id, v_seq, p_type, coalesce(p_data, '{}'::jsonb));
  return v_seq;
end;
$$;

-- The audit trail is append-only (cascade from deleting a whole job is allowed for demo resets).
create or replace function public.haggle_events_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'job_events is append-only';
end;
$$;
create trigger job_events_append_only before update or delete on public.job_events
  for each row execute function public.haggle_events_immutable();

create table public.inbound_events (
  provider_event_id text primary key,
  received_at       timestamptz not null default now()
);

-- Lock everything down: RLS on and forced, no policies, nothing for anon/authenticated.
do $$
declare t text;
begin
  foreach t in array array['jobs','job_businesses','messages','quotes','questions','approvals','payments','job_events','inbound_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke execute on function public.haggle_append_event(text, text, jsonb) from public, anon, authenticated;
