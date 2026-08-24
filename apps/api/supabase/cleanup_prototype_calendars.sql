begin;

-- One-time removal of the four calendars created by the original prototype
-- seed. This deliberately never targets schools, Supabase Auth, the private
-- admin mapping, Storage buckets, or Storage objects.
set local lock_timeout = '5s';

-- Keep the inventory stable while the guards run. Ordinary reads continue,
-- but a concurrent upload/report write makes this script wait briefly and then
-- abort instead of racing it.
lock table
  public.academic_calendars,
  public.calendar_events,
  public.calendar_uploads,
  public.calendar_reports
in share row exclusive mode;

create temporary table prototype_calendar_cleanup_expected (
  id uuid primary key,
  school_id text not null unique
) on commit drop;

insert into prototype_calendar_cleanup_expected (id, school_id)
values
  ('e6a4435a-450f-479f-bb76-6e7880e6ac55'::uuid, 'uiuc'),
  ('e7eef8ff-19b5-4c0a-8029-08d35b2a803a'::uuid, 'berkeley'),
  ('86b3dc1e-8f86-49e3-b2ec-5685be4d2c78'::uuid, 'nyu'),
  ('9d8cba94-663d-44c7-b45b-1b0031043650'::uuid, 'purdue');

do $cleanup$
declare
  existing_expected_count integer;
  matching_target_count integer;
  marked_calendar_count integer;
  target_event_count integer;
  target_upload_count integer;
  target_report_count integer;
  deleted_calendar_count integer;
begin
  select count(*)
  into existing_expected_count
  from public.academic_calendars as calendar
  join prototype_calendar_cleanup_expected as expected
    on expected.id = calendar.id;

  select count(*)
  into marked_calendar_count
  from public.academic_calendars
  where extraction_model = 'development-seed';

  -- A successful earlier run leaves neither the exact UUIDs nor any calendar
  -- carrying the old marker. Treat that state as a clean no-op.
  if existing_expected_count = 0 and marked_calendar_count = 0 then
    raise notice 'Prototype calendars are already absent; no cleanup was needed.';
    return;
  end if;

  if existing_expected_count <> 4 then
    raise exception
      'Prototype cleanup aborted: expected either zero or four known calendar UUIDs, found %.',
      existing_expected_count;
  end if;

  select count(*)
  into matching_target_count
  from public.academic_calendars as calendar
  join prototype_calendar_cleanup_expected as expected
    on expected.id = calendar.id
    and expected.school_id = calendar.school_id
  where calendar.academic_year = '2026-27'
    and calendar.version = 1
    and calendar.status = 'published'
    and calendar.source_type = 'manual'
    and calendar.extraction_model = 'development-seed'
    and calendar.submitted_by is null
    and calendar.official_source_url is null;

  if matching_target_count <> 4 or marked_calendar_count <> 4 then
    raise exception
      'Prototype cleanup aborted: known rows or development-seed marker inventory changed.';
  end if;

  select count(*)
  into target_event_count
  from public.calendar_events as event
  join prototype_calendar_cleanup_expected as expected
    on expected.id = event.calendar_id;

  if target_event_count <> 16 then
    raise exception
      'Prototype cleanup aborted: expected 16 child events, found %.',
      target_event_count;
  end if;

  select count(*)
  into target_upload_count
  from public.calendar_uploads as upload
  join prototype_calendar_cleanup_expected as expected
    on expected.id = upload.calendar_id;

  if target_upload_count <> 0 then
    raise exception
      'Prototype cleanup aborted: the target calendars now have % upload rows.',
      target_upload_count;
  end if;

  select count(*)
  into target_report_count
  from public.calendar_reports as report
  join prototype_calendar_cleanup_expected as expected
    on expected.id = report.calendar_id;

  if target_report_count <> 0 then
    raise exception
      'Prototype cleanup aborted: the target calendars now have % report rows.',
      target_report_count;
  end if;

  delete from public.academic_calendars as calendar
  using prototype_calendar_cleanup_expected as expected
  where calendar.id = expected.id;

  get diagnostics deleted_calendar_count = row_count;
  if deleted_calendar_count <> 4 then
    raise exception
      'Prototype cleanup aborted: expected to delete four calendars, deleted %.',
      deleted_calendar_count;
  end if;

  -- calendar_events and calendar_uploads cascade from academic_calendars.
  -- calendar_reports uses ON DELETE RESTRICT as a final database-level guard.
  if exists (
    select 1
    from public.calendar_events as event
    join prototype_calendar_cleanup_expected as expected
      on expected.id = event.calendar_id
  ) then
    raise exception 'Prototype cleanup aborted: child events remain after deletion.';
  end if;

  raise notice 'Removed four prototype calendars and their 16 child events.';
end
$cleanup$;

commit;
