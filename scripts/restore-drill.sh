#!/usr/bin/env bash
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1

if [[ $# -ne 1 || ! -d "$1" ]]; then
	printf 'Usage: %s <backup-directory>\n' "$0" >&2
	exit 2
fi

backup_dir="$(cd "$1" && pwd)"
if command -v cygpath >/dev/null 2>&1; then
	backup_host="$(cygpath -m "$backup_dir")"
else
	backup_host="$backup_dir"
fi
drill_id="attendance-restore-drill-$$"
uploads_volume="attendance-restore-uploads-$$"
password="$(openssl rand -hex 24)"
cleanup() {
	docker rm -f "$drill_id" >/dev/null 2>&1 || true
	docker volume rm "$uploads_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

(cd "$backup_dir" && sha256sum --check SHA256SUMS)
docker volume create "$uploads_volume" >/dev/null
docker run -d --name "$drill_id" \
	-e POSTGRES_USER=attendance \
	-e POSTGRES_PASSWORD="$password" \
	-e POSTGRES_DB=restore_drill \
	-v "$uploads_volume:/restore_uploads" \
	--network none pgvector/pgvector:pg16 >/dev/null

ready=0
for _ in $(seq 1 60); do
	if docker exec "$drill_id" pg_isready -U attendance -d restore_drill >/dev/null 2>&1; then
		ready=1
		break
	fi
	sleep 1
done
if [[ "$ready" -ne 1 ]]; then
	printf '%s\n' 'Isolated restore database did not become ready.' >&2
	exit 1
fi

docker cp "$backup_host/database.dump" "$drill_id:/tmp/database.dump"
docker cp "$backup_host/uploads.tar.gz" "$drill_id:/tmp/uploads.tar.gz"
docker exec "$drill_id" pg_restore --exit-on-error --no-owner \
	--dbname=restore_drill --username=attendance /tmp/database.dump
docker exec "$drill_id" tar -xzf /tmp/uploads.tar.gz -C /restore_uploads

docker exec "$drill_id" psql -v ON_ERROR_STOP=1 -U attendance -d restore_drill \
	-c 'SELECT count(*) AS pumps FROM pumps; SELECT count(*) AS attendance_sessions FROM attendance_sessions;'
upload_files="$(docker exec "$drill_id" sh -c 'find /restore_uploads -type f | wc -l')"
printf 'Restored upload files: %s\n' "$upload_files"
printf '%s\n' 'Restore drill passed; isolated database and upload volume will be removed.'
