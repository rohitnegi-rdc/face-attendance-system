# Production Operations

## Secrets and startup

Set independent, URL-safe values for `POSTGRES_PASSWORD` and `JWT_SECRET` using the deployment
secret manager. Generate values with `openssl rand -hex 32`. Compose rejects empty values, and
the application rejects JWT secrets shorter than 32 characters. Do not put real values in Git,
`creds.md`, or a Docker build context.

## Local development

Copy `.env.example` to `.env`, fill in both secrets, then run:

```sh
docker compose up --build
```

The application listens on `http://localhost:6100`; PostgreSQL is bound to `127.0.0.1:6101`.
The AI service and database are not otherwise published. For temporary trusted-LAN testing only,
set `APP_BIND_ADDRESS=0.0.0.0` and restrict inbound access with the host firewall.

## Production deployment

Do not use the development override. Keep the application bound to loopback behind an HTTPS
reverse proxy, supply all secrets from the deployment secret manager, and do not publish database
or AI-service ports. Configure OAuth callback URLs for the actual production hostname separately.
Wait for the AI service health check before routing work to it.

## Release, backup, migration, and rollback

Build the release images, then take a protected database-and-uploads backup before running
migrations. Backups briefly stop the app and worker to keep attendance rows and evidence photos
consistent; the script restarts services automatically, including on failure. Store backups outside
the repository on encrypted, access-controlled storage and test retention/rotation separately. The
Compose `migrate` service applies numbered SQL files in order, records each file in
`schema_migrations`, and is a dependency of both the app and worker. Startup is held until the
migration job succeeds. It is safe to run again: applied files are skipped.

```sh
BACKUP_DIR=/secure/attendance-backups bash scripts/backup-production.sh
```

The script creates a timestamped directory containing `database.dump`, `uploads.tar.gz`, and
`SHA256SUMS`. Run a complete isolated restore drill before the first release and periodically after
that:

```sh
bash scripts/restore-drill.sh /secure/attendance-backups/<timestamp>
```

The drill verifies checksums, restores PostgreSQL into a throwaway isolated container, extracts
photos into a temporary named volume, and reports pump/session/file counts. It removes only its
uniquely named container and volume on exit. Record the drill date and result.

Deploy with `docker compose up -d --build`. Confirm all services are healthy, `GET /api/health`
returns HTTP 200 with `status: ok`, `database: ok`, and `ai_service: ok`, the migration service
exited successfully, and the worker logs show it polling/processing jobs. The health endpoint checks
both dependencies with a bounded AI-service timeout. Also smoke-test login and a non-destructive
admin/pump page.

## Google OAuth

Google sign-in is optional until configured. Set `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` in the deployment environment. The
redirect URI must exactly match the Google OAuth client and use the public HTTPS hostname, for
example `https://attendance.example.com/api/auth/google/callback`. The app only accepts verified
`@rdc.in` Workspace identities that already have an application account; it does not provision
accounts on OAuth login.

Use a unique `APP_IMAGE` tag per release and retain the previous tag. If the new app fails, set
`APP_IMAGE` back to that tag and run `docker compose up -d --no-build app worker`, but only if the
previous code is compatible with the now-migrated (additive) schema. There are no automatic
down-migrations. For incompatible schema changes, use a tested forward fix; restoring the database
backup is a last resort because it discards writes made after the backup. Document the release
identifier, backup location, health-check outcome, and rollback decision for each release.
