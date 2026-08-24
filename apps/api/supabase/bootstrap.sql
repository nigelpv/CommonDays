begin;

-- Keep authorization data outside Supabase's exposed public schema.
create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

alter default privileges in schema private
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema private
  revoke all on sequences from public, anon, authenticated;
alter default privileges in schema private
  revoke execute on functions from public, anon, authenticated;

-- The fixed primary-key value makes it impossible to store more than one admin.
create table if not exists private.app_admin (
  singleton smallint not null default 1,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  constraint app_admin_pkey primary key (singleton),
  constraint app_admin_singleton_check check (singleton = 1),
  constraint app_admin_user_id_key unique (user_id),
  constraint app_admin_user_id_fkey
    foreign key (user_id)
    references auth.users (id)
    on delete restrict
);

alter table private.app_admin enable row level security;
revoke all on table private.app_admin from public, anon, authenticated;

create or replace function private.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from private.app_admin as admin
    where admin.user_id = (select auth.uid())
  );
$function$;

-- Functions are executable by PUBLIC by default. Only signed-in users need to
-- evaluate this predicate; the function itself reveals only true or false.
revoke all on function private.is_app_admin() from public, anon, authenticated, service_role;
grant usage on schema private to authenticated;
grant execute on function private.is_app_admin() to authenticated;

-- These foreign keys intentionally live in the Supabase bootstrap rather than
-- the Drizzle schema because auth.users is owned by Supabase.
do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'academic_calendars_submitted_by_auth_users_fk'
      and conrelid = 'public.academic_calendars'::regclass
  ) then
    alter table public.academic_calendars
      add constraint academic_calendars_submitted_by_auth_users_fk
      foreign key (submitted_by)
      references auth.users (id)
      on delete set null;
  end if;
end
$block$;

do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'calendar_reports_submitted_by_auth_users_fk'
      and conrelid = 'public.calendar_reports'::regclass
  ) then
    alter table public.calendar_reports
      add constraint calendar_reports_submitted_by_auth_users_fk
      foreign key (submitted_by)
      references auth.users (id)
      on delete set null;
  end if;
end
$block$;

do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'calendar_reports_reviewed_by_auth_users_fk'
      and conrelid = 'public.calendar_reports'::regclass
  ) then
    alter table public.calendar_reports
      add constraint calendar_reports_reviewed_by_auth_users_fk
      foreign key (reviewed_by)
      references auth.users (id)
      on delete set null;
  end if;
end
$block$;

-- Source documents stay private. Uploads and downloads are performed only by
-- the trusted backend; this bootstrap deliberately creates no storage.objects
-- policies for anon or authenticated users.
insert into storage.buckets (
  id,
  name,
  "public",
  file_size_limit,
  allowed_mime_types
)
values (
  'calendar-sources',
  'calendar-sources',
  false,
  12582912,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  "public" = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
