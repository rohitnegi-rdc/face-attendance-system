# Face-Recognition Attendance Management System

Full prototype built from `plans/MasterPlan.md`. See `plans/ImplementationSummary.md` for what
was built and any deviations from the plan.

## Stack

- Frontend + Backend: SvelteKit (Node adapter)
- AI microservice: Python FastAPI + insightface (buffalo_l) on ONNX Runtime CPU
- Background worker: plain Node script polling a Postgres-backed job queue (no Redis)
- Database: PostgreSQL 16 + pgvector
- Orchestration: Docker Compose

## Running with Docker Compose

```sh
docker compose up --build
```

This starts `postgres` (with the schema in `db/init.sql` auto-applied), `ai-service`, `app`
(SvelteKit on :3000), and `worker`.

## Seeding the database

The seed script creates one admin account and imports `tests/fixtures/sample-vendor-pump-data.csv`
through the same CSV-import code path the admin UI uses:

```sh
npm install
DATABASE_URL=postgres://attendance:attendance@localhost:5432/attendance npm run seed
```

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

See `.env.example`. Key values: `FACE_MATCH_THRESHOLD` (default 0.68),
`EVENING_PAIRING_WINDOW_HOURS` (default 24), `DATABASE_URL`, `JWT_SECRET`, `AI_SERVICE_URL`.
