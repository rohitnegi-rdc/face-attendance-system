#!/usr/bin/env bash
# One-command deploy from your machine (Git Bash on Windows works). You must be on the
# server's network. Usage: npm run deploy
#
#   1. Runs checks locally. If anything fails it stops and the server is never touched.
#   2. Ships the committed code (git HEAD) to the server over ONE ssh connection, so a
#      password login asks for the password only once.
#   3. scripts/deploy-remote.sh then runs on the server: backs up the DB + photos, rebuilds,
#      health-checks, and rolls back to the previous version if the new one is unhealthy.
#
# Settings live in deploy.env (gitignored, never commit it):
#   DEPLOY_HOST=developer@RDC-AI-UBUNTU     # or developer@<server-ip>
#   DEPLOY_CHECKS="npm run test:regression" # optional, commands that must pass first
#   DEPLOY_BRANCH=main                      # optional, the only branch allowed to deploy
set -euo pipefail
cd "$(dirname "$0")/.."

# Deploys are switched off until the app is stabilised (see
# plans/ProductionReadinessAudit-2026-10-08.md). Turn them on deliberately, in a commit of its
# own, by setting this to true.
DEPLOY_ENABLED=false
if [[ "$DEPLOY_ENABLED" != true ]]; then
	echo 'Deploy is disabled (DEPLOY_ENABLED=false in scripts/deploy.sh). Nothing was done.' >&2
	exit 1
fi

if [[ -f deploy.env ]]; then
	# shellcheck disable=SC1091
	source deploy.env
fi
DEPLOY_HOST="${DEPLOY_HOST:?Create deploy.env with DEPLOY_HOST=developer@RDC-AI-UBUNTU}"
# The regression gate (scripts/run-regression.mjs) type-checks, builds and runs every scenario
# against a throwaway database. It needs Docker running locally. Logs: test-output/regression/.
DEPLOY_CHECKS="${DEPLOY_CHECKS:-npm run test:regression}"

if [[ -n "$(git status --porcelain)" ]]; then
	echo 'You have uncommitted changes. Only committed code is deployed, so commit or stash first.' >&2
	exit 1
fi

# Only deploy main, and only when it is exactly what is on GitHub (pushed, nothing extra).
deploy_branch="${DEPLOY_BRANCH:-main}"
current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$deploy_branch" ]]; then
	echo "You are on '$current_branch'. Deploys only run from '$deploy_branch'." >&2
	exit 1
fi
echo "==> Checking local $deploy_branch matches origin/$deploy_branch"
git fetch --quiet origin "$deploy_branch"
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$deploy_branch")" ]]; then
	echo "Local $deploy_branch and origin/$deploy_branch differ. Push or pull until they match, then deploy." >&2
	git status -sb | head -n1 >&2
	exit 1
fi
release="$(git rev-parse --short HEAD)"
echo "==> Deploying $release ($(git log -1 --format=%s)) to $DEPLOY_HOST"

echo "==> Local checks: $DEPLOY_CHECKS"
if ! eval "$DEPLOY_CHECKS"; then
	echo 'Checks failed. Nothing was deployed, the server still runs the previous version.' >&2
	echo 'See the summary above and the full logs in test-output/regression/ (newest folder).' >&2
	exit 1
fi

# core.autocrlf=false keeps LF line endings in the archive, otherwise Windows would ship
# CRLF files and the shell scripts would break on Linux.
echo '==> Uploading code and deploying on the server (enter the server password if asked)'
git -c core.autocrlf=false archive --format=tar HEAD |
	ssh "$DEPLOY_HOST" "set -e
		staging=\$HOME/projects/.deploy-staging
		rm -rf \"\$staging\" && mkdir -p \"\$staging\"
		tar -x -C \"\$staging\"
		bash \"\$staging/scripts/deploy-remote.sh\" \"\$staging\" '$release'"
