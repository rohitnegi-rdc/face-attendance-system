# Production Operations

## Secrets and startup

Set independent, URL-safe values for `POSTGRES_PASSWORD` and `JWT_SECRET` using the deployment
secret manager. Generate values with `openssl rand -hex 32`. Compose rejects empty values, and
the application rejects JWT secrets shorter than 32 characters. Do not put real values in Git,
`creds.md`, or a Docker build context.

## Local development

Copy `.env.example` to `.env`, fill in both secrets, then run:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yaml up --build
```

The application listens on `http://localhost:3001`; PostgreSQL is bound to `127.0.0.1:5434`.
The AI service and database are not otherwise published. For temporary trusted-LAN testing only,
set `APP_BIND_ADDRESS=0.0.0.0` and restrict inbound access with the host firewall.

## Production deployment

Do not use the development override. Keep the application bound to loopback behind an HTTPS
reverse proxy, supply all secrets from the deployment secret manager, and do not publish database
or AI-service ports. Configure OAuth callback URLs for the actual production hostname separately.
Wait for the AI service health check before routing work to it.

## Release, migration, and rollback

Build the release images, then take a protected custom-format database backup before running
migrations. The Compose `migrate` service applies numbered SQL files in order, records each file in
`schema_migrations`, and is a dependency of both the app and worker. Startup is held until the
migration job succeeds. It is safe to run again: applied files are skipped.

```sh
docker compose exec -T postgres pg_dump -U attendance -Fc attendance > attendance-pre-migration.dump
```

Check that the archive is readable before deployment:

```sh
pg_restore --list attendance-pre-migration.dump > /dev/null
```

Run a restore drill in an isolated PostgreSQL container (never into the live database):

```sh
export DRILL_PASSWORD="$(openssl rand -hex 24)"
docker run -d --name attendance-restore-drill \
  -e POSTGRES_USER=attendance -e POSTGRES_PASSWORD="$DRILL_PASSWORD" \
  -e POSTGRES_DB=restore_drill pgvector/pgvector:pg16
docker cp attendance-pre-migration.dump attendance-restore-drill:/tmp/backup.dump
docker exec attendance-restore-drill pg_restore --no-owner --dbname=restore_drill \
  --username=attendance /tmp/backup.dump
docker exec attendance-restore-drill psql -U attendance -d restore_drill \
  -c "SELECT count(*) FROM pumps; SELECT count(*) FROM attendance_sessions;"
docker rm -f attendance-restore-drill
unset DRILL_PASSWORD
```

Require restore and both queries to succeed; record the drill date and result. Do this before the
first production release and periodically thereafter. Protect and remove the archive according to
your data-retention policy.

Deploy with `docker compose up -d --build`. Confirm all services are healthy, `GET /api/health`
returns HTTP 200 with `status: ok`, the migration service exited successfully, and the worker logs
show it polling/processing jobs. Also smoke-test login and a non-destructive admin/pump page.

Use a unique `APP_IMAGE` tag per release and retain the previous tag. If the new app fails, set
`APP_IMAGE` back to that tag and run `docker compose up -d --no-build app worker`, but only if the
previous code is compatible with the now-migrated (additive) schema. There are no automatic
down-migrations. For incompatible schema changes, use a tested forward fix; restoring the database
backup is a last resort because it discards writes made after the backup. Document the release
identifier, backup location, health-check outcome, and rollback decision for each release.
