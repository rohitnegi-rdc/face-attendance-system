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

## Migration recovery

Each migration and its `schema_migrations` record run in one database transaction. Before a
release, keep the previous application image and create a protected custom-format database backup:

```sh
docker compose exec -T postgres pg_dump -U attendance -Fc attendance > attendance-pre-migration.dump
```

Verify restore procedures in a separate environment. There is no automatic down-migration; roll
back application code only when it remains compatible with the migrated schema, otherwise restore
the backup or deploy a forward-fix migration.
