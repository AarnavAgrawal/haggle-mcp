-- Quote Broker schema (DESIGN.md §6). Run once in the Supabase SQL editor.
-- Money is integer cents. Timestamps are timestamptz.

create table if not exists jobs (
  id               uuid primary key default gen_random_uuid(),
  short_code       text unique not null,          -- e.g. "7F3K", used in subject tags
  status           text not null,                 -- see DESIGN.md §7
  version          int  not null default 0,       -- bump on every change; used by wait_for_job
  event            jsonb not null,                -- date, time, headcount, location, dietary, notes
  budget_per_head_cents int,
  max_rounds       int  not null default 1 check (max_rounds between 0 and 2),
  round            int  not null default 0,
  collect_until    timestamptz,
  client_request_id text unique,                  -- idempotency for create_quote_request
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists vendors (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs(id) on delete cascade,
  name             text not null,
  email            text,
  phone            text,                          -- stretch phone adapter only
  channel          text not null default 'email' check (channel in ('email','phone')),
  status           text not null default 'pending', -- pending, contacted, replied, no_reply, bounced, declined
  outbound_email_id   text,                       -- Primitive id of our outreach email
  outbound_message_id text,                       -- RFC Message-ID of our outreach email
  thread_id        text,                          -- Primitive thread id
  last_message_at  timestamptz
);
create index if not exists vendors_job_id_idx on vendors(job_id);
create index if not exists vendors_thread_id_idx on vendors(thread_id);
create index if not exists vendors_outbound_message_id_idx on vendors(outbound_message_id);

create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid references jobs(id) on delete cascade, -- null = unmatched inbound
  vendor_id        uuid references vendors(id),
  approval_id      uuid,                          -- set when the message is an approval reply
  direction        text not null check (direction in ('in','out')),
  kind             text not null default 'reply', -- outreach, counter, approval_request, receipt, cancel_note, reply, approval_reply
  round            int,                           -- negotiation round (counteroffers)
  channel          text not null default 'email',
  provider_email_id text unique,                  -- Primitive email.id (inbound) or sent-email id (outbound)
  rfc_message_id   text,                          -- RFC Message-ID header
  thread_id        text,
  from_address     text,
  subject          text,
  body_text        text,
  attachments      jsonb not null default '[]',   -- metadata only: filename, content_type, size_bytes, tar_path
  attachments_download_url text,                  -- tar.gz of attachments; expires, so parse soon
  sender_authenticated boolean,                   -- validateEmailAuth verdict == 'legit'
  parse_status     text not null default 'none',  -- none, pending, done, failed
  created_at       timestamptz not null default now()
);
create index if not exists messages_job_parse_idx on messages(job_id, parse_status);
create index if not exists messages_vendor_idx on messages(vendor_id, created_at desc);

create table if not exists quotes (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs(id) on delete cascade,
  vendor_id        uuid not null references vendors(id),
  source_message_id uuid not null references messages(id),
  round            int not null,
  available        boolean not null,
  price_per_head_cents int,
  headcount        int,
  subtotal_cents   int,
  delivery_fee_cents int,
  tax_cents        int,
  total_cents      int,
  deposit_cents    int,
  menu_items       jsonb not null default '[]',
  dietary_coverage jsonb not null default '{}',
  valid_until      date,
  missing_fields   text[] not null default '{}',
  confidence       real,
  is_current       boolean not null default true, -- newest quote per vendor
  created_at       timestamptz not null default now()
);
create index if not exists quotes_job_current_idx on quotes(job_id, is_current);
-- One quote per source message, so a re-run of the parser cannot double-insert.
create unique index if not exists quotes_source_message_idx on quotes(source_message_id);

create table if not exists approvals (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs(id) on delete cascade,
  quote_id         uuid not null references quotes(id),
  vendor_id        uuid not null references vendors(id),
  amount_cents     int not null,
  code             text not null,
  status           text not null default 'pending', -- pending, approved, declined, expired, used
  approver_email   text not null,
  outbound_email_id text,
  thread_id        text,
  decision_message_id uuid references messages(id),
  requested_at     timestamptz not null default now(),
  decided_at       timestamptz,
  expires_at       timestamptz not null,
  outbound_message_id text                        -- RFC Message-ID of the approval email
);
create index if not exists approvals_job_idx on approvals(job_id, requested_at desc);
create index if not exists approvals_thread_idx on approvals(thread_id);
-- At most one pending approval per job.
create unique index if not exists approvals_one_pending_idx on approvals(job_id) where status = 'pending';

create table if not exists payments (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs(id),
  approval_id      uuid not null unique references approvals(id), -- one payment per approval
  amount_cents     int not null,
  stripe_payment_intent_id text,
  status           text not null,                 -- succeeded, failed
  idempotency_key  text not null unique,
  created_at       timestamptz not null default now()
);

create table if not exists job_events (
  id               bigserial primary key,
  job_id           uuid not null references jobs(id) on delete cascade,
  type             text not null,
  data             jsonb not null default '{}',
  created_at       timestamptz not null default now()
);
create index if not exists job_events_job_idx on job_events(job_id, id desc);

create table if not exists webhook_events (
  id               text primary key,              -- Primitive top-level event id
  received_at      timestamptz not null default now()
);

-- ---------- Public mode (AUTH_MODE=oauth) ----------
-- Safe to re-run: every statement is "if not exists".

-- Who owns a job: the Supabase auth user id. Null in token mode (one operator).
alter table jobs add column if not exists owner_id uuid;
create index if not exists jobs_owner_created_idx on jobs(owner_id, created_at desc);

-- One row per signed-in user: their own Stripe TEST customer and card.
create table if not exists app_users (
  id               uuid primary key,              -- Supabase auth user id
  email            text not null,
  stripe_customer_id text,
  stripe_payment_method_id text,
  created_at       timestamptz not null default now()
);

-- Restaurant simulators running inside the server (SIM_ON_SERVER=true):
-- where each persona's inbox stream left off, and its last quoted prices.
create table if not exists sim_state (
  persona_id       text primary key,
  cursor           text,
  last_price       jsonb not null default '{}',   -- thread key -> per-head dollars
  updated_at       timestamptz not null default now()
);

-- The server uses the service-role key, which bypasses RLS. Enabling RLS with
-- no policies keeps these tables closed to the public anon key.
alter table app_users enable row level security;
alter table sim_state enable row level security;
alter table jobs enable row level security;
alter table vendors enable row level security;
alter table messages enable row level security;
alter table quotes enable row level security;
alter table approvals enable row level security;
alter table payments enable row level security;
alter table job_events enable row level security;
alter table webhook_events enable row level security;
