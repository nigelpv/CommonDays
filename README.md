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

The web app runs at `http://localhost:5173` and proxies API requests to `http://localhost:8787`.

If no database URL is configured, the API automatically uses the development calendars already in the repository. The current UI therefore works immediately after `npm install`.

## Supabase persistence

The API now has a Drizzle schema and repository for schools, reusable academic-year calendars, extracted events, uploaded source files, and correction reports. Database credentials are optional during development and are never sent to the browser.

1. Create a free Supabase project and copy its Postgres connection string.
2. Create your local API environment file:

   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

3. Put the connection string in `apps/api/.env`. URL-encode special characters in the database password.
4. Apply the committed migration and optionally load the four development calendars:

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

The API uses the Supabase-safe `prepare: false` Postgres client setting. If you use a separate direct or session-pooler URL for migrations, place it in `DATABASE_MIGRATION_URL`; runtime requests continue to use `DATABASE_URL`. Row Level Security is enabled on every application table with no public browser policies, so data access stays behind the Hono API until authentication policies are deliberately added.

When the data model changes:

```bash
npm run db:generate
npm run db:migrate
```

Review and commit generated SQL from `apps/api/drizzle/`. The seed command only inserts missing development rows and does not delete or overwrite existing calendars.

## Checks

```bash
npm run check
npm test
npm run build
```

Without `DATABASE_URL`, the current data remains representative development data. Supabase Storage, authentication, and Gemini extraction will be connected in later implementation slices.
