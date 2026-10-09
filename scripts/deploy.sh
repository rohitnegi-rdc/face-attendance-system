#!/usr/bin/env bash
# Deploy from GitHub. Run it ON the server, inside the git clone:
#   cd ~/projects/face-attendance-system && bash scripts/deploy.sh
#
#   1. Refuses if the server copy is not on main or has local edits.
#   2. Fetches GitHub and fast-forwards to origin/main (refuses if they diverged), so the server
#      always runs exactly what is on GitHub.
#   3. Backs up the database and photos (when a version is already running).
#   4. Rebuilds and starts the containers. Migrations run automatically.
#   5. Health-checks. On failure it puts the previous commit and images back.
#
# The server does not run tests. Run `npm run test:regression` on your machine before pushing.
# Rollback restores code and containers, not the database: migrations must stay additive, or
# restore the backup printed in step 3.
#
# Options (env): DEPLOY_BRANCH (default main), HEALTH_TIMEOUT seconds (default 180),
# REBUILD=1 to rebuild even when nothing new was pulled.
set -euo pipefail

# Everything runs from inside main(), so bash has read the whole script before git replaces
# this file during the pull.
main() {
	cd "$(dirname "$0")/.."
	local branch="${DEPLOY_BRANCH:-main}"
	local health_timeout="${HEALTH_TIMEOUT:-180}"

	log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

	if [[ ! -f .env ]]; then
		log 'Missing .env. Create it once (copy .env.example and fill in the secrets), then deploy again.'
		exit 1
	fi
	if [[ "$(git branch --show-current)" != "$branch" ]]; then
		log "The server copy is on '$(git branch --show-current)'. Run: git checkout $branch"
		exit 1
	fi
	if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
		log 'The server copy has local edits. Deploys only run what is on GitHub. Discard them first:'
		git status --short --untracked-files=no
		exit 1
	fi

	log "Fetching origin/$branch"
	git fetch --quiet origin "$branch"
	local previous target
	previous="$(git rev-parse HEAD)"
	target="$(git rev-parse "origin/$branch")"
	if ! git merge-base --is-ancestor "$previous" "$target"; then
		log "The server copy and origin/$branch have diverged. Nothing was changed."
		exit 1
	fi

	env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | tr -d "'\"" || true; }
	local app_port base_path app_image ai_image
	app_port="$(env_value APP_HOST_PORT)"
	app_port="${app_port:-6100}"
	base_path="$(env_value BASE_PATH)" # e.g. /pump-attendance, empty when served at the root
	app_image="$(env_value APP_IMAGE)"
	app_image="${app_image:-face-attendance/app:local}"
	ai_image="$(basename "$PWD")-ai-service"

	local has_previous=false
	if [[ -n "$(docker compose ps --status running -q app 2>/dev/null || true)" ]]; then
		has_previous=true
	fi
	if [[ "$previous" == "$target" ]] && $has_previous && [[ "${REBUILD:-}" != 1 ]]; then
		log "Already running $(git rev-parse --short HEAD), nothing new on GitHub. REBUILD=1 forces a rebuild."
		exit 0
	fi
	log "Deploying $(git log -1 --format='%h %s' "$target")"

	if $has_previous; then
		log 'Backing up database and photos'
		BACKUP_DIR="$PWD/backups" bash scripts/backup-production.sh
		log 'Saving current images for rollback'
		docker tag "$app_image" "${app_image%:*}:previous"
		docker tag "$ai_image:latest" "$ai_image:previous" 2>/dev/null || true
	else
		log 'No running version found, first deploy: skipping backup'
	fi

	rollback() {
		trap - ERR
		log "DEPLOY FAILED for $(git rev-parse --short "$target")"
		if ! $has_previous; then
			log 'No previous version to roll back to. Fix the error, push, and deploy again.'
			exit 1
		fi
		log "Rolling back to $(git rev-parse --short "$previous")"
		git reset --quiet --hard "$previous"
		docker tag "${app_image%:*}:previous" "$app_image"
		docker tag "$ai_image:previous" "$ai_image:latest" 2>/dev/null || true
		docker compose up -d --no-build --remove-orphans
		log 'Rolled back. The previous version is running again. Run git pull later to catch up.'
		exit 1
	}
	trap rollback ERR

	git merge --quiet --ff-only "$target"
	log 'Building and starting containers (migrations run automatically)'
	docker compose up -d --build --remove-orphans

	log "Health check (up to ${health_timeout}s)"
	local deadline=$((SECONDS + health_timeout))
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
	docker image prune -f >/dev/null || true
	log "SUCCESS: $(git rev-parse --short HEAD) is live on port $app_port"
}

main "$@"
exit
