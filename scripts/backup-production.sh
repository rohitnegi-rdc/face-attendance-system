#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export MSYS_NO_PATHCONV=1

backup_root="${BACKUP_DIR:-./backups}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${backup_root%/}/$stamp"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

app_id="$(docker compose ps --status running -q app)"
worker_id="$(docker compose ps --status running -q worker)"
if [[ -z "$app_id" || -z "$worker_id" ]]; then
	printf '%s\n' 'App and worker must both be running to take a consistent backup.' >&2
	exit 1
fi

restart_services() {
	rm -f "$db_tmp" "$uploads_tmp"
	if [[ -n "$app_id" ]]; then docker compose start app >/dev/null; fi
	if [[ -n "$worker_id" ]]; then docker compose start worker >/dev/null; fi
}
db_tmp="$backup_dir/database.dump.tmp"
uploads_tmp="$backup_dir/uploads.tar.gz.tmp"
trap restart_services EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s\n' 'Pausing attendance writes for a consistent database and photo snapshot.'
docker compose stop app worker

app_image="$(docker inspect --format '{{.Config.Image}}' "$app_id")"
docker compose exec -T postgres pg_dump -U attendance -Fc attendance > "$db_tmp"
docker run --rm --volumes-from "${app_id}:ro" --entrypoint tar "$app_image" \
	-C /app/uploads -czf - . > "$uploads_tmp"
mv "$db_tmp" "$backup_dir/database.dump"
mv "$uploads_tmp" "$backup_dir/uploads.tar.gz"
(cd "$backup_dir" && sha256sum database.dump uploads.tar.gz > SHA256SUMS)

printf 'Backup complete: %s\n' "$backup_dir"
printf '%s\n' 'App and worker will be restarted automatically.'
