begin;

insert into public.schools (
  id,
  name,
  short_name,
  location,
  initials,
  color
)
values
  (
    'uiuc',
    'University of Illinois Urbana-Champaign',
    'UIUC',
    'Champaign, Illinois',
    'IL',
    '#6574f7'
  ),
  (
    'berkeley',
    'University of California, Berkeley',
    'UC Berkeley',
    'Berkeley, California',
    'CA',
    '#ff765f'
  ),
  (
    'nyu',
    'New York University',
    'NYU',
    'New York, New York',
    'NY',
    '#1fb09f'
  ),
  (
    'purdue',
    'Purdue University',
    'Purdue',
    'West Lafayette, Indiana',
    'IN',
    '#bd8c32'
  ),
  (
    'michigan',
    'University of Michigan',
    'Michigan',
    'Ann Arbor, Michigan',
    'MI',
    '#e3ad22'
  )
on conflict (id) do update
set
  name = excluded.name,
  short_name = excluded.short_name,
  location = excluded.location,
  initials = excluded.initials,
  color = excluded.color,
  updated_at = now();

insert into public.academic_calendars (
  school_id,
  academic_year,
  version,
  status,
  source_type,
  extraction_model,
  published_at
)
values
  ('uiuc', '2026-27', 1, 'published', 'manual', 'development-seed', now()),
  ('berkeley', '2026-27', 1, 'published', 'manual', 'development-seed', now()),
  ('nyu', '2026-27', 1, 'published', 'manual', 'development-seed', now()),
  ('purdue', '2026-27', 1, 'published', 'manual', 'development-seed', now())
on conflict do nothing;

with seed_events (school_id, name, kind, start_date, end_date) as (
  values
    ('uiuc', 'Thanksgiving break', 'break', '2026-11-21'::date, '2026-11-29'::date),
    ('uiuc', 'Winter break', 'break', '2026-12-19'::date, '2027-01-17'::date),
    ('uiuc', 'Spring break', 'break', '2027-03-13'::date, '2027-03-21'::date),
    ('uiuc', 'Summer break', 'break', '2027-05-15'::date, '2027-08-22'::date),
    ('berkeley', 'Thanksgiving break', 'break', '2026-11-25'::date, '2026-11-29'::date),
    ('berkeley', 'Winter break', 'break', '2026-12-19'::date, '2027-01-11'::date),
    ('berkeley', 'Spring recess', 'break', '2027-03-22'::date, '2027-03-26'::date),
    ('berkeley', 'Summer break', 'break', '2027-05-15'::date, '2027-08-17'::date),
    ('nyu', 'Thanksgiving recess', 'break', '2026-11-26'::date, '2026-11-29'::date),
    ('nyu', 'Winter recess', 'break', '2026-12-23'::date, '2027-01-24'::date),
    ('nyu', 'Spring break', 'break', '2027-03-15'::date, '2027-03-21'::date),
    ('nyu', 'Summer break', 'break', '2027-05-15'::date, '2027-09-01'::date),
    ('purdue', 'Thanksgiving vacation', 'break', '2026-11-25'::date, '2026-11-29'::date),
    ('purdue', 'Winter recess', 'break', '2026-12-20'::date, '2027-01-10'::date),
    ('purdue', 'Spring vacation', 'break', '2027-03-13'::date, '2027-03-21'::date),
    ('purdue', 'Summer break', 'break', '2027-05-09'::date, '2027-08-22'::date)
)
insert into public.calendar_events (
  calendar_id,
  name,
  kind,
  start_date,
  end_date
)
select
  calendar.id,
  seed_event.name,
  seed_event.kind::public.calendar_event_kind,
  seed_event.start_date,
  seed_event.end_date
from seed_events as seed_event
join public.academic_calendars as calendar
  on calendar.school_id = seed_event.school_id
  and calendar.academic_year = '2026-27'
  and calendar.version = 1
  and calendar.status = 'published'
  and calendar.source_type = 'manual'
  and calendar.extraction_model = 'development-seed'
on conflict (calendar_id, name, start_date, end_date) do nothing;

commit;
