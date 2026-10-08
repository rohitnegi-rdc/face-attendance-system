#!/usr/bin/env bash
# Runs ON the server, called by scripts/deploy.sh. Do not run by hand unless you know why.
# Args: <staging dir with the new code> <release id>
#
# Flow: backup -> snapshot current code + images -> sync new code -> build + start ->
# health check. Any failure after the snapshot rolls back to the previous code and images.
# Note: rollback restores containers, not the database. If a migration already ran, restore
# the DB from the backup printed below (see scripts/restore-drill.sh), or keep migrations
# additive so the previous version still works with the new schema.
set -euo pipefail

staging="$1"
release="$2"
app_dir="$HOME/projects/face-attendance-system"
prev_dir="$HOME/projects/.face-attendance-previous"
health_timeout="${HEALTH_TIMEOUT:-180}"
# Files on the server that are not in git and must survive a deploy.
sync_excludes=(--exclude .env --exclude /backups/ --exclude /uploads/ --exclude .deployed-release)

log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

mkdir -p "$app_dir"
if [[ ! -f "$app_dir/.env" ]]; then
	log "Missing $app_dir/.env. Create it once (copy .env.example and fill in the secrets), then deploy again."
	exit 1
fi
cd "$app_dir"

env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | tr -d "'\"" || true; }
app_port="$(env_value APP_HOST_PORT)"
app_port="${app_port:-3001}"
base_path="$(env_value BASE_PATH)" # e.g. /pump-attendance, empty when served at the root
app_image="$(env_value APP_IMAGE)"
app_image="${app_image:-face-attendance/app:local}"
ai_image="$(basename "$app_dir")-ai-service"

has_previous=false
if [[ -n "$(docker compose ps --status running -q app 2>/dev/null || true)" ]]; then
	has_previous=true
fi

# 1. Backup (only possible when a version is already running).
if $has_previous; then
	log 'Backing up database and photos'
	BACKUP_DIR="$app_dir/backups" bash "$staging/scripts/backup-production.sh"
else
	log 'No running version found, first deploy: skipping backup'
fi

# 2. Snapshot the running version so it can be restored.
if $has_previous; then
	log 'Saving current version for rollback'
	rsync -a --delete "${sync_excludes[@]}" "$app_dir/" "$prev_dir/"
	docker tag "$app_image" "${app_image%:*}:previous"
	docker tag "$ai_image:latest" "$ai_image:previous" 2>/dev/null || true
fi

rollback() {
	log "DEPLOY FAILED for $release"
	if ! $has_previous; then
		log 'No previous version to roll back to. Fix the error and deploy again.'
		exit 1
	fi
	log 'Rolling back to the previous version'
	rsync -a --delete "${sync_excludes[@]}" "$prev_dir/" "$app_dir/"
	docker tag "${app_image%:*}:previous" "$app_image"
	docker tag "$ai_image:previous" "$ai_image:latest" 2>/dev/null || true
	docker compose up -d --no-build --remove-orphans
	log "Rolled back. Previous version ($(cat .deployed-release 2>/dev/null || echo unknown)) is running again."
	exit 1
}
trap rollback ERR

# 3. Swap in the new code and rebuild.
log "Installing release $release"
rsync -a --delete "${sync_excludes[@]}" "$staging/" "$app_dir/"
log 'Building and starting containers (migrations run automatically)'
docker compose up -d --build --remove-orphans

# 4. Health check: app answers /api/health and the worker is running.
log "Health check (up to ${health_timeout}s)"
deadline=$((SECONDS + health_timeout))
until curl -fsS "http://127.0.0.1:$app_port$base_path/api/health" >/dev/null 2>&1 &&
	[[ -n "$(docker compose ps --status running -q worker)" ]]; do
	if ((SECONDS >= deadline)); then
		log 'Health check timed out'
		docker compose ps
		docker compose logs --tail 40 app worker || true
		false # triggers rollback
	fi
	sleep 3
done

trap - ERR
echo "$release" > .deployed-release
docker image prune -f >/dev/null || true
rm -rf "$staging"
log "SUCCESS: release $release is live on port $app_port"
