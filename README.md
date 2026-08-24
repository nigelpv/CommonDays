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

## Checks

```bash
npm run check
npm test
npm run build
```

The current data is representative development data. Supabase persistence, authentication, and Gemini extraction will be connected in later implementation slices.
