begin;

-- This seed maintains only the reusable school directory. Academic calendars
-- and events must come from the reviewed ingestion flow, never from fixtures.
insert into public.schools as existing_school (
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
  updated_at = now()
where (
  existing_school.name,
  existing_school.short_name,
  existing_school.location,
  existing_school.initials,
  existing_school.color
) is distinct from (
  excluded.name,
  excluded.short_name,
  excluded.location,
  excluded.initials,
  excluded.color
);

commit;
