# Common Days

Common Days compares college academic calendars and shows the exact dates a group of friends is free at the same time.

## Repository branches

- `main` — production application
- `prototype` — the completed proof-of-concept UI and its full history

## Apps

- `apps/web` — Svelte 5 + TypeScript + Vite frontend
- `apps/api` — Node.js + TypeScript + Hono API
- `packages/shared` — shared Zod schemas and TypeScript contracts

## Local development

```bash
npm install
npm run dev
```

The web app runs at `http://localhost:5173` and proxies API requests to `http://localhost:8787`. The API always requires `DATABASE_URL` and fails closed instead of substituting calendars, reports, or review decisions in memory.

## School availability and uploads

The Add School flow checks the shared library for the group's academic year before adding anything:

- Published calendar: it is reused immediately and no upload is requested.
- Missing calendar: the first student can submit multiple PNG, JPG, or WebP screenshots, or one PDF.
- Processing calendar: the UI follows the existing submission instead of creating a duplicate.

The browser and API both validate file type, file size, PDF/image mixing, and screenshot count. The API also prevents concurrent active submissions for the same school and year.

With the database and server-only Supabase Storage variables configured, uploads are stored in the private `calendar-sources` bucket and their metadata is written to PostgreSQL. They remain in processing until the Gemini extraction worker is connected; no example dates are generated or published.

## Private admin review

Students can submit calendar mistake reports from the public comparison. Those reports are stored in Supabase and appear only in the protected review desk at `http://localhost:5173/admin/login`.

- Supabase verifies the passwordless email link and issues the browser session.
- The API verifies that session again, then checks the user's immutable ID against the single administrator in `private.app_admin`.
- The admin can move a new report into review or reject it with decision notes.
- Calendar corrections are not published automatically. The atomic correction-and-resolution action and secure source-file preview are intentionally reserved for the next slice.

For local admin access, copy `apps/web/.env.example` to `apps/web/.env` and add the project's URL and publishable key. The API needs the same publishable key in `apps/api/.env`; the Supabase secret key and database URL remain API-only. After changing an environment file, stop and restart `npm run dev`.

For Vercel, set the project Root Directory to `apps/web`. Its `vercel.json` sends direct `/admin` and `/admin/*` loads to the Vite entry point, which keeps passwordless callback links working. The production API proxy or `VITE_API_BASE_URL` connection still needs to be configured when the Railway URL exists.

## Supabase persistence

The API now has a Drizzle schema and repository for schools, reusable academic-year calendars, extracted events, uploaded source files, and correction reports. Database credentials are required for local development and are never sent to the browser.

1. Create a free Supabase project and copy its Postgres connection string, project URL, and server secret key.
2. Create your local API and browser environment files:

   ```bash
   cp apps/api/.env.example apps/api/.env
   cp apps/web/.env.example apps/web/.env
   ```

3. Fill in the database, Auth, Storage, and exact `CORS_ALLOWED_ORIGINS` values in `apps/api/.env`. Fill in only the public project URL and publishable key in `apps/web/.env`. URL-encode special characters in the database password.
4. Apply the committed migrations:

   ```bash
   npm run db:migrate
   ```

5. Run the idempotent Supabase-only SQL in [`apps/api/supabase/bootstrap.sql`](apps/api/supabase/bootstrap.sql) through the dashboard SQL Editor. It creates the private upload bucket and the single-admin authorization record described in [`apps/api/supabase/README.md`](apps/api/supabase/README.md).
6. Load or refresh the five-school directory:

   ```bash
   npm run db:seed
   ```

The school-directory seed only upserts school names, locations, initials, and colors. It never creates academic calendars or events. The API uses the Supabase-safe `prepare: false` Postgres client setting. If you use a separate direct or session-pooler URL for migrations, place it in `DATABASE_MIGRATION_URL`; runtime requests continue to use `DATABASE_URL`. Row Level Security is enabled on every application table with no public browser policies, so data access stays behind the Hono API until authentication policies are deliberately added.

When the data model changes:

```bash
npm run db:generate
npm run db:migrate
```

Review and commit generated SQL from `apps/api/drizzle/`. The seed command updates school-directory metadata and does not create, delete, or overwrite calendars.

## Checks

```bash
npm run check
npm test
npm run build
```

Durable Supabase Storage and the sole-admin review flow are connected; the Gemini extraction worker, signed source preview, and atomic correction publisher are the next backend slices.
