-- 104_engine_read_indexes.sql (owner: Yash). Read paths only, no schema change: the deal board,
-- list_deals and cross-job contact learning look rows up by job and by business, and the only
-- indexes there were partial (current quotes, pending approvals, active payments), so every board
-- load scanned quotes, questions, approvals, payments and (per business) messages and job rows.
-- Safe to apply on a live database at any time; nothing depends on it.

create index if not exists quotes_job_idx on public.quotes(job_id, created_at);
create index if not exists quotes_business_idx on public.quotes(business_id, created_at);
create index if not exists messages_business_idx on public.messages(business_id, created_at) where business_id is not null;
create index if not exists questions_job_idx on public.questions(job_id, created_at);
create index if not exists approvals_job_idx on public.approvals(job_id, created_at desc);
create index if not exists payments_job_idx on public.payments(job_id, created_at desc);
create index if not exists job_businesses_email_idx on public.job_businesses(email) where email is not null;
create index if not exists job_businesses_phone_lookup_idx on public.job_businesses(phone) where phone is not null;
