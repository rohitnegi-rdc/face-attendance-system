# Face-Recognition Attendance Management System

Full prototype built from `plans/MasterPlan.md`. See `plans/ImplementationSummary.md` for what
was built and any deviations from the plan.

## Stack

- Frontend + Backend: SvelteKit (Node adapter)
- AI microservice: Python FastAPI + insightface (buffalo_l) on ONNX Runtime CPU
- Background worker: plain Node script polling a Postgres-backed job queue (no Redis)
- Database: PostgreSQL 16 + pgvector
- Orchestration: Docker Compose

## Running locally with Docker Compose

Copy `.env.example` to `.env`, then set independent URL-safe secrets for `POSTGRES_PASSWORD`
and `JWT_SECRET` (for example, generate each with `openssl rand -hex 32`). Compose fails closed
when either secret is empty. Keep `.env` and `creds.md` local; neither belongs in Git or a Docker
image.

```sh
docker compose up --build
```

This starts PostgreSQL (schema in `db/init.sql`), the AI service, the SvelteKit app, and worker.
The app is available at `http://localhost:6100`; PostgreSQL is published only on
`127.0.0.1:6101`. The AI service port is not published to the host. For trusted-LAN
device testing only, set `APP_BIND_ADDRESS=0.0.0.0` in `.env` and restrict access with the host
firewall; restore `127.0.0.1` afterward.

For production, do not use the development override. Keep `APP_BIND_ADDRESS=127.0.0.1`, place
the app behind an HTTPS reverse proxy, and provide secrets through the deployment secret manager.
Database and AI ports remain private to the Compose network. Before applying migrations, take a
database backup and verify it can be restored; the migration runner records applied migrations
but does not provide automatic rollback. The production release process should retain the prior
image and backup until post-deploy health checks pass.

Before a migration, create a custom-format backup from the running database:

```sh
docker compose exec -T postgres pg_dump -U attendance -Fc attendance > attendance-pre-migration.dump
```

Protect the backup as sensitive data and test restores in a separate environment before relying
on it for recovery.

## Seeding the database

The seed script creates one admin account and imports `tests/fixtures/sample-vendor-pump-data.csv`
through the same CSV-import code path the admin UI uses:

```sh
npm install
DATABASE_URL=postgres://attendance:<POSTGRES_PASSWORD>@localhost:6101/attendance npm run seed
```

Replace `<POSTGRES_PASSWORD>` with the URL-safe value in your local `.env`.

- Admin login: `admin@attendance.local` / `Admin1234!`
- Pump logins: `<slugified pump_code>@pumps.local` / `Test1234!` (e.g. `bglprvn1@pumps.local`)
- Vendor logins: `<slugified vendor name>@vendors.local` / `Test1234!`

No persons are pre-seeded — they are only ever created by the real face-detection pipeline.

## Running the CSV import manually

Log in as admin at `/admin/import` and upload a CSV with columns
`Sr.No, Area Name, Plant Name, PUMP Name, Vendor Name`. Re-uploading the same file is idempotent
(upserts on `pump_code`).

## Validating the pipeline end-to-end with real photos

```sh
DATABASE_URL=postgres://attendance:attendance@localhost:5432/attendance \
APP_URL=http://localhost:3000 \
npx tsx scripts/submit-test-photos.ts
```

Logs in as the seeded pump `bglprvn1@pumps.local`, submits `Test/faces/group_morning.jpg`,
backdates that session by 10 hours (test-only, to satisfy the 9-hour rule immediately), then
submits `Test/faces/group_evening.jpg`, and prints the resulting `daily_person_attendance` rows.

## Config (.env)

See `.env.example`. Key values: `FACE_MATCH_THRESHOLD` (default 0.30),
`EVENING_PAIRING_WINDOW_HOURS` (default 24), `DATABASE_URL`, `JWT_SECRET`, `AI_SERVICE_URL`.
`JWT_SECRET` must be at least 32 characters. Pump photo uploads are limited to 18 MiB and JPEG,
PNG, or WebP; the AI service also rejects images above 20 megapixels.

### Google Workspace sign-in

Create a Google OAuth client with application type **Web application**, then register the exact
callback URL used by the app, such as `https://<your-host>/api/auth/google/callback`. Set
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` in the
runtime environment (never commit the secret), then recreate the app container. The callback
accepts only verified `@rdc.in` identities with Google's matching hosted-domain claim and an
existing application account; it does not create accounts or grant roles. Use an HTTPS callback
outside localhost.
