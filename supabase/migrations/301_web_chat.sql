-- 301_web_chat: the web app's requirement-gathering chat (apps/web/lib/chat/store.ts).
-- One thread per conversation, owned by a user in a workspace; messages are the Anthropic API turns
-- (content jsonb, thinking and tool blocks included), append-only, read back in id order.
-- The web backend writes with the service role after checking the user's membership; users read only
-- their own threads and messages. Nobody else writes them.
-- Safe to re-run (idempotent: if-not-exists and guarded policies/foreign key).
--
-- The link to auth.users and the row-level-security policies need Supabase's auth schema; on a plain
-- Postgres (scripts/verify-migrations.sh) the tables are created without them.

create table if not exists public.chat_threads (
  id           uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null,
  title        text,
  job_id       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists chat_threads_owner_recent_idx on public.chat_threads (user_id, workspace_id, updated_at desc);
create index if not exists chat_threads_workspace_idx on public.chat_threads (workspace_id);

create table if not exists public.chat_messages (
  id         bigserial primary key,
  thread_id  uuid not null references public.chat_threads(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_thread_idx on public.chat_messages (thread_id, id);

alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;

do $$
begin
  if to_regclass('auth.users') is not null then
    if not exists (select 1 from pg_constraint where conname = 'chat_threads_user_fk') then
      alter table public.chat_threads
        add constraint chat_threads_user_fk foreign key (user_id) references auth.users(id) on delete cascade;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chat_threads' and policyname = 'users read their own chat threads') then
      execute 'create policy "users read their own chat threads" on public.chat_threads for select to authenticated using (user_id = auth.uid())';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chat_messages' and policyname = 'users read their own chat messages') then
      execute 'create policy "users read their own chat messages" on public.chat_messages for select to authenticated using (exists (select 1 from public.chat_threads t where t.id = chat_messages.thread_id and t.user_id = auth.uid()))';
    end if;
  end if;
end $$;
