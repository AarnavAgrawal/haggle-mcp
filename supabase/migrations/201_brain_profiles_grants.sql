-- 201_brain_profiles_grants.sql — authored in the Yash integration pass for Aarnav's brain table
-- (2xx = Aarnav's space; please review). 200_brain_profiles creates the table with RLS forced but
-- grants nothing to service_role, and this Supabase project gives roles no default table
-- privileges: the brain's SupabaseStore (service-role key over PostgREST) got 42501
-- "permission denied for table brain_profiles". Also: client roles held TRUNCATE (not covered by
-- RLS). Server-side only: service_role reads/writes; anon/authenticated get nothing.

revoke all on public.brain_profiles from anon, authenticated;
grant select, insert, update, delete on public.brain_profiles to service_role;
