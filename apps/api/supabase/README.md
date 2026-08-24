# Supabase bootstrap

This bootstrap configures the Supabase-owned parts of Common Days that do not
belong in the Drizzle schema:

- a locked-down `private` schema;
- a singleton record identifying the one Common Days administrator;
- links from calendar submitters and report reviewers to Supabase Auth users;
- the private `calendar-sources` Storage bucket.

It deliberately creates no `anon` or `authenticated` policies on
`storage.objects`. Calendar source files must be uploaded and read by the Hono
backend using a server-only Supabase secret key. Never put that key in a
`VITE_` environment variable or send it to the browser.

## Apply the bootstrap

1. Apply the normal Drizzle migrations first so the Common Days public tables
   exist.
2. In the Supabase dashboard, open **SQL Editor** and create a new query.
3. Paste the complete contents of [`bootstrap.sql`](./bootstrap.sql) and run it.

The script is safe to run again. It preserves the current administrator,
guards the Auth foreign keys against duplicate creation, and updates the
existing Storage bucket configuration.

## Assign the administrator

Create or invite your account under **Authentication > Users**, copy its user
UUID, and run the following separately in the SQL Editor after replacing the
placeholder:

```sql
insert into private.app_admin (singleton, user_id)
values (1, '<ADMIN_AUTH_USER_UUID>'::uuid)
on conflict (singleton)
do update set user_id = excluded.user_id;
```

Because `singleton` can only equal `1` and is the primary key, the database can
hold only one administrator. Running the statement with a different UUID
transfers administrator access rather than creating a second admin.

After creating the account, disable public sign-ups in Supabase Auth. The
frontend may contain only the Supabase URL and publishable key; database URLs,
the Supabase secret key, and AI credentials remain backend-only.
