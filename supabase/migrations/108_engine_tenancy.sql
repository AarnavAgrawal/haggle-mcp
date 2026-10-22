-- 108_engine_tenancy (owner: Yash). Overnight sprint workstream B: workspace isolation for texts.
--   * text_routes: what Haggle last texted each remote number from each of its lines, per job and
--     purpose (the human approver, or a texted business). Replaces the per-process lastSms map, so
--     a restart or another replica routes a reply to the same job and workspace. A route's
--     workspace is always its job's workspace (trigger).
--   * held_texts: texts to the human refused while Inkbox paused that number, re-sent when the
--     number texts back. Taken atomically (delete ... returning), so two replicas never both resend.
--   * suppression_removals: the operator's escape hatch for a wrong opt-out or bounce
--     (workspace-admin remove-suppression), append-only, with who removed it and why.
--   * workspace_vendors.channel: how an operator-authorized vendor is reached (deal by name).
-- Additive only: no existing check, trigger or policy is relaxed.

create table public.text_routes (
  line         text not null check (length(line) between 1 and 64),
  remote       text not null check (length(remote) between 3 and 32),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  job_id       text not null references public.jobs(id) on delete cascade,
  purpose      text not null check (purpose in ('human','business')),
  business_id  text,
  question_id  text,
  approval_id  text,
  last_out_at  timestamptz not null,
  primary key (line, remote, job_id, purpose),
  check ((purpose = 'business') = (business_id is not null)),
  check (purpose = 'human' or (question_id is null and approval_id is null))
);
create index text_routes_remote_idx on public.text_routes(line, remote, last_out_at desc);

create table public.held_texts (
  line         text not null check (length(line) between 1 and 64),
  remote       text not null check (length(remote) between 3 and 32),
  key          text not null check (length(key) between 1 and 300),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  job_id       text not null references public.jobs(id) on delete cascade,
  text         text not null check (length(text) between 1 and 640),
  question_id  text,
  approval_id  text,
  held_at      timestamptz not null default now(),
  primary key (line, remote, key)
);
create index held_texts_approval_idx on public.held_texts(approval_id) where approval_id is not null;

-- A route or held text can never point at another workspace's job.
create or replace function public.haggle_text_workspace_matches_job() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from public.jobs j where j.id = new.job_id and j.workspace_id = new.workspace_id) then
    raise exception 'text row workspace must be its job''s workspace';
  end if;
  return new;
end;
$$;
create trigger text_routes_workspace before insert or update on public.text_routes
  for each row execute function public.haggle_text_workspace_matches_job();
create trigger held_texts_workspace before insert or update on public.held_texts
  for each row execute function public.haggle_text_workspace_matches_job();

create table public.suppression_removals (
  id            bigserial primary key,
  contact       text not null check (length(contact) between 3 and 320),
  reason        text not null check (reason in ('opt_out','bounce')),
  job_id        text,
  evidence      text,
  suppressed_at timestamptz not null,
  removed_by    text not null check (length(removed_by) between 1 and 120),
  why           text not null check (length(why) between 3 and 500),
  removed_at    timestamptz not null default now()
);

create or replace function public.haggle_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;
create trigger suppression_removals_append_only before update or delete on public.suppression_removals
  for each row execute function public.haggle_append_only();

alter table public.workspace_vendors add column channel text
  check (channel is null or (channel = 'email' and position('@' in contact) > 0) or (channel in ('phone','imessage') and contact like '+%'));

do $$
declare t text;
begin
  foreach t in array array['text_routes','held_texts','suppression_removals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.suppression_removals_id_seq from anon, authenticated;
