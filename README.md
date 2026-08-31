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

`npm run build` emits both the shared package and the API before building the browser app. The production API starts with `npm start`, which runs the compiled Node entry point instead of the development-only TypeScript watcher.

For Railway, deploy the repository root, use `npm run build:api` as the build command, `npm start` as the start command, and `/health` as the health check. Enable Railway Serverless so the low-traffic API sleeps, and do not add a payment method if automatic charges must remain impossible. The free plan's monthly credit is a limit, not a promise of uninterrupted uptime; if it is exhausted, the API may pause until the credit resets.

## School availability and uploads

The Add School flow checks the shared library for the group's academic year before adding anything:

- Published calendar: it is reused immediately and no upload is requested.
- Missing calendar: the first student can submit multiple PNG, JPG, or WebP screenshots, or one PDF.
- Processing calendar: the UI follows the existing submission instead of creating a duplicate.

The browser and API both validate file type, file size, PDF/image mixing, and screenshot count. The API also prevents concurrent active submissions for the same school and year.

With the database and server-only Supabase Storage variables configured, uploads are stored in the private `calendar-sources` bucket and their metadata is written to PostgreSQL. A durable Inngest job downloads those private sources, asks `gemini-3.5-flash-lite` for structured dates, and runs deterministic checks for the selected school, year, real date ranges, duplicates, completeness, and source evidence. The extractor records arbitrary school-wide academic activity periods, including semesters, quarters, trimesters, terms, sessions, modules, or blocks, without assuming one calendar structure. It treats classes through final exams as busy, preserves explicitly documented full-day breaks, and derives only the gaps between documented periods. A valid result is published atomically and becomes reusable immediately. Invalid, incomplete, or mixed-population output fails closed and is never shown as a published calendar.

This ingestion path does not wait for administrator approval. The administrator becomes involved only if a student later reports a mistake in a published calendar.

Students are also allowed to add a school even when its name looks similar to one already in the directory. Common Days stores that possible-match alert in PostgreSQL in the same transaction as the new school, then Inngest emails the sole administrator through Resend. Email delivery is best effort and never blocks school creation or calendar upload; queued alerts are recovered automatically after temporary provider or configuration failures.

The public API accepts at most 20 school creations per running API instance per hour. This abuse guard is independent of similarity: within the limit, even an exact-looking duplicate is still created and only triggers the private alert.

### Local AI worker

Add `GEMINI_API_KEY` to `apps/api/.env`. For local development, also set:

```bash
INNGEST_DEV=1
```

Then run the API and web app in one terminal and the free Inngest development server in another:

```bash
npm run dev
npx --ignore-scripts=false inngest-cli@latest dev -u http://localhost:8787/api/inngest
```

Production uses `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` instead. Gemini and Inngest credentials are server-only and must never use the `VITE_` prefix. If either the extractor or durable queue is missing, the upload endpoint returns a configuration error before accepting source files.

The selected Gemini model currently has free input and output on its quota-limited free tier, and Inngest Hobby is free without a credit card. Keep billing disabled if zero cost is a hard requirement. Gemini's free tier may use submitted content to improve Google products, so this flow is limited to public institutional calendars and must not accept personal schedules or private student data.

The primary extraction and email jobs are event-driven. Their fallback recovery sweeps run once daily, rather than every five minutes, so a low-traffic Railway service can enter Serverless sleep and stay within the free monthly credit. Delayed recovery does not delay normal uploads or alerts; it only affects jobs whose original queue event was lost.

### Similar-school email alerts

Resend's free plan can deliver the private possible-duplicate notification. Add `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, and `ALERT_EMAIL_TO` to `apps/api/.env`; all three are server-only and must not use the `VITE_` prefix. During initial testing, `Common Days <onboarding@resend.dev>` can send only to the email address on the Resend account. A real production sender needs a domain verified in Resend. If email is not configured or its free quota is temporarily exhausted, adding the school still succeeds and the durable alert remains queued for a later retry.

## Private admin review

Students can submit calendar mistake reports from the public comparison. Those reports are stored in Supabase and appear only in the protected review desk at `http://localhost:5173/admin/login`. Normal AI extractions never enter this queue.

- Supabase verifies the passwordless email link and issues the browser session.
- The API verifies that session again, then checks the user's immutable ID against the single administrator in `private.app_admin`.
- The admin can open the private source PDF or screenshots, move a new report into review, reject it with decision notes, or publish a verified correction.
- A verified correction creates a new calendar version, keeps the reported version in history, makes the corrected version live, and resolves the report in one database transaction.
- Ordinary AI extractions still publish automatically after server validation. They enter the admin desk only when someone later reports a mistake.

For local admin access, copy `apps/web/.env.example` to `apps/web/.env` and add the project's URL and publishable key. The API needs the same publishable key in `apps/api/.env`; the Supabase secret key and database URL remain API-only. After changing an environment file, stop and restart `npm run dev`.

For Vercel, set the project Root Directory to `apps/web` and keep “Include source files outside of the Root Directory” enabled so the shared workspace package is available. Its `vercel.json` sends direct `/admin` and `/admin/*` loads to the Vite entry point, which keeps passwordless callback links working. Set `VITE_API_BASE_URL` to the Railway service's HTTPS origin and include the exact Vercel origin in the API's `CORS_ALLOWED_ORIGINS` value.

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

Durable Supabase Storage, Gemini extraction, automatic publication, background retries, similar-school alerts, secure sole-admin source review, and atomic calendar corrections are connected.
