#!/usr/bin/env bash
# Deploy the current branch to pymthouse Preview; alias staging.pymthouse.com on the
# configured staging branch (default: feat/openmeter-hosted).
#
# Environment variables are read from the pymthouse Vercel project dashboard.
# Run scripts/apply-pymthouse-preview-vercel-env.sh once to sync Preview secrets/URLs.
#
# Prerequisites: vercel CLI logged in (`vercel login`) or VERCEL_TOKEN set.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAGING_DOMAIN="${VERCEL_PREVIEW_ALIAS_DOMAIN:-staging.pymthouse.com}"
STAGING_ALIAS_BRANCH="${VERCEL_PREVIEW_ALIAS_BRANCH:-feat/openmeter-hosted}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

export NEXTAUTH_URL="${VERCEL_PREVIEW_URL:-https://staging.pymthouse.com}"

vercel link --project pymthouse --yes >/dev/null
deployment_url="$(vercel deploy --yes)"
echo "Deployed branch $BRANCH"
echo "  deployment: $deployment_url"

if [[ "$BRANCH" != "$STAGING_ALIAS_BRANCH" ]]; then
  echo "Skipping staging alias: branch $BRANCH != $STAGING_ALIAS_BRANCH"
  exit 0
fi

vercel alias set "$deployment_url" "$STAGING_DOMAIN" --scope ecs-vercel
echo "  staging:    https://$STAGING_DOMAIN"
